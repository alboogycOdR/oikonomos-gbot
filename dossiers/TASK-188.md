# TASK-188 — G-07 — Human take-over: park on auth friction, user drives the live view, hand back and resume

## Brief

On a `human_takeover_required` event (TASK-186), the worker parks the run via the RunParkPort with kind `takeover` (distinct from approval), the user gets a push + inline card ('<bot> needs you to sign in to <host>' with Take over / Cancel). Take over opens TASK-171's live view in INTERACTIVE mode for the human — the agent's own session is demoted to viewer for the duration (execd PTY `mode=viewer` for shell; for the browser, Steel's session is driven by the human's WebSocket and the agent's CDP handle is paused). Hand back: `POST /runs/:id/takeover/complete` resumes the run through TASK-155's continue-after-approval path with a single system message 'the human completed the step' — no credentials, no page content from the takeover window. Cancel refuses the run with a model-directed message. Every transition is an audit event.

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-07 (AC anchors: model receives no keystrokes/page content during take-over; resume reuses continue-after-approval with ADR-007 replay guarantees); report C14, §12.2 'Take-over'; ADR-010 Amendment enforced set (password/2FA/CAPTCHA/payment = human takeover, never typed by the model); TASK-136/155 park/resume machinery; TASK-171 live view; docs/research/opensandbox-exec-api-gap-2026-09-05.md (execd PTY holder/viewer roles)

## Territory

services/worker/src/takeover.ts, services/worker/src/takeover.test.ts, services/control-api/src/app.ts, services/control-api/src/openapi.ts, services/control-api/src/takeover.routes.test.ts, apps/mobile/lib/widgets/takeover_card.dart, apps/mobile/lib/screens/live_agent_screen.dart, apps/mobile/test/widgets/takeover_card_test.dart

Depends_On: TASK-186, TASK-171, TASK-187

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log
