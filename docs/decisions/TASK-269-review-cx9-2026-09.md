# TASK-269 adversarial review (CX9)

**Reviewed commit:** `9e55192` (`task/TASK-269-s5`)

**Verdict:** REWORK REQUIRED

## Required change

The new Claude-session continuation ignores the established `POST
/threads/:id/fresh` boundary. That endpoint explicitly promises that older
turns are invisible to the model: it increments the thread epoch so prompt
assembly stops including pre-fresh messages and summaries
(`services/control-api/src/app.ts:1615-1637`). After this change, however,
`getLatestRunForThread` searches all historical runs for the role/thread and
has no epoch, reset marker, or time bound (`packages/db/src/runs.ts:256-280`).
`submitTaskExecution` then resumes any matching completed same-provider run
(`services/control-api/src/ports.ts:520-522`, `:526-529`, `:531-535` and the
following completion/provider condition), including one created before a
user selected **Start fresh**. The worker turns that persisted session ref
into the Claude CLI `--resume` input (`services/worker/src/main.ts:219-223`,
`services/worker/src/chatRunDriver.ts:792-809`), exposing the old Claude
session despite the fresh-context contract.

Before approval, make continuation respect an explicit session boundary. The
smallest safe design may associate runs with the current thread epoch and
query only that epoch, or invalidate/rotate the Claude continuation token
when `/fresh` succeeds. Decide and document the policy for ordinary long
idle gaps separately; the current code has no such bound, but the concrete
bug is the existing explicit fresh-reset operation. Add a real route-level
test that completes/captures a Claude prior run, invokes `/threads/:id/fresh`,
posts the next message, and proves its new run has no inherited session ref
and remains `started`.

## Pressure-point evidence

1. **Outcome, not flag:** passes. The database-backed worker test executes
   two genuine Claude turns, verifies the first stores a non-run-id session
   reference (`services/worker/src/chatRunDriver.test.ts:455-480`), and
   asserts the second real reply contains `teal`, information supplied only
   in the first turn (`:482-513`). This is outcome evidence, not only an
   assertion that a command contains `--resume`.
2. **Provider mismatch:** passes. The implementation compares the prior
   provider to the newly resolved provider before seeding
   (`services/control-api/src/ports.ts:502-510`, `:520-522` and the
   subsequent conditional); its real HTTP/Postgres test switches Claude to
   Gemini and asserts a null session ref on the new run
   (`services/control-api/src/chat.routes.test.ts:1744-1779`).
3. **First message:** passes. A missing prior run is a nullable result
   (`packages/db/src/runs.ts:253-280`), and the HTTP/Postgres test confirms
   the first posted message produces a `started` run with `sessionRef ===
   null` (`services/control-api/src/chat.routes.test.ts:1640-1670`).
4. **Group/fan-out:** passes for the production durable path. Every recipient
   gets a `fanout` execution with the shared thread id and its own recipient
   role (`services/control-api/src/app.ts:1873-1900`); the lookup is scoped by
   `task.roleId` specifically to prevent recipient-session cross-pollination
   (`packages/db/src/runs.ts:226-241`, `services/control-api/src/ports.ts:520-522`).
   The focused DB test exercises that role separation. The one-recipient
   group path also reaches the same submission function
   (`services/control-api/src/app.ts:1903-1928`).
5. **Old/stale sessions:** fails. There is no age limit or reset/epoch
   boundary in the lookup above. A time limit is a product-policy choice not
   established by the reviewed change, but ignoring the already-shipped
   explicit `/fresh` boundary is an implementation defect and must be fixed
   before merge.

## Review checks

- `git diff --check 7e6edff..task/TASK-269-s5 -- <seven implementation/test paths>` — clean.
- Reviewed the actual task branch (`9e55192`), including the DB query,
  durable submit path, worker queue hand-off, Claude CLI invocation, and
  route/worker integration tests. No files outside TASK-270 territory were
  modified.
