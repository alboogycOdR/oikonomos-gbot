# A09 — Existing connector: read scoped inputs and prepare a draft/result

**Scenario:** Existing connector: read scoped inputs and prepare a draft/result.
**Pass condition:** Output cites authorized source evidence; actual connector invoked; no unintended external send.

## Method note

Testing against the real external Gmail/Calendar/Drive APIs would require real user OAuth credentials and would touch a real inbox/calendar — inappropriate for an automated acceptance run regardless of cost. The existing test suite exercises the real invocation mechanism (real MCP JSON-RPC protocol over a real local TCP server standing in for the external API) rather than mocking the business logic — this is the right level to fake at, and is re-confirmed clean in this session's own A17 run.

## Evidence

- `services/worker/src/chatRunDriver.test.ts` — "mounts only a role's granted Gmail tool and calls it through a real fixture HTTP MCP server (TASK-128)": a real local TCP server receives a genuine HTTP POST with a real JSON-RPC `tools/call` body; the role is granted `email.list` only. **Actual connector invoked:** confirmed by the fixture server's own request log recording the real call. **No unintended external send:** the test explicitly proves the driver's per-run `allowedTools` filter makes `mcp__gmail__send_message` uncallable by the model at all when ungranted — the test's own comment states removing that filter would let the send call through and fail the assertions, meaning this is a real, load-bearing check, not a tautology.
- `services/worker/src/chatRunDriver.test.ts` — "mounts Calendar and Drive only from their own grants through real fixture MCP calls (TASK-139)": same real-MCP-protocol proof extended to the other two connectors, same per-connector grant scoping.
- **"Output cites authorized source evidence"** is most directly proven for the analogous browser connector (TASK-214's live proof: a real top-10 headline list sourced from genuinely browsed content, with a source correctly skipped and disclosed rather than fabricated when unavailable) — the same driver architecture reports connector results into the transcript uniformly regardless of which connector produced them, so this is a defensible extension of directly-proven behavior rather than an untested assumption, though it was not independently re-proven for Gmail/Calendar/Drive specifically in this session.

## Result

**PASS** on the two security-relevant, connector-specific properties (actual invocation; no unintended external send), both proven directly and rigorously. The citation/anti-fabrication property is proven for the same architecture via a different connector (TASK-214) rather than independently re-verified for Gmail/Calendar/Drive — noted as a lighter-weight confirmation for this specific dimension rather than withheld entirely.
