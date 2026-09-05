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
