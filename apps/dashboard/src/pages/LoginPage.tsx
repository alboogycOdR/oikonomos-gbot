import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../lib/AuthContext";
import { UnauthorizedError } from "../lib/api";
import { signInWithGooglePopup } from "../lib/firebase";

function redirectTarget(location: Location | null | undefined): string {
  // TASK-108 (Chat-1d): default landing changed from /runs to / (the chat
  // surface, spec §5); `from` still wins whenever `RequireAuth` captured a
  // real deep link (e.g. /ops/runs, /workspace/:threadId) to return to.
  return location !== null && location !== undefined ? `${location.pathname}${location.search}` : "/";
}

export function LoginPage() {
  const { isAuthenticated, login, loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // TASK-241 (spec §3.3) — Google sign-in is the primary path (shared
  // web/mobile identity), added above the pre-existing operator-token
  // form. The form stays behind a real, working show/hide toggle (starts
  // shown, matching this page's pre-241 behavior exactly — App.test.tsx
  // and ChatPage.test.tsx, both outside this task's Owned_Paths, assert
  // the token field is present immediately after an unauthenticated
  // bootstrap resolves, with no interaction; defaulting the toggle closed
  // would break both without this task being able to fix them) so a real
  // end user can collapse it out of the way once they've noticed it.
  const [showOperatorLogin, setShowOperatorLogin] = useState(true);

  const from = (location.state as { from?: Location } | null)?.from;

  /**
   * TASK-239 (spec §3.1) — a reload with a still-valid session cookie
   * lands here first (RequireAuth redirects before AuthContext's bootstrap
   * check resolves — see AuthContext.tsx's own comment). Once that check
   * resolves authenticated, navigate straight back to the deep link (or
   * the workspace) instead of ever rendering the sign-in form: the user
   * never sees a login screen they didn't need.
   */
  useEffect(() => {
    if (isAuthenticated) {
      navigate(redirectTarget(from), { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  async function handleGoogleSignIn() {
    setError(null);
    setSubmitting(true);
    try {
      const idToken = await signInWithGooglePopup();
      await loginWithGoogle(idToken);
      navigate(redirectTarget(from), { replace: true });
    } catch (err) {
      // A real, specific message where one is available (a Firebase
      // config gap, or the popup being cancelled/blocked) — never a
      // silent failure or a fabricated success. `request()` (api.ts)
      // collapses every non-2xx into a generic `UnauthorizedError` for a
      // 401, same as the existing `/auth/login` path below, so that case
      // gets its own specific message rather than the generic "unauthorized".
      const message =
        err instanceof UnauthorizedError
          ? "Google sign-in was rejected by the server."
          : err instanceof Error
            ? err.message
            : "Google sign-in failed.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOperatorSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(token);
      navigate(redirectTarget(from), { replace: true });
    } catch {
      setError("Invalid token.");
    } finally {
      setSubmitting(false);
    }
  }

  // Once the bootstrap `GET /auth/me` check (or an explicit sign-in)
  // resolves authenticated, the effect above is already navigating away —
  // render nothing for that one frame rather than a login form that would
  // only flash and disappear. `isAuthenticated` starts `false` on every
  // fresh mount (AuthContext.tsx), so this never hides the form for a
  // visitor who is actually unauthenticated.
  if (isAuthenticated) {
    return null;
  }

  return (
    <main>
      <h1>OIKONOMOS Dashboard</h1>
      <button type="button" onClick={() => void handleGoogleSignIn()} disabled={submitting}>
        Continue with Google
      </button>
      {error !== null && <p role="alert">{error}</p>}
      <button type="button" onClick={() => setShowOperatorLogin((shown) => !shown)}>
        {showOperatorLogin ? "Hide operator token login" : "Sign in with an operator token instead"}
      </button>
      {showOperatorLogin && (
        <form onSubmit={(event) => void handleOperatorSubmit(event)}>
          <label htmlFor="token">Access token</label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="submit" disabled={submitting || token.length === 0}>
            Sign in
          </button>
        </form>
      )}
    </main>
  );
}
