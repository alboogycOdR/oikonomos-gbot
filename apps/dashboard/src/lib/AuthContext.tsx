import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { login as apiLogin } from "./api";

/**
 * TASK-102 — auth state lives in memory only (never localStorage/
 * sessionStorage: the real credential is control-api's httpOnly session
 * cookie, which this app cannot and must not read). `isAuthenticated`
 * starts `false` on every fresh load; a reload always re-shows the login
 * screen even if the cookie is still valid server-side — the first
 * protected fetch will 401 in that case and the guard below sends the
 * user back to `/login`, so no real access is lost, just the client-side
 * "remember me" convenience. That tradeoff keeps the trust boundary
 * exactly where control-api's own cookie lives, per AGENTS.md N4/N10.
 */
interface AuthContextValue {
  isAuthenticated: boolean;
  login: (token: string) => Promise<void>;
  markUnauthenticated: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const login = useCallback(async (token: string) => {
    await apiLogin(token);
    setIsAuthenticated(true);
  }, []);

  const markUnauthenticated = useCallback(() => {
    setIsAuthenticated(false);
  }, []);

  const value = useMemo(
    () => ({ isAuthenticated, login, markUnauthenticated }),
    [isAuthenticated, login, markUnauthenticated],
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
