# A13 — Research Bot hands a fact reference to Writer in a group

**Scenario:** Research Bot hands a fact reference to Writer in a group.
**Pass condition:** Receiver gets authorized current fact; result linked back; no permission expansion; no duplicate responders to an unaddressed message.

## Evidence (all real, non-mocked, re-confirmed clean in this session's own A17 run)

- **Receiver gets the fact, result linked back:** `services/worker/src/chatRunDriver.test.ts` — "allows a granted typed handoff through the mounted MCP bridge and persists role_messages" — a real MCP tool call through a genuine stdio-mounted workspace server, carrying a real typed `factRef` (tenant/scope/role/key), asserted persisted to a real `role_messages` row via a direct database query, plus a real `policy.decision` audit event recording `verdict: "allow"` for the exact capability. This is the real production call path (mounted MCP bridge), not a simulated handoff function.
- **No permission expansion:** the sibling test in the same file — "denies the ungranted tool at policy.decision before any mailbox write" — revokes the grant, asserts the MCP server is not even mounted for the model (`sdkOptions.mcpServers?.workspace` is `undefined`) and the tool name doesn't appear in `allowedTools` at all, then independently confirms via direct database query that **no new `role_messages` row was written** on the denied attempt (count stays at 1, from the prior test's real handoff, not incremented). This proves denial happens before any mailbox write, not merely that the UI would hide a button.
- **No duplicate responders to an unaddressed message:** `services/control-api/src/chat.routes.test.ts` — "routes an unaddressed three-bot message through FreeLLMAPI and durably queues the selected chat run" — a real group-thread message with no explicit addressee is routed through a genuine FreeLLMAPI decision that selects exactly one bot, and exactly one chat run is durably queued for it — not all three, and not zero.

## Result

**PASS.** All four required properties are proven directly against the real MCP bridge, real audit trail, and real group-routing decision path, with the negative case (denial) independently confirmed via a direct database read rather than assumed from the audit log alone.
