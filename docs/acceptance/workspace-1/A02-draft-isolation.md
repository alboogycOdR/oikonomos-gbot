# A02 — Draft different text in A/B; switch and simulate failed POST

**Scenario:** Draft different text in A/B; switch and simulate failed POST.
**Pass condition:** Each draft remains with its owner; failed send retains text; successful acknowledgment clears only its draft.

## Method

Real Chromium browser against the real deployed candidate over its actual HTTPS origin, real login, real bots (`TASK245-A01-BotA`/`BotB`, reused from A01). The actual send request (`POST /threads/:id/messages`) was intercepted via Playwright's own route control to synthetically return either a failure or a success — this is the correct level to fake at for this specific case: A02 tests the dashboard's own client-side draft-state logic (which the code shows lives entirely in `ChatPage.tsx`'s reducer, keyed per thread), not whether a real chat run completes downstream. Testing it this way is fully deterministic and needed zero real backend interaction, zero database writes, and zero cost.

## Result, live

- Typed a distinct draft into Bot A, switched to Bot B (composer correctly empty — a fresh, undrafted thread), typed a different draft into Bot B, switched back to Bot A: **Bot A's draft was still exactly as typed**, and switching to Bot B again confirmed **Bot B's own draft was independently preserved too** — proven both directions, not just one.
- Forced a failed send (synthetic `500`) on Bot B: **the draft text remained exactly as typed**, matching the code's own documented behavior (`ChatPage.tsx`'s `handleSend` catch block deliberately does not dispatch the one action that clears a draft, so failure preserves it by simple inaction, not a special-cased restore).
- Forced a successful send (synthetic `201`) on the same draft: **the draft cleared**, proving the success path's `message-sent` dispatch does fire and do its job.
- Re-checked Bot A immediately afterward: **its draft was completely untouched** by any of Bot B's send activity, proving per-thread isolation holds even while another thread is actively sending.

## Result

**PASS.** All three required properties (independent ownership, failure retains, success clears only its own) proven live against the real running dashboard code, with the network layer controlled just enough to make both outcomes deterministically testable without any real spend or backend side effect.
