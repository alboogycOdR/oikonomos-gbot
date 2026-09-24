# TASK-335 dossier

**Brief:** Group routing: named fallback reasons and the only-holder rule

**Assigned:** CX9. **Depends on:** TASK-333.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log
- [2026-09-24T17:44:58Z] [CX9] Resumed after ORCH rework. Preflight: services/control-api/src/ports.ts exists (1,329 lines, 61,808 bytes); services/control-api/src/ports.test.ts exists (327 lines, 13,916 bytes). Scoped fallback shortcuts to unaddressed messages, prevented email-address false mentions, and added regression coverage for explicit mentions, @everyone, mixed on/off-roster mentions, email addresses, and single-candidate audit cardinality. Isolated control-api and recursive suite runs completed; build/typecheck and diff hygiene are clean. Next: commit the rework and hand off for review.

- [2026-09-24T16:49:00Z] [CX9] Preflight read verbatim: `[preflight] TASK-335 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE`; `[preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.`; `FILE services/control-api/src/ports.ts -> exists, 1204 line(s), 56298 bytes`; `FILE services/control-api/src/ports.test.ts -> exists, 260 line(s), 11104 bytes`. Implemented production-composition fallback auditing and the grant-only-holder shortcut in the two owned files. Focused `ports.test.ts` and control-api typecheck are green; next is the required isolated recursive suite.

- [2026-09-24T16:54:00Z] [CX9] Validation: `pnpm --filter @oikonomos/control-api exec tsc --noEmit` passed; focused `ports.test.ts` passed 15/15. The required `scripts/test-isolated.ps1 -Root E:\DELL-PROJECTS\wt-codex9-GROKBOT-CLONE` and follow-up `-Filter @oikonomos/control-api` each reached 18 packages passing / control-api 377/378 tests passing. The only red was the existing TASK-121 FreeLLMAPI group-route test at `chat.routes.test.ts:1459` (no expected Gemini run observed after a 201), already filed as TASK-344 and outside TASK-335 ownership; every TASK-335 assertion passed. `git diff --check` passed. Ready for review after committing the owned implementation and dossier.
