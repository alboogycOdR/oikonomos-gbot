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
