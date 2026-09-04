# TASK-137 — Google Calendar connector session minter (Connectors-2a)

## Work Log

- [2026-09-04T19:40:00Z] [S5] Session start. Checkpoint at `.devteam/CHECKPOINT.md` referenced a stale TASK-136 resume
  (that task was already reviewed/merged by ORCH — `3e197ec chore(review): TASK-136 approved first-pass; merged` —
  before this session started). Dispatch prompt for this session is TASK-137. Discarded stray uncommitted
  `PLAN.md`/`AUTOPILOT_LOG.md` diffs in the worktree (not in Owned_Paths, control.mode is strict — never edited by S5
  anyway). Created `task/TASK-137-s5` off latest `mainco/master` (`f3cf42e`, includes TASK-138 claim by CX9).

- [2026-09-04T19:45:00Z] [S5] Read TASK-127's `gmailSessionMinter.ts`/`.test.ts` as the pattern to mirror per the task
  description, plus `oauthTokenProvider.ts` (generic `createOAuthTokenProvider` + Gmail's thin
  `createGmailOAuthTokenProvider` wrapper) and `manifests/google-calendar.yaml`. Confirmed Owned_Paths is exactly
  `googleCalendarSessionMinter.ts` + `.test.ts` — `oauthTokenProvider.ts` is NOT owned by this task, so per the task
  description ("write Calendar's the same way" as Gmail's thin wrapper, without duplicating the OAuth exchange) the
  Calendar-specific OAuth wrapper (`createGoogleCalendarOAuthTokenProvider` + its three `secret://google-calendar/oauth/...`
  ref constants) is kept local to `googleCalendarSessionMinter.ts`, calling the shared generic
  `createOAuthTokenProvider` rather than copying its refresh-token-exchange logic.

- [2026-09-04T19:50:00Z] [S5] Implemented `packages/connectors/src/mcp/googleCalendarSessionMinter.ts`:
  - `createGoogleCalendarOAuthTokenProvider(options)` — thin wrapper resolving 3 OAuth secrets via the caller-supplied
    `resolve` (throws `TypeError` if omitted — no silent unauthenticated fallback) and calling the generic
    `createOAuthTokenProvider`.
  - `createGoogleCalendarConnectorSessionMinter(options)` — composes `mcpConfigFromManifest` + the OAuth provider
    (built lazily on first mint, cached thereafter) into a `ConnectorSessionMinter` returning a frozen
    `McpHttpServerConfig` with `headers.authorization = Bearer <token>`.
  - Did NOT touch `packages/connectors/src/mcp/index.ts` or `packages/connectors/src/index.ts` (reserved for TASK-139
    per the task description).
  - No real token/secret literal anywhere — all test fixtures use runtime-assembled sentinel strings (N4 convention,
    same as `gmailSessionMinter.test.ts`).

- [2026-09-04T19:55:00Z] [S5] Wrote `googleCalendarSessionMinter.test.ts` mirroring `gmailSessionMinter.test.ts`'s 5
  cases (bearer token in config, custom serverName, token-provider reuse across mints, works through
  `createConnectorSessionPool({ mint })`, a mint failure never echoes a secret value) plus one Calendar-specific case:
  rejects with `TypeError` when no `oauth.resolve` option is supplied at all (guards against a silent unauthenticated
  fallback, which Gmail's wrapper can't hit because it defaults to `envSecretResolver` — Calendar's local wrapper has
  no such default since `envSecretResolver` isn't reused here).

- [2026-09-04T20:00:00Z] [S5] Test/build/lint evidence:
  - `pnpm test -- googleCalendarSessionMinter` (packages/connectors): 6/6 new tests pass; full package suite
    (14 files / 125 passed, 4 skipped) also green.
  - `pnpm -r build`: exit 0, all 17 workspaces (connectors package typechecks clean).
  - `pnpm lint` (root `eslint .`): exit 0, no output.
  - `pnpm -r test` (full recursive suite, run twice): both runs green except pre-existing, unrelated flakes under a
    shared Postgres compose instance running many workspaces' DB-backed suites concurrently — run 1:
    `packages/approvals/src/editApproval.test.ts` 2 tests timed out (5000ms) against compose Postgres; run 2: a
    different single test in `packages/db/src/runs.test.ts` timed out. Neither touches
    `packages/connectors` or anything in this task's diff (`git diff --stat mainco/master` for this branch shows only
    the 2 new connectors files). Re-ran the specific failing `editApproval` test in isolation (`pnpm vitest run
    src/editApproval.test.ts -t "refuses granted..."` inside `packages/approvals`): passes cleanly in ~5s alone —
    confirms contention/timeout under full concurrent recursive run, not a real regression. Flagging per CLAUDE.md's
    "always run the FULL recursive suite" amendment rather than suppressing; not this task's territory to fix.

- [2026-09-04T20:02:00Z] [S5] All acceptance criteria met. Committed `1c70093` on `task/TASK-137-s5`. Handing off
  `needs_review` via the fenced `devteam-control` block (control.mode is strict this session — PLAN.md itself is
  never edited by S5).
