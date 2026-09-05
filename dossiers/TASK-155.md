# TASK-155 Dossier

## Work Log

- [2026-09-05T10:35:00Z] [CX9] Preflight passed: services/control-api/src/app.ts (FILE, 1059 lines); services/control-api/src/ports.ts (FILE, 235 lines); services/control-api/src/*.test.ts (5 files); services/worker/src/chatRunDriver.ts (FILE, 468 lines); services/worker/src/chatRunDriver.test.ts (FILE, 860 lines); services/worker/src/runLifecycle.ts (FILE, 206 lines); services/worker/test/runLifecycle.test.ts (FILE, 337 lines). Traced composition: POST /approvals/:nonce/decide currently only calls deps.decideApproval in services/control-api/src/app.ts; fresh chat runs are composed in runChatTask in services/worker/src/chatRunDriver.ts and pass agentSdkOptions to executeTaskRun. Investigating resume wiring and live Postgres coverage.
- [2026-09-05T10:40:00Z] [CX9] Implemented continuation: grant route resolves the approved waiting chat run and its task/thread, then dispatches the same run with its persisted session_ref. `runChatTask` resumes the existing lifecycle row before calling `executeTaskRun` with `agentSdkOptions: { cwd, env: {}, resume: session_ref }`; successful output is inserted on the original thread and completion transitions the same run. SDK errors flow through `failTaskRun`, producing no fabricated message. Rejection deliberately never dispatches.
- [2026-09-05T10:41:00Z] [CX9] Evidence: `pnpm --filter @oikonomos/control-api typecheck` passed; `pnpm --filter @oikonomos/worker typecheck` passed; `pnpm --filter @oikonomos/control-api test -- chat.routes.test.ts` passed (27 tests, including grant/reject dispatch); `pnpm --filter @oikonomos/worker test -- chatRunDriver.test.ts --reporter=verbose` passed TASK-155's real-Postgres same-run resume/message/completion and failure/no-fabricated-message cases. `pnpm lint` exited 0. Started recursive build/test runs; the execution host returned partial streamed output before final aggregate summaries, so their completion is not claimed here.

## Next real step

Full filesystem/network isolation of chat tool execution remains the separately scoped OpenSandbox work (TASK-142); it is not part of this continuation wiring.
