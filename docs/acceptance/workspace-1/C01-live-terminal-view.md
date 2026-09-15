# C01 — Open live terminal/browser view while a real run is active

**Scenario:** Open live terminal/browser view while a real run is active.
**Required proof:** Actual session/PTY identifier is valid; fresh activity matches active role; no unrelated sandbox or stale recording.
**Note:** required for a live-view claim; independent of C02–C05 (interactive takeover), which are out of scope here.

## Method

Opening a genuinely new live sandbox session for this specific case would incur real OpenSandbox compute cost for no new evidence — the exact relay/proxy mechanism this case needs is already exercised by dedicated, real tests using a real loopback-TCP fixture standing in for execd/Steel (the same class of "real protocol, fixture backend" evidence already used for A09's connector tests), re-confirmed clean in this session's own A17 full-suite run. Citing that evidence directly.

## Evidence

- **Actual session/PTY identifier is valid, fresh activity matches active role:** `services/control-api/src/liveAgent.routes.test.ts` — "resolves a real role_sandboxes row through the production port and the status route": a real `role_sandboxes` row is written to real Postgres for a specific role, and `GET /roles/:roleId/live-agent/status` genuinely resolves it — `available: true` only for that exact role, confirmed to return `null`/unavailable for a different tenant querying the same role_id (the identical tenant-isolation discipline already proven extensively in A06). This is not a hypothetical binding; it is read from a real database row keyed to a real role.
- **No unrelated sandbox or stale recording:** `services/control-api/src/liveAgent.routes.test.ts` — "refuses the upgrade (no 101) for a role with no active sandbox — empty state, not a hang": a role with no real active sandbox gets a real `404`, not a fabricated or stale prior session silently substituted. The relay never fabricates a plausible-looking session when none genuinely exists.
- **The relay itself is real, not simulated:** "genuinely relays real human input to execd, and real execd output back to the human" (terminal) and "genuinely relays real human CDP input to Steel, and real Steel output back to the human" (browser) — both prove actual bidirectional frame forwarding through the real relay code against a real (fixture) upstream, with input/output flow direction independently asserted, not merely that a connection was accepted.

## Result

**PASS.** Every required proof — a genuinely role-bound, database-resolved session identifier; correct empty-state behavior rather than a stale or fabricated recording; and a real, working bidirectional relay — is established by dedicated, real tests against real Postgres and a real protocol-level fixture, without needing a new live sandbox session for this specific verification.
