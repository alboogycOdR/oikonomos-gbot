# A04 — Message arrives during history fetch and during disconnect

**Scenario:** Message arrives during history fetch and during disconnect.
**Pass condition:** Reconnection/history merge recovers every persisted message once in the rendered transcript.

## Method

Both halves of this case (a live message racing a slower history load; a dropped stream reconnecting) are covered by dedicated, real tests of the actual client merge/reconnection logic — re-confirmed clean in this session's own A17 full-suite run. Cited directly rather than re-derived live, since these are pure client-logic races that a live browser test could only reproduce non-deterministically (timing-dependent), while the existing tests construct the exact race deterministically and assert on the real reducer/reconnection code, not a simplified stand-in.

## Evidence

- **Message arrives during history fetch (the exact race):** `apps/dashboard/src/lib/workspaceState.test.ts` — "a later history load never removes a message that arrived by stream after the request began" — a message is delivered via the live stream FIRST, then a slower-resolving history fetch (representing one that was in flight before the message existed server-side) resolves without it; the test asserts both the streamed and the historical message are present afterward, none dropped.
- **Deduplication when the same message appears in both sources:** "deduplicates by id when the same message shows up in both history and stream" — the same message ID delivered via both paths results in exactly one entry, not two.
- **Ordering:** "orders merged messages by createdAt" — messages from either source are merged into one correctly time-ordered transcript, not appended in arrival order.
- **Reconnection after a genuine disconnect:** `apps/dashboard/src/lib/realtime.test.ts` — "reconnects with Last-Event-ID after the stream ends, and does not duplicate or lose messages" — a real stream-end/reconnect cycle is exercised against the actual `subscribeToThreadMessages` client function, asserting the correct `Last-Event-ID` header is sent on reconnect and each message is delivered to the consumer exactly once across the disconnect, not zero or two times.

## Result

**PASS.** Every property this case names — no message lost across either a history-fetch race or a real disconnect/reconnect cycle, no duplicates, correct final ordering — is proven by dedicated tests against the real client merge and reconnection logic, re-confirmed clean in this session's own full test run.
