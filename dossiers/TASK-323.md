# TASK-323 dossier

**Brief:** Expire unanswered human-takeover and secret requests (never while a human holds control)

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21. Borrow the idea, never the code.

**Approach:** see the task Description and Acceptance_Criteria in PLAN.md. Read our own code first and verify every UNVERIFIED or REPORTED claim.

## Work Log

- [2026-09-21T12:18:00Z] [CX9] Preflight completed before edits:
  ```text
  [preflight] TASK-323 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   services/worker/src/takeover.ts  -> exists, 127 line(s), 6219 bytes
    FILE   services/worker/src/takeover.test.ts  -> exists, 147 line(s), 7235 bytes
    FILE   packages/db/src/secretRequests.ts  -> exists, 164 line(s), 7326 bytes
    FILE   packages/db/src/secretRequests.test.ts  -> exists, 53 line(s), 3135 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

- [2026-09-21T12:18:00Z] [CX9] BLOCKED — no expiry sweep exists. `services/worker/src/takeover.ts:62-84` only derives pending state from the audit trail; it has no timer/caller. `packages/db/src/secretRequests.ts:5, 69-164` supports only `pending`, `fulfilled`, and `declined`, with no expiry accessor. `infra/postgres/migrations/017_secret_requests.up.sql:9,13-14` constrains `secret_requests.status` to those same three values, so an `expired` transition cannot be persisted without a new migration outside `Owned_Paths`. An unattended expiry also requires a production caller: `services/worker/src/main.ts:77-162` is the only worker boot composition and existing interval lifecycle, while `services/worker/src/jobs/workerJobQueue.ts` is the explicit queue-registration territory excluded by AC6. Calling a new sweep from `getTakeoverState` or `completeTakeover` would not expire an ignored request and would violate the requested 10-minute guarantee. Required territory expansion: a new `infra/postgres/migrations/033_secret_request_expiry.{up,down}.sql` (or equivalent migration) plus `services/worker/src/main.ts` for a safe interval/scheduler lifecycle; if the intended design is pg-boss, additionally `services/worker/src/jobs/workerJobQueue.ts` (which AC6 expressly says must cause an ownership-conflict stop). Once supplied, implement one atomic sweep that marks stale pending secret requests expired; fails still-unclaimed takeover/secret-request runs with the TASK-316 visible-message path; records a reason-only audit event; and excludes any takeover with a later `run.human_takeover_completed` event.

- [2026-09-21T21:17:49Z] [CX9] Resumed after ORCH widened TASK-323 to include migration 033 and `main.ts`; fetched and merged current integration base, then re-ran preflight. It now confirms the six original files plus NEW `infra/postgres/migrations/033_secret_request_expiry.{up,down}.sql` and existing `services/worker/src/main.{ts,test.ts}`. No expiry sweep exists: `takeover.ts` only derives takeover state; `secretRequests.ts` supports only pending/fulfilled/declined; `main.ts` owns the existing unattended interval lifecycle. A new blocking ownership gap remains: `services/worker/src/main.ts` can import database APIs only from `@oikonomos/db`, whose package export is solely `packages/db/src/index.ts`; the new `expirePendingSecretRequests` function must be exported there to be callable from the required worker caller. `packages/db/src/index.ts` is not in Owned_Paths. Importing `packages/db/src/secretRequests.ts` directly is impossible under `@oikonomos/db`'s package `exports` map and bypassing the package boundary with a new raw `pg.Pool` in the worker would duplicate database access policy. Required expansion: `packages/db/src/index.ts` only. No code changes made beyond this dossier heartbeat.
