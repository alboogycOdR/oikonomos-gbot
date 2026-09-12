import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../lib/AuthContext";

function redirectTarget(location: Location | null | undefined): string {
  // TASK-108 (Chat-1d): default landing changed from /runs to / (the chat
  // surface, spec §5); `from` still wins whenever `RequireAuth` captured a
  // real deep link (e.g. /ops/runs, /workspace/:threadId) to return to.
  return location !== null && location !== undefined ? `${location.pathname}${location.search}` : "/";
}

export function LoginPage() {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
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
      <form onSubmit={(event) => void handleSubmit(event)}>
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
        {error !== null && <p role="alert">{error}</p>}
      </form>
    </main>
  );
}
