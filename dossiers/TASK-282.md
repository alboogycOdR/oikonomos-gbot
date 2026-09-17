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

## Status: blocked (OWNERSHIP_CONFLICT)

Branch `task/TASK-282-s5` has 2 commits:
- `feat(db): add createRoleWithDefaultCapabilities and retireRole for manager-bot tools`
- `feat(broker): declare workspace.create_bot / workspace.retire_bot builtin tools`

Test evidence:
- `cd packages/db && npx vitest run src/roles.test.ts` → 22/22 pass (7 new).
- `cd packages/broker && npx vitest run src/builtinTools.test.ts` → 3/3 pass (2 new).
- `cd packages/broker && npx vitest run src/index.test.ts` → 14/15 pass, 1
  pre-existing liveness test now red as a direct, expected, documented
  consequence of adding the two tools to `BUILTIN_TOOLS` (see finding #1
  above) — not a flake, not unrelated breakage.
- `cd packages/broker && npx vitest run src/capabilityRegistry.test.ts` → 16/16 pass, unaffected.
