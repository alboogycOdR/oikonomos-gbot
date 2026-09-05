# TASK-183 — G-02b/G-03b — Mobile: routine pause/test-run/skill binding, context meter, 'Start fresh', compaction event

## Brief

Surface TASK-179 and TASK-182 on mobile. Routine detail: Pause/Resume toggle, a 'Test run' button that shows the server's real-work warning in a confirm dialog before firing, and an optional skill selector (enabled skills only) on create/edit. Chat header: a compact context meter (used/limit, colour steps at 60/80%) fed by GET /threads/:id, and a 'Start fresh' action in the overflow menu with a confirm sheet explaining that earlier turns stay visible but the bot will not see them. Render the `Context compacted…` system message with TASK-157's system-event styling. Depends on TASK-178 only for the shared chat_screen.dart/api_client.dart territory — do not start until it is merged.

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-02, G-03 (visible meter in the mobile header); report §13.2 items 3–4 (context hygiene, transparent metering); TASK-158/159 routine screens and TASK-157 system-event styling are the surfaces to extend

## Territory

apps/mobile/lib/screens/create_routine_screen.dart, apps/mobile/lib/screens/routine_detail_screen.dart, apps/mobile/lib/widgets/context_meter.dart, apps/mobile/lib/screens/chat_screen.dart, apps/mobile/lib/api/api_client.dart, apps/mobile/lib/api/models.dart, apps/mobile/test/screens/routine_detail_screen_test.dart, apps/mobile/test/widgets/context_meter_test.dart, apps/mobile/test/screens/chat_screen_test.dart

Depends_On: TASK-178, TASK-182

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log
