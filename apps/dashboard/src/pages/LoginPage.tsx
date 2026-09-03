import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../lib/AuthContext";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(token);
      const from = (location.state as { from?: Location } | null)?.from;
      // TASK-108 (Chat-1d): default landing changed from /runs to / (the
      // chat surface, spec §5); `from` still wins whenever RequireAuth
      // captured a real deep link (e.g. /ops/runs) to return to.
      navigate(from !== undefined ? `${from.pathname}${from.search}` : "/", {
        replace: true,
      });
    } catch {
      setError("Invalid token.");
    } finally {
      setSubmitting(false);
    }
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
