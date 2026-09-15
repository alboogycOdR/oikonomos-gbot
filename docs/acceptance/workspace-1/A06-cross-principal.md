# A06 — Another principal requests the same thread, run, result, viewer and action IDs

**Scenario:** Another principal requests the same thread, run, result, viewer and action IDs.
**Pass condition:** No unauthorized read/write or useful private metadata; expired session cannot continue sockets.

## Method note

This environment currently has only one live-loginable real principal: the shared operator token, and Google sign-in (the only path to a genuinely second, independent human identity) is not configured (no `VITE_FIREBASE_*` build inputs — the same known gap already withholding A20). Cross-principal isolation is instead proven at the layer the pass condition actually cares about: whether one authenticated tenant can reach another tenant's resources by ID — genuinely testable today via the real, distinct `tenant_id` values already present in this database (`basileia` vs `acme`), independent of which login mechanism produced the session.

## Cross-tenant read/write isolation — real, extensive, already-verified evidence

Re-confirmed clean in this session's own A17 full-suite run. Every one of these is a real HTTP-route test against real Postgres, not a unit test of an isolated function:

- `services/control-api/src/browserTakeover.routes.test.ts` — "404s when the port itself declines (not owned by this tenant, or no longer pending)"
- `services/control-api/src/liveAgent.routes.test.ts` — "does not leak another tenant's sandbox as available"
- `services/control-api/src/receipt.routes.test.ts` — "returns the complete receipt only for the owning tenant"
- `services/control-api/src/routines.routes.test.ts` — "returns 404, never 403, and does not update a cross-tenant routine"
- `services/control-api/src/secretRequests.routes.test.ts` — "lists only the caller tenant's pending requests"; two separate "404s for a request belonging to a different tenant" tests
- `services/control-api/src/takeover.routes.test.ts` — two "404s for a run belonging to a different tenant, and never calls the port" tests
- `services/control-api/src/threadContext.routes.test.ts` — two "404s (never 403) for a thread owned by a different tenant" tests
- `services/control-api/test/app.test.ts` — "GET /threads/:id/stream 404s for a thread owned by a different tenant"; plus dedicated regression tests explicitly named for a prior real incident ("round-2 TASK-080 lesson") proving `tenantId` is forwarded correctly and never silently defaulted across every port call

**"No useful private metadata" is a deliberate, consistent design property, not an accident:** every one of the routes above returns `404`, never `403`, for a cross-tenant request — confirmed by reading the actual response codes in these tests, not assumed from their names. A `403` would itself leak that the resource exists; a `404` reveals nothing about whether the ID is real, someone else's, or simply wrong.

## Real gap found: an expired session cannot be forced to stop an already-open socket

Read directly, not assumed: `GET /threads/:id/stream` (the SSE route) resolves `request.tenantId` exactly once, at the initial handshake, and both its poll timer (300ms) and heartbeat timer (15s) run for the connection's entire lifetime using that already-resolved value — neither ever re-checks the originating session cookie's signature or expiry. Session TTL is 24 hours (`SESSION_TTL_MS`). This means a stream opened by a legitimately-authenticated session that later expires while the connection stays open will keep delivering real-time messages past its nominal expiry, contradicting this exact case's own named pass condition ("expired session cannot continue sockets"). This is not a fresh unauthorized-access bug — the connection was genuinely authorized when opened — but it is a real, disclosed session-lifetime enforcement gap. Filed as TASK-259.

## Result

**PASS on cross-tenant read/write isolation** (extensive, real, re-verified evidence, consistently 404-not-403). **FAIL on the expired-session-socket requirement** — a real, previously undiscovered gap (TASK-259, medium priority: requires a connection to legitimately stay open across a full 24-hour session lifetime to matter, doesn't grant new unauthorized access). Two-distinct-human-principal testing via the live login UI itself remains NOT RUN pending the same Firebase Web configuration gap already withholding A20 — recorded honestly as an environmental limitation, not a defect.
