# TASK-187 — G-05b — Secret intake UX: masked inline card on mobile + fulfilment API

## Brief

The human half of TASK-184. API: `GET /secret-requests?status=pending`, `POST /secret-requests/:id/fulfil {value}` (value goes to the sealed store via TASK-184's typed layer, is redacted from request logs by the existing redact.ts, and the response carries only the ref), `POST /secret-requests/:id/decline`. Pushed to the client over the same SSE/push path approvals use. Mobile: an inline card in the thread — `<bot> is asking for: <label>` with the purpose, a masked text field (obscureText, no autocorrect, no clipboard history where the platform allows), Provide / Decline. On Provide the card collapses to `Provided · secret://…` and the run resumes (TASK-155 continue-after-approval). The value must never be logged client-side or included in analytics.

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-05; report C13 ('masked, excluded from the transcript, not shown to the model'); TASK-109/148 ApprovalCard transport (RT-01 push, TASK-129) as the delivery mechanism

## Territory

services/control-api/src/app.ts, services/control-api/src/openapi.ts, services/control-api/src/secretRequests.routes.test.ts, apps/mobile/lib/widgets/secret_request_card.dart, apps/mobile/lib/screens/chat_screen.dart, apps/mobile/lib/api/api_client.dart, apps/mobile/lib/api/models.dart, apps/mobile/test/widgets/secret_request_card_test.dart

Depends_On: TASK-184, TASK-183

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log
