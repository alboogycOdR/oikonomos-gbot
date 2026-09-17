# TASK-282 — Manager-bot / chief-of-staff tools

## Work Log

### 2026-09-17T06:20:00Z [S5]

Fresh start on `task/TASK-282-s5` (branch pre-existed empty from a prior
dispatch, no prior commits, no dossier). Read PLAN.md's TASK-282 block,
ADR-019 (+ its CX9 adversarial review), and the existing broker/db/worker
code the task's Owned_Paths cover.

**Part 1 done — `packages/db/src/roles.ts` / `roles.test.ts` (fully in
Owned_Paths, fully tested, real Postgres):**

- `MANAGER_BOT_DEFAULT_CAPABILITIES` — mirrors
  `services/control-api/src/defaultCapabilities.ts`'s
  `DEFAULT_ROLE_CAPABILITIES` byte-for-byte (duplicated, not imported:
  `packages/db` has no dependency on `services/control-api`). Documented
  in the doc comment.
- `createRoleWithDefaultCapabilities(options, input)` — creates the role,
  then grants every enabled capability in that floor at its live
  `default_tier` (never hardcoded). This is `workspace.create_bot`'s DB
  primitive.
- `updateRoleStatus` + `retireRole(options, { tenantId, callerRoleId,
  targetRoleId })` + `RoleRetirementError` (`self_retirement` /
  `not_found` / `cross_tenant` codes) — this is `workspace.retire_bot`'s
  DB primitive, with the self/cross-tenant guards the AC requires. The
  self-retirement check runs before any DB access (tested without
  `DATABASE_URL`).
- **Naming deviation, flagged for ORCH:** the AC text says retiring a bot
  should leave `getRole` showing `status: inactive`. The live
  `roles_status_check` constraint (`infra/postgres/migrations/
  004_roles_routines_rules.up.sql`) only allows `active | hidden |
  deleted`, and `infra/postgres/migrations/**` is outside this task's
  Owned_Paths — I am not authorised to write a migration adding a fourth
  value. `retireRole` uses `hidden` instead (documented at length in its
  own doc comment: `deleted` already carries a distinct "gone" meaning
  elsewhere — see `services/worker/src/roleMessageDelivery.ts`'s
  `status: "deleted"` fixture — and `hidden` is otherwise unused for any
  live behaviour today). This satisfies the AC's actual intent (a soft,
  non-destructive deactivation, no hard delete introduced, distinguishable
  from `active`) under a different literal string. **This needs ORCH
  confirmation** — either accept `hidden`, or file a follow-up migration
  task to add a real `inactive` value.
- Tests: 7 new cases in `roles.test.ts` (2 no-DB-required guard tests + 5
  real-Postgres integration tests: create-with-floor, retire-and-verify,
  cross-tenant refusal, not-found refusal, invalid-status rejection). All
  22 tests in the file pass against the real dev `DATABASE_URL`.

**Part 2 done — `packages/broker/src/builtinTools.ts` /
`builtinTools.test.ts` (fully in Owned_Paths):**

- Declared `mcp__workspace__create_bot` (`workspace.create_bot`,
  `T3_external`) and `mcp__workspace__retire_bot`
  (`workspace.retire_bot`, `T4_irreversible`), both `enabled: true`,
  adapter `mcp:workspace`.
- Added the AC-1 "real manager-bot scenario" integration test the task
  asked for: using the actual `BUILTIN_TOOLS` (not a synthetic renamed
  `gmail` tool, unlike `capabilityRegistry.test.ts`'s existing ADR-019
  isolation test), flip `retire_bot`'s declaration to `enabled: false`
  (the shape an operator kill-switch produces), grant a `manager-bot`
  role a matching T4 grant, and assert `handlePreToolUse` denies with
  the specific `capability.declared_disabled` reason (never the generic
  `capability.disabled`, never a silent allow). A second "control" test
  proves the same setup does NOT hit `declared_disabled` while the tool
  is declared-enabled.

**STOPPING HERE — blocked. Two real ownership-boundary problems found,
both reproduced, neither fixable inside this task's Owned_Paths:**

1. **`packages/broker/src/describe.ts` (not in Owned_Paths).** Adding the
   two tools to `BUILTIN_TOOLS` (required — it's this task's own AC 2)
   turned `packages/broker/src/index.test.ts`'s existing liveness
   assertion `"registers a describer for every BUILTIN_TOOLS name,
   including Bash and Edit"` **red** — reproduced, not speculative
   (`npx vitest run src/index.test.ts` in `packages/broker`). `describe.ts`'s
   `builtinDescribers` map is the whitelist `resolveApprovalRequired` uses
   by default; a tool absent from it is permanently denied
   `describe.undescribable` the instant it needs approval, and the map's
   own comment says explicitly "this is not a generic fallback." Needs two
   new entries, e.g. `mcp__workspace__create_bot: describeAs("create bot",
   "name")` and `mcp__workspace__retire_bot: describeAs("retire bot",
   "roleId")`.

2. **`packages/db/src/index.ts` (not in Owned_Paths).** `@oikonomos/db`'s
   `package.json` `"exports"` field exposes only the compiled barrel
   (`"." -> "./dist/index.js"`) — there is no deep-import path. The four
   new symbols this task needs (`createRoleWithDefaultCapabilities`,
   `retireRole`, `RoleRetirementError`, `updateRoleStatus`, plus
   `MANAGER_BOT_DEFAULT_CAPABILITIES` for the test) are implemented and
   tested in `packages/db/src/roles.ts` (owned), but
   `services/worker/src/workspaceMcpServer.ts` and
   `services/worker/src/geminiToolExecutors.ts` (both owned, both need to
   call them) **cannot import them at all** until `index.ts` re-exports
   them — confirmed by checking the package's own `exports` map, not
   assumed. I stopped before writing the MCP executor code because it
   would not typecheck/import without this.

3. **Informational, not a blocker for this task's own testable ACs, but
   flagged because it changes what "done" can mean for `retire_bot`:**
   `packages/broker/src/index.ts`'s `enforcementEnabled` switch (the one
   that lets a `T4_irreversible` capability reach the approval flow
   instead of an unconditional legacy deny) is **never set to `true`
   anywhere in this codebase** — verified by search, only the type
   declaration and the one read site at `index.ts:694` exist.
   `workspace.retire_bot` is the first `T4_irreversible` builtin/workspace
   tool ever declared, so it's the first to hit this: it is denied
   `tier.irreversible` for every caller regardless of grant, through the
   real broker, today. Pinned by a test in `builtinTools.test.ts` so this
   is deliberate, documented behaviour rather than a silent trap for
   whoever wires `enforcementEnabled` later. This does not block any of
   THIS task's testable acceptance criteria (the DB-level retirement
   semantics and dual-adapter tool parity are independently real and
   testable via the MCP handler path, which never calls
   `decidePreToolUse`) — but it does mean `retire_bot` cannot reach a
   human approval prompt end-to-end until a separate task wires it. Worth
   a deliberate ORCH call on whether that's this task's scope or a
   follow-up.

**Not yet started (blocked on #2 above):** `services/worker/src/
workspaceMcpServer.ts`, `services/worker/src/geminiToolExecutors.ts`,
`services/worker/src/workspaceTools.test.ts`. The MCP tool declarations
(schemas, tools/list entries, tools/call dispatch for `create_bot` and
`retire_bot`) and their handler bodies are designed (create_bot: parse
`{name, title, description?}`, call `createRoleWithDefaultCapabilities`,
audit `bot.created`; retire_bot: parse `{roleId}`, call `retireRole` with
`{tenantId: identity.tenantId, callerRoleId: identity.fromRoleId,
targetRoleId: input.roleId}`, map `RoleRetirementError` codes to
`isError: true` responses, audit `bot.retired` on success) but not
written, since they cannot import their own DB primitives yet.

**Requesting:** either (a) widen this task's `Owned_Paths` to include
`packages/broker/src/describe.ts` and `packages/db/src/index.ts` (both
narrow, mechanical additions — a describer map entry and a re-export
line each — not a scope change to what this task builds), or (b) ORCH/a
different unit makes those two edits directly (both are single-purpose,
low-risk, and `describe.ts` is inside the same protected-path family this
task already requires adversarial review for), after which I can resume
immediately: the DB layer and broker declarations are done and tested,
and the remaining MCP executor work is fully designed above.

### 2026-09-17T08:20:00Z [S5] — resumed after ORCH's widen + mock-shape fix, all achievable ACs done, new blocker found and reported

Resumed on the same branch (`task/TASK-282-s5`) after the power-interruption
re-dispatch. ORCH had already: (a) widened `Owned_Paths` to include
`describe.ts`, `describe.test.ts`, `packages/db/src/index.ts`; (b) fixed a
real compile error in my Part-2 test's mock `issueApproval`/`verifyAndConsume`
stubs (commit `a14374d`, confirmed correct by inspection — the test only
exercises the deny path, so the stub shape fix is functionally inert but now
type-correct); (c) added AC 8378 directing me to wire `enforcementEnabled`
on `retire_bot` or STOP with `SPEC_AMBIGUITY` if no `EnforcedActionClass`
fits.

**Completed this session, all within the widened `Owned_Paths`:**

1. `describe.ts` — added `mcp__workspace__create_bot` (`describeAs("create
   bot", "name")`) and `mcp__workspace__retire_bot` (`describeAs("retire
   bot", "roleId")`) to `builtinDescribers`. Fixes the finding #1 liveness
   break from the prior session.
2. `describe.test.ts` — two new direct tests for the above.
3. `packages/db/src/index.ts` — re-exported `createRoleWithDefaultCapabilities`,
   `retireRole`, `RoleRetirementError`, `updateRoleStatus`,
   `MANAGER_BOT_DEFAULT_CAPABILITIES`, and their types. Fixes finding #2.
4. `services/worker/src/workspaceMcpServer.ts` — `create_bot`/`retire_bot`
   handlers for the Claude MCP bridge (JSON schemas, `tools/list` entries,
   `tools/call` dispatch, input validation, `bot.created`/`bot.retired`
   audit events, `RoleRetirementError` mapped to `isError: true` — never a
   thrown exception for an ordinary policy-shaped denial).
5. `services/worker/src/geminiToolExecutors.ts` — identical executors added
   to `createWorkspaceGeminiTools`, same tiers (T3/T4), same audit events,
   same `RoleRetirementError` → `{ok:false, code}` mapping. Dual-adapter
   parity confirmed by a shared test file exercising both.
6. `services/worker/src/workspaceTools.test.ts` (new) — real-Postgres
   integration tests: create_bot floors correctly + appears via
   `listRoles` (both adapters), retire_bot refuses self-retirement and
   cross-tenant retirement with real denials (both adapters), retires
   successfully to `status: hidden` (both adapters), not-found gives a
   clear non-generic denial (both adapters).

**New blocker found — same ownership-boundary class as findings #1/#2,
not yet reported:**

7. **`services/worker/src/registerCapabilities.test.ts` (NOT in
   `Owned_Paths`).** Its one test asserts the `workspace` connector's
   registered capability list via a hardcoded array (`toMatchObject` with a
   literal array, not `arrayContaining`), so the array growing by the two
   new tools makes it red — reproduced directly:
   `registerCapabilities > registers each loaded manifest and the
   zero-grant built-in declaration set` fails, diff shows exactly the two
   new capabilities appended and nothing else wrong. Needs one two-line
   addition to that hardcoded array. Same shape as the describe.ts/db-index
   gaps already found and fixed by ORCH — flagging rather than touching a
   file outside territory.

**AC 8378 (`enforcementEnabled` wiring) — STOPPING per the AC's own
explicit instruction, not proceeding further:**

Traced the full path required to make `retire_bot` actually reach the
approval flow instead of being unconditionally denied `tier.irreversible`:

- `RegisteredCapability.enforcementEnabled`/`enforcedActionClasses`
  (`packages/broker/src/index.ts:130-136`) are read at `index.ts:694`/`738`,
  but the ONLY production code that ever constructs a `RegisteredCapability`
  is `CapabilityRegistry.brokerPorts().getCapability`
  (`packages/broker/src/capabilityRegistry.ts:162-168`), which hardcodes the
  return to `{ toolName, capabilityId, defaultTier }` — it never reads or
  forwards either field, from anywhere. Confirmed by grep: zero production
  callers set `enforcementEnabled` anywhere in this codebase.
- `DeclaredTool` (`capabilityRegistry.ts:5-13`, what `BUILTIN_TOOLS` entries
  in `builtinTools.ts` — my own Owned_Paths file — actually satisfy) has NO
  `enforcementEnabled`/`enforcedActionClasses` field at all. So "set
  `enforcementEnabled: true` on `retire_bot`'s declaration," read literally,
  is not currently expressible on a `BUILTIN_TOOLS` entry — the field would
  need to be added to `DeclaredTool` and then threaded through
  `CapabilityRegistry.brokerPorts().getCapability` into the
  `RegisteredCapability` it returns. **Both `capabilityRegistry.ts` and
  `packages/broker/src/index.ts` are outside this task's `Owned_Paths`.**
- Separately, even if that plumbing existed: `EnforcedActionClass`
  (`packages/policy/src/enforcement.ts:10-15`, also outside `Owned_Paths`)
  has exactly the 5 values the AC itself already named as not obviously
  fitting — confirmed by re-reading each: `E1_payment`,
  `E2_auth_security_friction` (worse than not fitting — its own dedicated
  branch at `index.ts:765` unconditionally denies `human.takeover` instead
  of issuing an approval, which is the wrong behavior for `retire_bot`),
  `E3_local_machine_execution`, `E4_secret_handling`, `E5_d3_path_access`.
  None describe "retire another bot." Leaving `enforcedActionClasses` empty
  while setting `enforcementEnabled: true` is actively worse than today's
  behavior, not a safe middle ground: traced `resolveEnforcementGate`
  (`packages/policy/src/enforcement.ts:60-89`) — with no action class, no
  `requireApprovalRule` row, and the caller's grant not exceeding its
  ceiling, resolution reaches rank 6 `default_autonomous` and `index.ts:749`
  allows the call with **no approval at all**, which is worse than the
  current unconditional deny for a T4 tool that retires another bot.

This is exactly the situation AC 8378 itself names as the stop condition:
*"If no existing class fits and a new one is genuinely needed, STOP and
report SPEC_AMBIGUITY with the exact gap rather than inventing a
classification or leaving retire_bot silently non-functional."* Wiring this
correctly needs a real policy decision (does `retire_bot` get a new
`EnforcedActionClass`, e.g. something like `E6_role_lifecycle`, or does it
lean on a seeded `RequireApprovalRule` instead of a fixed-floor class?) plus
edits to three files this task cannot touch
(`packages/broker/src/capabilityRegistry.ts`,
`packages/broker/src/index.ts`, `packages/policy/src/enforcement.ts`). Not
attempting a workaround inside `Owned_Paths` — there isn't a safe one; the
DB-level retirement semantics and dual-adapter parity this task's other ACs
require are independently complete and tested via the MCP handler path
(which never calls `decidePreToolUse`), so this gap affects only
`retire_bot`'s reachability through the real broker end-to-end, not the
governed primitives this task actually built and owns.

## Status: blocked (SPEC_AMBIGUITY + OWNERSHIP_CONFLICT)

Branch `task/TASK-282-s5` has 3 commits (2 from the prior session, 1 new
this session):
- `feat(db): add createRoleWithDefaultCapabilities and retireRole for manager-bot tools`
- `feat(broker): declare workspace.create_bot / workspace.retire_bot builtin tools`
- `feat(broker,db,worker): manager-bot MCP executors, describers, and db re-exports [TASK-282]`

Test evidence (all via `scripts/test-isolated.ps1`, isolated `oikonomos_test`
DB, `-Init` re-run once to re-register the two new capabilities):
- `-Filter "@oikonomos/db"` → 42/42 files, 245 passed | 2 skipped (247),
  including `roles.test.ts` 22/22 (7 TASK-282 cases).
- `-Filter "@oikonomos/broker"` → 15/15 files, 177/177 pass, including
  `describe.test.ts` 21/21 (2 new), `builtinTools.test.ts` 3/3, and
  `index.test.ts` 15/15 — the finding-#1 liveness test is green again.
- `-Filter "@oikonomos/worker"` → 29/32 files pass; `workspaceTools.test.ts`
  (new, this task's own) 4/4 pass. 3 files fail:
  - `registerCapabilities.test.ts` — finding #7 above (out-of-territory
    hardcoded array), 1/3 tests in that file, real and reproducible.
  - `chatRunDriver.test.ts` and the embedded `chatRunDriver.ts` tests (27
    tests total) — **not caused by this task.** Root cause confirmed:
    `SandboxClientError: OpenSandbox create-sandbox returned unexpected
    status 500 (DOCKER::SANDBOX_START_FAILED)`; `docker ps` shows no
    sandbox container running in this environment at all. These tests
    provision a real Docker sandbox per TASK-116/153/170/etc and every one
    of them needs it; none of this task's changes touch sandbox
    provisioning, chatRunDriver.ts, or Docker. Did not attempt a fix
    (shared infra, explicitly out of territory per the briefing's
    "Shared infrastructure" section) — reporting as an environment gap, not
    a code defect.
  - `workerJobQueue.test.ts`'s one timeout — pre-existing, already
    documented as a known race in TASK-258's own Progress_Notes
    (`dossiers`/PLAN.md: "a pre-existing race in that test's own waitFor
    helper... outside this task's Owned_Paths"); did not reproduce
    deterministically across the two runs in this session (present in the
    first run, absent in the second, same code).
- `pnpm --filter @oikonomos/db build`, `--filter @oikonomos/broker build`,
  `--filter @oikonomos/worker build` (tsc) → all three clean, zero errors.

**Requesting from ORCH:**
1. A policy decision on AC 8378 (new `EnforcedActionClass` vs. a seeded
   `RequireApprovalRule` vs. deferring `retire_bot`'s live-broker
   reachability to a separate follow-up task), plus either widening
   `Owned_Paths` to `packages/broker/src/capabilityRegistry.ts`,
   `packages/broker/src/index.ts`, `packages/policy/src/enforcement.ts`, or
   having a different unit make that specific wiring change.
2. Either widen `Owned_Paths` to include
   `services/worker/src/registerCapabilities.test.ts` (a two-line fix), or
   have ORCH/a different unit make it directly.

Everything else this task's ACs ask for (DB primitives, builtin
declarations, dual-adapter MCP executors, dual-adapter parity tests,
describe-step entries, db re-exports) is done, tested, and committed on this
branch.
