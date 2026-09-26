# Mobile app 0.2.0: owner test feedback log

Collected while the owner tests the app (APK 0.2.0, server build `ae7f0aaa`, test guide sent 2026-09-25 21:52 SAST).

**Working agreement (2026-09-26):** items are only RECORDED here as the owner sends them. Nothing is investigated, fixed or turned into a task until the owner says testing is done. Then each item is triaged one by one.

Status values: `logged` (not looked at), `triaged`, `task filed`, `fixed`, `not a bug`.

| # | Logged (SAST) | Test # | Feedback (owner's words) | Status |
|---|---|---|---|---|
| 1 | 2026-09-26 08:54 | (not in guide) | "Chief of Staff unable to act". Screenshot (BossMan chat, phone clock 08:51): asked BossMan to create a bot called FinMan (financial questions, calculations, accounting). BossMan proposed a name, title and description and asked for approval; owner replied "yes, approved". BossMan then said it could not create the bot: the system returned a tier-level restriction error ("tier 3" tool) on `create_bot`, and its permissions do not allow creating new bots. Screenshot file on the owner PC: `C:/Users/User/.claude/uploads/213fb43b-ee91-4efc-9a2c-a0c2f47f5a2f/4955532c-image.jpg` | triaged |


## Triage (2026-09-26, after the owner said testing is done)

### #1 BossMan (Chief of Staff) cannot create a bot
**Verdict:** a real product gap, working as designed at the component level but broken end to end.

**Root cause (verified):**
- BossMan (`a8ce1d50-...`) has no provider set, so it runs on the **Gemini lane** (owner default `OIK_DEFAULT_ROLE_PROVIDER=gemini`).
- Its grant is fine: `workspace.create_bot` is granted up to `T3_external` (live `role_grants`).
- The Gemini adapter refuses any tool above **T2** before the broker is ever called (`packages/harness-factory/src/providers/gemini.ts:243-247`, ceiling `STAGE_TWO_MAXIMUM_TOOL_TIER = 2`, used at `services/worker/src/chatRunDriver.ts:914`). `create_bot` is T3 (`services/worker/src/geminiToolExecutors.ts:987`). This is a deliberate decision recorded in `docs/decisions/ADR-011-multi-provider-llm-support.md` section 8 (2026-09-07): T3/T4 tools need operator approval and were not extended to the cheapest model.
- No `create_bot` audit event exists: the refusal happens before the broker, so no approval card was ever offered.

**Why it looked broken:** the Gemini lane still OFFERS `create_bot` to the model (`geminiToolExecutors.ts:982`) even though it will always refuse it. So the bot planned the action, asked for approval **in chat text** ("yes, approved" is not an approval; real approvals are nonce-bound cards), then hit the ceiling.

**Options:**
1. Quick, config only: set BossMan's provider to `claude`. The Claude lane supports T3 with a real approval card. Costs more per turn (~25x Gemini).
2. Product fix (small): do not offer above-ceiling tools on the Gemini lane, and tell the model and user plainly ("creating bots needs the Claude lane or an approval-capable model"). Stops the misleading chat approval.
3. Design change: let the Gemini lane run T3 tools through the broker's approval flow (approval card, nonce, single use). Needs an ADR-011 amendment and a protected-path change (`packages/harness-factory`), so CX9 builds and ORCH reviews cross-model.

**Recommended:** 2 now (always right), plus 1 for BossMan specifically, and decide on 3 separately.
