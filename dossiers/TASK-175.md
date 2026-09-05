# TASK-175 — Carve services/worker chatRunDriver.ts into single-purpose modules

## Work Log

- [2026-09-05T23:45:00Z] [S5] Session start. TASK-174 (the previously
  in_progress task per session-start hook) was already merged to
  mainco/master (`b542fa6`) before this session began — nothing to resume
  there. Fetched mainco/master, confirmed TASK-175's real PLAN.md block:
  `Status: claimed`, no `Review_Findings` (fresh claim, not rework).
  Created `task/TASK-175-s5` from `mainco/master` (no pre-existing branch or
  dossier).
- [2026-09-05T23:45:00Z] [S5] Read `chatRunDriver.ts` (515 lines) and its
  test file (1020 lines) in full before touching anything, per the task's
  own Description discipline.
- [2026-09-05T23:45:00Z] [S5] Pure mechanical extraction, zero behaviour
  change, exactly per the Description's seams:
  - `promptAssembly.ts` — `buildRoleSystemPrompt` (moved verbatim).
  - `runWorkspace.ts` — `createChatRunWorkspace`/`removeChatRunWorkspace`
    (moved verbatim).
  - `connectorResolution.ts` — `resolveGmailMcpUrl`, `combineConnectorContexts`,
    `resolveGrantedWorkspaceConnector`, `resolveGrantedGmailConnector`,
    `resolveGrantedGoogleCalendarConnector`, `resolveGrantedGoogleDriveConnector`,
    `resolveGrantedManifestConnector` (private), `AcquiredConnector`, and the
    four `WORKSPACE_*` constants (moved verbatim; `resolveGrantedWorkspaceConnector`
    included here since it's `resolveGranted*Connector`-shaped even though it
    isn't manifest-backed, and `destinationFor` in `chatRunDriver.ts` needs its
    two tool-name constants).
  - `groupFanout.ts` — `deliverBotToBotMessage`, `CHAT_FANOUT_CAPABILITY_ID`,
    `BotToBotMessageRequest`/`BotToBotMessageResult` (moved verbatim).
  - `chatRunDriver.ts` kept: `createChatRunDriver`, `runChatTask`,
    `createBrokerDependencies`, `createRunParkPort`, `completionAuditSink`,
    `destinationFor`, `finalText`, `assertRequest`, and the three public
    interfaces — plus re-exports of `combineConnectorContexts`,
    `CHAT_FANOUT_CAPABILITY_ID`, `deliverBotToBotMessage`, and the two
    `BotToBot*` types so every name previously importable from
    `chatRunDriver.js` (directly, or via `services/worker`'s `index.ts`) is
    still importable with the same name and signature. Verified
    `index.ts` itself needed zero edits — it re-exports everything from
    `./chatRunDriver.js`, which now re-exports from the new sibling modules.
  - Not one line of logic, string, or capability id changed — every moved
    function is byte-identical to its pre-carve body (checked function documentation.
    comments moved with their functions).
- [2026-09-05T23:45:00Z] [S5] Test split, following the same seams:
  - `promptAssembly.test.ts`, `runWorkspace.test.ts` (new): the
    pre-carve suite had no pure-function unit tests for
    `buildRoleSystemPrompt`/`createChatRunWorkspace`/`removeChatRunWorkspace`
    in isolation — only end-to-end proof via a real driver run (TASK-156,
    TASK-153). Added fresh, additive unit tests for the extracted functions
    themselves (not required by the Description, but needed so these new
    test files aren't empty — an empty Vitest file is a valid but pointless
    file). The existing TASK-153/TASK-156 end-to-end tests were left
    untouched in `chatRunDriver.test.ts`, per the Description's "the existing
    chatRunDriver.test.ts keeps every test that exercises the driver
    end-to-end."
  - `connectorResolution.test.ts` (new): moved the TASK-139
    `combineConnectorContexts` unit test verbatim. The TASK-128 "derives
    Gmail's mounted surface" test asserts source-string facts that now span
    two files (the per-run grant filter moved to `connectorResolution.ts`;
    the Gmail-minter wiring and `connector?.allowedTools` consumer stayed in
    `chatRunDriver.ts`) — moved the test here and had it read both files'
    real source rather than weakening or dropping any of its five original
    assertions.
  - `groupFanout.test.ts` (new): moved the entire TASK-122
    `deliverBotToBotMessage` real-Postgres integration suite (3 tests)
    verbatim, importing from `./groupFanout.js`/`./runLifecycle.js` instead
    of `./chatRunDriver.js`.
  - `chatRunDriver.test.ts`: removed the four moved tests/suites and their
    now-unused imports (`combineConnectorContexts`, `CHAT_FANOUT_CAPABILITY_ID`,
    `deliverBotToBotMessage`, `type ConnectorContext`). Every remaining test
    (governance-helper unit tests for `destinationFor`/`finalText`, and all
    five real-Postgres end-to-end integration suites: TASK-116/117/136/139
    chat-run-driver, TASK-131 send_to_role, TASK-167 self-rename) is
    untouched — same assertions, same fixtures.
- [2026-09-05T23:45:00Z] [S5] Verification:
  - `pnpm -r build` — all 18 workspaces green, `tsc` clean for
    `services/worker` (confirms every re-exported name/signature still
    resolves).
  - `pnpm lint` — clean, zero warnings.
  - `pnpm -r test` hit a pre-existing, unrelated flake in
    `packages/approvals/src/editApproval.test.ts` (real-Postgres resource
    contention under full-suite parallelism — exactly the class of flake
    TASK-162 already exists to investigate; confirmed by re-running that
    single test file in isolation, where it passes cleanly). Not caused by
    this task — no file in `packages/approvals` is touched here.
  - Ran `services/worker`'s own suite directly with `npx vitest run` from
    `services/worker`: **87/87 passed** across all 15 test files, including
    every real-Postgres end-to-end suite still living in
    `chatRunDriver.test.ts` (TASK-116/117/136/139/131/167) and all four new
    sibling test files. One self-authored bug caught and fixed here: my new
    `runWorkspace.test.ts` test asserted the wrong sanitised-substring
    literal for a run id containing `/` and `.` — fixed after the first red
    run, re-verified green.
  - `git diff` on the test files: `chatRunDriver.test.ts`'s diff is deletions
    (moved tests) plus import trims — no changed assertions among the tests
    that stayed. The four new test files carry moved tests verbatim plus
    clearly-marked new additive unit tests (commented as such).
  - Files touched: exactly this task's `Owned_Paths`
    (`chatRunDriver.ts`/`.test.ts`, `promptAssembly.ts`/`.test.ts`,
    `runWorkspace.ts`/`.test.ts`, `connectorResolution.ts`/`.test.ts`,
    `groupFanout.ts`/`.test.ts`; `index.ts` inspected but needed no edit)
    plus this dossier. `AUTOPILOT_LOG.md`'s pre-existing uncommitted
    modification and the stray untracked `dossiers/TASK-168.md` in this
    worktree are pre-existing, not mine, and were left untouched/unstaged.
  - Status: needs_review.
