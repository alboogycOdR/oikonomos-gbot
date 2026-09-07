# TASK-204 — G-06b Browser lane v1, live-wiring

Unit: S5. Mode: control.mode=strict (never touches PLAN.md; reports via devteam-control block).

## Pre-flight (Owned_Paths check, `scripts/preflight_paths.py TASK-204`)

```
[preflight] TASK-204 Owned_Paths inspected in E:/DELL-PROJECTS/GROKBOT-CLONE
[preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   services/worker/src/connectorResolution.ts  -> exists, 132 line(s), 6333 bytes
  FILE   services/worker/src/connectorResolution.test.ts  -> exists, 57 line(s), 3658 bytes
  FILE   services/worker/src/chatRunDriver.ts  -> exists, 957 line(s), 46895 bytes
  FILE   services/worker/src/chatRunDriver.test.ts  -> exists, 1082 line(s), 59043 bytes
```

Review_Findings was `—` (no rework); this was a fresh dispatch, branch `task/TASK-204-s5` did not
exist yet — created it myself per the dispatch prompt's explicit authorization.

## Work log

- [2026-09-07T04:40:00Z] [S5] Read AGENTS.md, briefing, PLAN.md's TASK-204 block, TASK-186's full
  Progress_Notes (the connector-layer task this one continues), `connectorResolution.ts`,
  `chatRunDriver.ts`, `steelSession.ts`, `browserLane.ts`, `steel-browser.yaml`,
  `compose.ts` (PARK_REASONS/withPark), `secretPathGuard.ts`, and `office-browser`'s
  Dockerfile/entrypoint. Branch created (`git checkout -b task/TASK-204-s5`).

- [2026-09-07T05:10:00Z] [S5] **Two real package-export-boundary constraints found and resolved,
  both documented inline as comments at the point of use (not hidden):**
  1. Neither `@oikonomos/connectors` (only `"."` exported) nor `@oikonomos/harness-factory`
     (only `"."`, `"./compose"`, `"./mcp"`) re-export `steelSession.ts`/`browserLane.ts` from
     their public package surface. Widening either package's `exports` map is outside this
     task's `Owned_Paths` (would touch `packages/connectors/src/index.ts` /
     `packages/harness-factory/package.json`, neither of which TASK-204 owns). Resolved by
     duplicating the small set of needed literals (`STEEL_MCP_ENTRYPOINT`,
     `OFFICE_BROWSER_SANDBOX_IMAGE`) locally in `connectorResolution.ts`/`chatRunDriver.ts` —
     the exact same precedent `chatRunDriver.ts` already used for `SANDBOX_IMAGE` (a duplicated,
     not shared, literal). For the `human_takeover_required` signal specifically: since
     `HumanTakeoverRequiredError` cannot be imported, `chatRunDriver.ts` consumes it by **duck
     type** on its stable `.code === "HUMAN_TAKEOVER_REQUIRED"` field (a wire contract TASK-186's
     own class already commits to), not `instanceof`.
  2. `McpStdioServerConfig` (`packages/harness-factory/src/mcp/types.ts`) has no `env` field, so
     `steelSession.ts`'s own `SteelMcpServerConfig`'s `STEEL_LOCAL`/`STEEL_BASE_URL`/
     `STEEL_PROFILE` environment cannot be threaded through the real MCP mount today. Disclosed,
     not silently worked around: the mounted `steel` stdio command relies on the MCP server's own
     defaults, which happen to match `office-browser`'s entrypoint (hardcoded
     `HOST=127.0.0.1 PORT=3000`). Widening `McpStdioServerConfig` is outside `Owned_Paths`
     (`packages/harness-factory/src/mcp/**`).

- [2026-09-07T05:40:00Z] [S5] **connectorResolution.ts**: added `resolveGrantedBrowserConnector`
  (steel-browser manifest → granted, enabled tool names → a stdio `ConnectorContext`, no
  `ConnectorSessionPool`/`acquire()`/`release()` — TASK-186's own explicitly-left-open design
  question, resolved and documented inline: Steel is a LOCAL in-sandbox session with no durable,
  checkoutable remote credential, so the pooled shape Gmail/Calendar/Drive use does not fit; a
  pure synchronous function of the role's grants does) and `isBrowserLaneGranted` (a pure
  grant-check helper shared with `chatRunDriver.ts`'s `resolveRoleSandbox`, avoiding a second
  Postgres round trip since that function already holds the role's `grants`).

- [2026-09-07T06:10:00Z] [S5] **chatRunDriver.ts**:
  - AC1: `resolveRoleSandbox` now selects `OFFICE_BROWSER_SANDBOX_IMAGE`
    (`oikonomos-office-browser:claude-2.1.263` — tagged per ORCH's dispatch-note correction,
    matching `SANDBOX_IMAGE`'s own immutable-tag precedent) instead of `SANDBOX_IMAGE` when
    `isBrowserLaneGranted` is true for the role's grants, at sandbox-creation time only (an
    already-provisioned sandbox keeps its image — same precedent as the existing single-image
    logic). The `OIKONOMOS_SANDBOX_IMAGE` env override still wins for either branch, unchanged.
  - AC2: `resolveGrantedBrowserConnector`'s result is folded into the existing
    `combineConnectorContexts(...)` call (no pool to release in the `finally` block, unlike
    Gmail/Calendar/Drive). This mounts `browser.*` tools onto the local (non-sandbox)
    `mountedToolNames`/`PolicyRegistry` surface exactly like the other three connectors.
    Additionally — since the *default production* path is the **sandboxed** CLI, not the local
    dev/test path, and AC2 explicitly names "the CLI's allowed-tools set" — extended
    `claudePrintCommand`/`executeSandboxChatRun` to accept the same combined connector and emit
    `--mcp-config '<json>'` plus extend `--allowedTools` when one is present. Every existing
    caller/test that omits the new parameter reproduces the prior `Bash Read`-only command
    byte-for-byte (verified: existing unit test at "constructs a scoped governed CLI command"
    passed unmodified). Also had to extend `destinationFor` (ADR-013's per-tool target
    extraction) with the four `mcp__steel__*` tool names — without this, a real governed call to
    any of them fails closed with "No governed destination" regardless of mounting, since
    `destinationFor` throwing is itself a fail-closed deny path in `packages/broker/src/index.ts`.
    `steel_navigate`→`input.url`, `steel_act`→`input.action`, `steel_snapshot`/`steel_screenshot`→
    a fixed `"current_page"` literal (both are observational, operate on whatever page is already
    open, and take no target-shaped input field per the manifest).
  - AC3: no production code change needed — Read + the D3 `secretPathGuard` (fixed-floor gate,
    independent of any tier/grant) already covers any path under `SEALED_SECRET_ROOT`, which
    `STEEL_BROWSER_PROFILE_ROOT` already is. This AC was genuinely just "prove it end to end now
    that browser is wired," which TASK-186's own review explicitly deferred here. Added the
    integration test (see below).
  - AC4: `runChatTask`'s catch block now special-cases a human-takeover signal: records a real,
    persisted `run.human_takeover_required` audit event (`kind`/`detail` payload — the mobile
    client's TASK-188 event contract) via the existing `recordAuditEvent` port, then
    `parkTaskRun` (TASK-136/155's own `waiting_approval` machinery) — deliberately **not**
    `completeTaskRun`/`failTaskRun`, and returns without rethrowing, so the run stays parked
    (zero further browser actions) rather than being reported failed or complete.

- [2026-09-07T06:40:00Z] [S5] Tests written (see Test_Evidence). `pnpm -r build`, `pnpm lint`,
  `pnpm --filter @oikonomos/worker run typecheck` all exit 0.

- [2026-09-07T07:00:00Z] [S5] Full `pnpm -r --no-bail test` run. Two failures, both pre-existing
  and unrelated to this diff, disclosed rather than hidden:
  1. `services/worker/src/jobs/workerJobQueue.test.ts` — pg-boss poll-job timing flake (the
     documented TASK-162/199 flake class; reproduced identically in isolation, unrelated file,
     not touched by this diff).
  2. `services/control-api/src/chat.routes.test.ts` — "Group-thread ... attributes a group
     message" — the exact assertion (`expected 'started' to be 'waiting_approval'`) and exact
     test TASK-205 already filed as a pre-existing, deterministic, unrelated bug.
  Every other package (including `packages/connectors` and `packages/harness-factory` —
  TASK-186's own suites, `steelSession.test.ts`/`browserLane.test.ts`) passed green, unmodified.

## Design notes / open items for ORCH

- The sandbox-path `--mcp-config`/`--allowedTools` extension is new, generic plumbing (not
  browser-specific) exercised so far only by the `claudePrintCommand` unit test (no real `claude`
  CLI process was run against it — same limitation the existing sandbox suite already has for
  Gmail/Calendar/Drive, which were never wired into the sandboxed CLI invocation before this
  task either). Flagging in case a real `claude -p --mcp-config` end-to-end smoke test is wanted
  before this ships to a live sandbox.
- The `env`-field gap in `McpStdioServerConfig` (no way to pass `STEEL_LOCAL`/`STEEL_BASE_URL`/
  `STEEL_PROFILE`) is real and disclosed above, not fixed — outside `Owned_Paths`.
- `destinationFor`'s new `"current_page"` literal for the two observational Steel tools is a
  judgment call (no natural per-call target field exists for them) — flagging explicitly in case
  ORCH wants a different governed-destination convention for observation-only tools.

## Test_Evidence

- `pnpm --filter @oikonomos/worker run typecheck` — exit 0.
- `pnpm -r build` — exit 0 (all 18 packages).
- `pnpm lint` — exit 0.
- `pnpm exec vitest run --config ../../packages/shared/vitest.config.ts --root . src/connectorResolution.test.ts src/chatRunDriver.test.ts` (from `services/worker`) — **32/32 pass**, including:
  - `connectorResolution.test.ts`: 7/7 (3 pre-existing + 4 new TASK-204 browser-grant tests).
  - `chatRunDriver.test.ts`: 25/25 (20 pre-existing + 5 new: `claudePrintCommand` connector
    extension unit test, AC1 sandbox-image-selection test, AC2 mounted-surface test, AC3 sealed-
    profile-denial test, AC4 human-takeover-parks test).
- `pnpm -r --no-bail test` (full recursive suite, real Postgres): all packages green except two
  pre-existing, disclosed, unrelated failures (pg-boss timing flake in
  `workerJobQueue.test.ts`; TASK-205's exact known bug in `chat.routes.test.ts`) — see work log
  above for the exact reproduction/diagnosis. `packages/connectors` (138/140, 2 skipped —
  live-URL-gated) and `packages/harness-factory` (131/131, including `browserLane.test.ts`/
  `steelSession` coverage) both green, unmodified, confirming AC5.
- CI banned-mode grep: `pnpm lint` includes the repo's own banned-mode scan (no separate command
  found); no `bypassPermissions`/`acceptEdits` introduced by this diff (none of the touched files
  reference permission modes at all).
