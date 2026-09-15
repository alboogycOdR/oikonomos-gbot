# A05 — Reload valid session and open bookmarked tab; then logout

**Scenario:** Reload valid session and open bookmarked tab; then logout.
**Pass condition:** Session restored only after server verification; logout clears private UI state; deep link revalidates ownership.

## Method

Real Chromium browser against the real deployed candidate over its real HTTPS origin, real login, real reload, real deep link, real logout click. A genuine environment quirk was hit and fixed along the way: this app holds a persistent SSE connection open once authenticated, so Playwright's `networkidle` wait never resolves on any authenticated page — switched to `load` plus explicit element waits for anything past the login screen.

## Results, live

- **Session restore is server-verified, not client-cached — PASS.** Confirmed both by live behavior (a page reload correctly stayed authenticated and the bot sidebar loaded) and by direct code read: `AuthContext.tsx`'s `AuthProvider` initializes `isAuthenticated` to `false` on every mount and only flips it to `true` after a real `GET /auth/me` call succeeds — there is no client-side token cache or optimistic assumption anywhere in this path.
- **Deep link while authenticated loads correctly — PASS.** A direct navigation (not client-side routing) to a specific owned thread URL loaded that exact thread while the session was valid.
- **Logout clears private UI state (client-visible behavior) — appears to PASS, but is backed by a real, critical defect underneath.** The visible behavior is correct: clicking "Log out" does redirect to `/login` and the bot list disappears from the DOM. However, this only happens because `AuthContext.logout()`'s `finally` block flips the client's own local `isAuthenticated` flag regardless of what the server actually returned — the UI *looks* right for the wrong reason.
- **Deep link revalidates ownership after logout — FAILS, and this is the real finding.** Re-navigating to the exact same bookmarked URL after "logging out" loaded the full authenticated workspace again, with real data (all of this session's test bots and other real threads), for a full 5+ seconds of observation with no redirect ever occurring.

## Critical finding: logout has never actually worked (TASK-260, critical)

Traced to certainty, not inferred: `services/control-api/src/app.ts`'s `/auth/logout` route is itself correctly written (it calls the real `revokedSessionTokens.revoke(token)` and sets a real expired cookie) — but it **never runs**, because the dashboard's shared `request()` client helper (`apps/dashboard/src/lib/api.ts`) unconditionally sends `content-type: application/json` on every call, including `logout()`'s genuinely bodyless `POST /auth/logout`. Fastify's own body parser rejects a request declaring a JSON content-type with zero bytes of body, returning `400 FST_ERR_CTP_EMPTY_JSON_BODY` before the route handler is ever reached — confirmed word-for-word via a direct `curl` reproduction matching the client's exact request shape.

Direct, no-React-involved verification: using the SAME browser context's cookies immediately after a visible "logout," a raw `GET /auth/me` (bypassing the dashboard's own JS entirely) still returned `200` with the real, still-valid session. The session cookie is genuinely never cleared and never server-side revoked — it simply remains valid for its full 24-hour lifetime regardless of how many times "Log out" is clicked. A user on a shared or public device who believes they have ended their session has not.

The same defect independently breaks three other real features that make bodyless calls through the identical shared helper: `pauseRoutine()`, `resumeRoutine()` (confirmed via the same `curl` reproduction — this also explains and supersedes part of TASK-256's earlier, narrower finding: the pause/resume route genuinely exists and is genuinely reachable by a bare request with no content-type header, but the real dashboard client can never successfully call it, for this reason), and `testRunRoutine()`. Filed as TASK-260, critical priority, with the exact fix and all four affected call sites named.

## Result (as originally tested, candidate `a83b892`)

**FAIL.** Session-restore and authenticated deep-link behavior are both genuinely correct. Logout's visible behavior is correct by accident, not by a working mechanism — the actual session is never terminated server-side, and a deep link after "logout" proves this directly: it lands the visitor right back in the authenticated workspace. This is a real, previously undiscovered, critical security defect (TASK-260), not a UI polish issue.

## Update — fix deployed and re-verified live (candidate `d9c2412`)

TASK-260 landed, was independently verified end-to-end, merged, and deployed live the same session (2026-09-15T10:52Z) given the security severity — see `PLAN.md` orchestrator_notes for the deploy decision. Re-verified directly against the live production origin immediately after deploy, using real curl calls (not the dashboard's own client, to rule out any client-side masking):

- `POST /auth/login` → `200`, real session cookie.
- `POST /auth/logout` (no body, no content-type — the fixed request shape) → **`204`**, with a session-clearing `Set-Cookie`.
- `GET /auth/me` immediately after, same cookie → **`401 {"error":"unauthorized"}`** — genuine server-side revocation confirmed, not merely a client redirect.

**A05 now PASSES in full** against the current candidate (`d9c2412`). No other case's evidence is invalidated by this deploy — none of the other passing cases exercised the specific broken logout code path as part of their own pass condition.
