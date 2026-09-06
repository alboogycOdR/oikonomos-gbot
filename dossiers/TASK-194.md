# TASK-194 — TASK-067 describe-or-deny is configured-but-inert (ADR-005 liveness failure)

Owned_Paths: packages/broker/src/index.ts, packages/broker/src/index.test.ts, packages/broker/src/describe.ts, packages/broker/src/describe.test.ts

## Brief

Wire TASK-067's whitelist describe-or-deny gate into the live `handlePreToolUse` path. `actionRender` (approvals) produces the card text and is already live; `describeOrDeny` is the fail-closed **gate** ("if we cannot render it, we do not run it") and was never imported by the HTTP handler. ADR-005 liveness assertion required.

## Spec pointers

- docs/STUDY-grok-bot-018.md §Tier 1.2 / N3
- docs/decisions/ADR-005-control-liveness.md
- docs/decisions/ADR-004-approval-render-provenance.md (card text ≠ gate)
- packages/broker/src/describe.ts (TASK-067)

## Work Log

- [2026-09-06T06:04:41Z] [GB] Start on dispatcher-claimed TASK-194. control.mode=strict: no PLAN.md writes. Review_Findings empty (not a rework). Created `task/TASK-194-gb` from detached HEAD `c457c61`. Preflight (c8b9872 filesystem check):
  ```
  [preflight] TASK-194 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
  [preflight] 5 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   packages/broker/src/index.ts  -> exists, 617 line(s), 21498 bytes
    FILE   packages/broker/src/index.test.ts  -> exists, 119 line(s), 4235 bytes
    FILE   packages/broker/src/describe.ts  -> exists, 154 line(s), 5817 bytes
    GLOB   packages/broker/src/describe.test.ts (PROTECTED PATH packages/broker/** — different-model adversarial review required before merge  -> matches nothing yet (new territory)
    NEW    per CLAUDE.md)  -> does not exist; parent ./ exists
  ```
  The GLOB/NEW lines are PLAN.md's parenthetical note parsed as extra pathspecs; the four real Owned_Paths all exist as FILEs (describe.test.ts is present).

  **Investigation**
  - `describeOrDeny` is imported only by `describe.test.ts`. `index.ts` does not import it. Doc comment already admitted this ("index.ts is outside Owned_Paths so this module is not wired").
  - `packages/approvals/src/render.ts` `actionRender` **is** live (issue.ts / editApproval.ts). It formats `{toolName, input, destination}` for *any* payload — it always succeeds. It is the card, not a whitelist gate.
  - `handlePreToolUse` for T3+ (legacy) and enforced-class (Addendum F) calls `issueApproval` with no describe check. An undescribable T3+ tool currently sails through and gets a generic-but-valid card. That is the live gap.
  - Gate belongs immediately before approval issue/consume, not on T0–T2 autonomous allows (would break existing L1 allow tests for tools without describers).

  Next: wire `describeOrDeny` into both approval-issuing sites via a single helper; default registry covers builtins + tools existing out-of-territory tests already issue approvals for; integration + ADR-005 liveness tests in index.test.ts.

- [2026-09-06T06:16:01Z] [GB] Implementation complete on `task/TASK-194-gb`. Territory: only Owned_Paths + this dossier.

  **Code**
  - `packages/broker/src/index.ts` — both approval-issuing sites (legacy T3+ and Addendum F enforced-class) now funnel through `resolveApprovalRequired`, which calls `describeOrDeny` **before** `issueApproval` / `verifyAndConsume`. Deny reason `describe.undescribable` / `describe.unpresentable`; audit payload type `describe.denied`. Optional `BrokerDependencies.describers`; omitted ⇒ `builtinDescribers` (fail-closed empty `{}` is distinct from omit).
  - `packages/broker/src/describe.ts` — `builtinDescribers` whitelist (SDK builtins + gmail send/draft/list + office act). Unknown names remain undescribable. Doc comment no longer claims the module is unwired.
  - Tests: `index.test.ts` integration on the real `handlePreToolUse` path (undescribable T3 denied, nonce cannot bypass, Bash/Edit/gmail send still park, unpresentable denied) plus ADR-005 LIVENESS (source-pin `describeOrDeny(` before `issueApproval` + behavioral deny reason / audit type / `issueApproval` not called). Builtin whitelist completeness (every `BUILTIN_TOOLS` name, Bash/Edit) also lives in `index.test.ts`.
  - Did **not** edit `describe.test.ts`: the territory-precommit hook parses PLAN.md's parenthetical "(PROTECTED PATH …)" as part of that pathspec, so `describe.test.ts` is rejected even though it is listed in Owned_Paths. Existing TASK-067 unit tests in that file stay byte-identical.

  **Test_Evidence**
  - `pnpm --filter @oikonomos/broker test` — 12 files, 137/137 pass.
  - `pnpm --filter @oikonomos/broker typecheck` — exit 0.
  - `pnpm --filter @oikonomos/evals-harness test` — 13 files, 19/19 pass (CAN-01/02/05/06/07/08 T3 `approval_pending` still green).
  - `pnpm -r build` — exit 0.
  - `pnpm lint` — exit 0.
  - `node infra/ci/banned-modes.mjs` — clean.
  - `pnpm -r test` does **not** exit 0 on this worktree because of a **pre-existing** out-of-territory failure: `services/control-api/src/skills.routes.test.ts` "creates, updates, lists, and enables a skill for a role end to end" PATCH `/skills/:id` returns 400. Reproduced on parent `c457c61` with TASK-194 changes stashed. Not caused by this task; cannot fix (control-api / skills routes outside Owned_Paths). First recursive run also hit a 5s timeout in `packages/approvals` `editApproval.test.ts` (compose Postgres); that test passed on retry (21/21) and in the second recursive run (16/16 files).

  Ready for review.
