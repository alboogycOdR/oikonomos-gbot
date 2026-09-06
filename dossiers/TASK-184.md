# TASK-184 — G-05a — Secure secret intake: `request_secret` broker tool + sealed store + audit (protected path)

## Brief

A bot that needs an API key must never receive it through the transcript. Add a built-in broker tool `request_secret({label, purpose})` (registered like sendToRole, TASK-131) that creates a `secret_requests(request_id, tenant_id, role_id, run_id, label, purpose, status pending|fulfilled|declined, secret_ref text null, created_at, fulfilled_at)` row and parks the run exactly as an approval does (reuse the RunParkPort path — this IS an enforced-line action per ADR-010). Fulfilment (the API/UI half is TASK-187) stores the value under the existing D3 sealed-secret root (TASK-088/097 constant) and writes only `secret://<ref>` to the row; the tool's result to the model is `{status:'fulfilled', ref:'secret://…'}` — never the value. The describe-or-deny renderer (TASK-067) must render this tool's approval card as `Bot <name> is asking for: <label> — <purpose>`. Audit records request and fulfilment with the ref only. Depends on TASK-176 solely for the packages/db/src/index.ts export line — coordinate by rebasing after 176 merges.

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-05 (AC anchors: value appears in zero rows of messages/audit_events/worker logs; ref resolves only for the requesting role); report C13, §8.2, §12.2 'Secure secret request'; ADR-010 Amendment (secret handling on the enforced line, N4); TASK-088/093 sealed-secret guard; TASK-131 sendToRole as the pattern for a real invokable broker tool. PROTECTED PATH packages/broker/** — author CX (Codex), reviewer ORCH on opus-4-8 satisfies the different-model rule (Directive §3).

## Territory

packages/broker/src/requestSecret.ts, packages/broker/src/requestSecret.test.ts, packages/broker/src/builtinTools.ts, packages/broker/src/builtinTools.test.ts, packages/broker/src/index.ts, infra/postgres/migrations/017_secret_requests.up.sql, infra/postgres/migrations/017_secret_requests.down.sql, packages/db/src/secretRequests.ts, packages/db/src/secretRequests.test.ts

Depends_On: TASK-176

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log

- [2026-09-06T09:00:00Z] [CX] Resumed TASK-184 on `task/TASK-184-cx`; rebased the prior coordination-only commits onto current master after TASK-192 merged. Preflight output (verbatim):
  ```text
  [preflight] TASK-184 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE
  [preflight] 14 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    packages/broker/src/requestSecret.ts  -> does not exist; parent packages/broker/src/ exists
    NEW    packages/broker/src/requestSecret.test.ts  -> does not exist; parent packages/broker/src/ exists
    FILE   packages/broker/src/builtinTools.ts  -> exists, 31 line(s), 1525 bytes
    FILE   packages/broker/src/builtinTools.test.ts  -> exists, 19 line(s), 1438 bytes
    FILE   packages/broker/src/index.ts  -> exists, 658 line(s), 22400 bytes
    NEW    infra/postgres/migrations/017_secret_requests.up.sql  -> does not exist; parent infra/postgres/migrations/ exists
    NEW    infra/postgres/migrations/017_secret_requests.down.sql  -> does not exist; parent infra/postgres/migrations/ exists
    NEW    packages/db/src/secretRequests.ts  -> does not exist; parent packages/db/src/ exists
    NEW    packages/db/src/secretRequests.test.ts  -> does not exist; parent packages/db/src/ exists
    FILE   packages/db/src/index.ts  -> exists, 180 line(s), 3836 bytes
    FILE   services/worker/src/workspaceMcpServer.ts  -> exists, 141 line(s), 7181 bytes
    FILE   services/worker/src/chatRunDriver.ts  -> exists, 292 line(s), 15126 bytes
    FILE   services/worker/src/connectorResolution.ts  -> exists, 128 line(s), 6016 bytes
    FILE   services/worker/src/connectorResolution.test.ts  -> exists, 48 line(s), 3203 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

- [2026-09-06T09:20:00Z] [CX] Implemented the task-owned request schema/accessors, broker declaration plus bounded pre-approval parser/descriptor, workspace MCP handler, worker run identity wiring, and grant-gated connector admission. `pnpm --filter @oikonomos/db build`, `pnpm --filter @oikonomos/broker build`, and `pnpm --filter @oikonomos/worker typecheck` pass. DB suite: 35 files passed, 1 migration-gated file skipped, 174 tests passed / 4 skipped. Broker suite has one expected territory blocker: its existing liveness test reads `builtinDescribers` directly from `packages/broker/src/describe.ts`, so it fails for the new BUILTIN_TOOLS entry until the descriptor is added there; `describe.ts` and `index.test.ts` are not Owned_Paths. Worker suite: 18 files pass, but 14 tests fail because the existing persistent capability fixtures lack `workspace.request_secret`; registration/seeding and `registerCapabilities.test.ts` are outside Owned_Paths. This is an OWNERSHIP_CONFLICT, not a code workaround candidate. The shared dev DB also has no `secret_requests` table because migration 017 is unapplied; applying it is shared-infrastructure mutation and outside territory. Need ORCH to widen ownership (at least `packages/broker/src/describe.ts`, its test, worker capability registration/fixture files) and arrange/apply the migration, or assign those seams to their owners.

- [2026-09-06T00:00:00Z] [CX] Created `task/TASK-184-cx`, rebased it onto current `master` after TASK-176, and completed the required territory preflight:

```text
[preflight] TASK-184 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE
[preflight] 9 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  NEW    packages/broker/src/requestSecret.ts  -> does not exist; parent packages/broker/src/ exists
  NEW    packages/broker/src/requestSecret.test.ts  -> does not exist; parent packages/broker/src/ exists
  FILE   packages/broker/src/builtinTools.ts  -> exists, 31 line(s), 1525 bytes
  FILE   packages/broker/src/builtinTools.test.ts  -> exists, 19 line(s), 1438 bytes
  FILE   packages/broker/src/index.ts  -> exists, 617 line(s), 21498 bytes
  NEW    infra/postgres/migrations/017_secret_requests.up.sql  -> does not exist; parent infra/postgres/migrations/ exists
  NEW    infra/postgres/migrations/017_secret_requests.down.sql  -> does not exist; parent infra/postgres/migrations/ exists
  NEW    packages/db/src/secretRequests.ts  -> does not exist; parent packages/db/src/ exists
  NEW    packages/db/src/secretRequests.test.ts  -> does not exist; parent packages/db/src/ exists
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

- [2026-09-06T00:00:00Z] [CX] BLOCKED — OWNERSHIP_CONFLICT: the assigned paths cannot make `request_secret` a real invokable tool or meet the sealed-secret acceptance criteria. The existing real broker tool pattern is `services/worker/src/workspaceMcpServer.ts` (tool list/call dispatch); mounting and parking require `services/worker/src/chatRunDriver.ts` / `packages/harness-factory/src/compose.ts` (`RunParkPort`); the D3 root/resolver is `packages/shared/src/sealedSecretRoot.ts`; and public typed-layer consumers require an export from `packages/db/src/index.ts`. None is in TASK-184 Owned_Paths. Please widen territory or carve integration/secret-store work into appropriately owned tasks.

- [2026-09-06T00:35:00Z] [CX] BLOCKED — OWNERSHIP_CONFLICT: after applying the widened worker and DB-export territory, I traced the actual grant-derived MCP mount. `services/worker/src/connectorResolution.ts` owns `resolveGrantedWorkspaceConnector()`, which maps persisted capability grants to `allowedTools`; it currently admits only `workspace.send_to_role` and `workspace.rename_self`. `chatRunDriver.ts` consumes this result, so adding dispatch/listing in the newly owned `workspaceMcpServer.ts` alone leaves `request_secret` absent from the real Agent SDK MCP surface. Please add `services/worker/src/connectorResolution.ts` (and, for the required end-to-end assertion, its relevant test file) to TASK-184 Owned_Paths. No production files were changed.

- [2026-09-06T01:55:00Z] [CX] BLOCKED — MISSING_DEPENDENCY: completed the widened-territory trace and found the remaining AC cannot be implemented truthfully. `packages/shared/src/sealedSecretRoot.ts` exports only `SEALED_SECRET_ROOT` (a D3 path constant); repo-wide source inspection found no sealed-secret store or resolver capable of resolving a `secret://` ref by requesting role. The AC requires both the resolver and a cross-role refusal test, but `packages/shared/src/sealedSecretRoot.ts` is outside TASK-184 territory. Also, the required TASK-067 describe-or-deny approval-card renderer is in `packages/approvals/**`, outside territory; the owned worker `workspaceMcpServer.ts` can enumerate the MCP schema, but it cannot make the mandated approval-card render. I did not create a competing vault/resolver or modify an unowned renderer. Required next action: ORCH must either (a) widen TASK-184 to the specific existing/new sealed-store + resolver and renderer files, or (b) split/sequence an explicit secret-store/renderer dependency and revise the AC accordingly. No production files changed in this session.

- [2026-09-06T06:51:31Z] [CX] Added the widened-path fixes: `builtinDescribers` now registers `mcp__workspace__request_secret` through its strict bounded parser, and `registerCapabilities.test.ts` now asserts the new T3 workspace capability in both declaration and DATABASE_URL-gated idempotency coverage. Focused broker parser/describe tests (21/21), worker registration tests (3/3), and broker/worker/db builds pass. Full broker suite remains blocked by one existing out-of-territory liveness test in `packages/broker/src/index.test.ts`: it exercises every built-in with `{command,file_path}` only, which is intentionally malformed for `request_secret` (missing required `label` and `purpose`), then requires a description. Making that synthetic malformed request describable would let it reach `issueApproval`, violating TASK-184 AC1. Needed resolution: widen TASK-184 to `packages/broker/src/index.test.ts` so its generic liveness fixture can supply valid request-secret input (or have its owner make that equivalent targeted test update). Full worker suite also has one unrelated existing routine scheduling assertion failure; the task-owned registration file passes in isolation.

- [2026-09-06T06:56:00Z] [CX] Final verification: `pnpm --filter @oikonomos/broker exec vitest run src/requestSecret.test.ts src/describe.test.ts` — 21/21 passed; `pnpm --filter @oikonomos/worker exec vitest run src/registerCapabilities.test.ts` — 3/3 passed; `pnpm --filter @oikonomos/broker build`, `pnpm --filter @oikonomos/worker build`, `pnpm --filter @oikonomos/db build`, and `pnpm -r build` — passed; `pnpm lint` — passed; `node infra/ci/test-banned-modes.mjs` — 8/8 passed; `node infra/ci/banned-modes.mjs` — clean. `pnpm -r test` was run; DB's TASK-184 integration suite passed 2/2, while the known broker liveness-fixture mismatch prevents a green full suite. Branch is clean at `3ae1325`; stopping BLOCKED rather than weakening malformed-input denial or editing the unowned test.
