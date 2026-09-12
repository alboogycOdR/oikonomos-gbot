import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { getMe, login as apiLogin, loginWithGoogle as apiLoginWithGoogle, logout as apiLogout } from "./api";

/**
 * TASK-102 — auth state lives in memory only (never localStorage/
 * sessionStorage: the real credential is control-api's httpOnly session
 * cookie, which this app cannot and must not read).
 *
 * TASK-239 (spec §3.1) — `isAuthenticated` still starts `false` on every
 * fresh load (unchanged: no client-side "remember me" state), but this
 * provider now calls `GET /auth/me` once on mount and flips it to `true`
 * on a 200 rather than waiting for the first protected fetch to 401. That
 * bootstrap check is deliberately NOT used to gate rendering of
 * `children` here — `RequireAuth`/`App.tsx` (outside this task's
 * Owned_Paths) already redirect an unauthenticated `isAuthenticated`
 * straight to `/login` on the very first render, exactly as before this
 * task; blocking render on the bootstrap promise would only delay that
 * existing, already-tested behavior by one microtask for no benefit.
 * Instead, `isBootstrapping` is exposed so `LoginPage` (this task's
 * territory) can hold off rendering the actual form — and, once the
 * bootstrap resolves authenticated, navigate straight back to the
 * workspace — so a reload with a valid cookie never shows the login
 * screen even though the URL transiently passes through `/login` (spec:
 * "Reloading with a valid cookie lands on the workspace without the
 * login screen").
 */
interface AuthContextValue {
  isAuthenticated: boolean;
  /** True until the initial `GET /auth/me` bootstrap check has settled. */
  isBootstrapping: boolean;
  login: (token: string) => Promise<void>;
  /**
   * TASK-241 (spec §3.3) — exchanges a real Firebase ID token for a
   * session via `POST /auth/google`; same shared-identity contract as
   * `login` above, just a different credential (Google, not the shared
   * operator token).
   */
  loginWithGoogle: (idToken: string) => Promise<void>;
  /** Clears the server-side session (spec §3.2) and marks the client unauthenticated. */
  logout: () => Promise<void>;
  markUnauthenticated: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then(() => {
        if (!cancelled) setIsAuthenticated(true);
      })
      .catch(() => {
        // No valid session (401) or a transient network/server failure —
        // either way the safe default is "not authenticated"; the user
        // can always sign in again from the login screen.
      })
      .finally(() => {
        if (!cancelled) setIsBootstrapping(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (token: string) => {
    await apiLogin(token);
    setIsAuthenticated(true);
  }, []);

  const loginWithGoogle = useCallback(async (idToken: string) => {
    await apiLoginWithGoogle(idToken);
    setIsAuthenticated(true);
  }, []);

  const markUnauthenticated = useCallback(() => {
    setIsAuthenticated(false);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      // Best-effort: even if the network call fails, the client must not
      // stay in a state that claims to be authenticated (spec §3.2's
      // "drops all in-memory workspace state" depends on this flipping).
      setIsAuthenticated(false);
    }
  }, []);

  const value = useMemo(
    () => ({ isAuthenticated, isBootstrapping, login, loginWithGoogle, logout, markUnauthenticated }),
    [isAuthenticated, isBootstrapping, login, loginWithGoogle, logout, markUnauthenticated],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
