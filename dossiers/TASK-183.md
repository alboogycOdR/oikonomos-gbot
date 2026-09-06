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

- [2026-09-06T11:20:00Z] [CX] Preflight completed before implementation: 9 entries inspected — existing create_routine_screen.dart, routine_detail_screen.dart, chat_screen.dart, api_client.dart, models.dart, chat_screen_test.dart; new owned context_meter.dart, routine_detail_screen_test.dart, context_meter_test.dart. Reviewed live TASK-182 and TASK-179 API contracts and began typed mobile wiring on task/TASK-183-cx.
- [2026-09-06T11:55:00Z] [CX] Implemented routine pause/resume, confirmation-gated test runs, on-demand enabled-skill selection, thread context/fresh API client methods, header meter, and fresh-context sheet. Added focused widget tests; `flutter analyze` is clean and focused widgets pass. Full suite initially exposed a pre-existing no-background-request expectation in create_routine_screen_test; changed skill loading to user-initiated and re-ran the affected tests cleanly.

- [2026-09-06T09:05:00Z] [CX] Preflight completed before code changes:
  ```text
  [preflight] TASK-183 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE
  [preflight] 9 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   apps/mobile/lib/screens/create_routine_screen.dart  -> exists, 159 line(s), 5646 bytes
    FILE   apps/mobile/lib/screens/routine_detail_screen.dart  -> exists, 88 line(s), 2846 bytes
    NEW    apps/mobile/lib/widgets/context_meter.dart  -> does not exist; parent apps/mobile/lib/widgets/ exists
    FILE   apps/mobile/lib/screens/chat_screen.dart  -> exists, 1140 line(s), 37819 bytes
    FILE   apps/mobile/lib/api/api_client.dart  -> exists, 461 line(s), 17400 bytes
    FILE   apps/mobile/lib/api/models.dart  -> exists, 336 line(s), 9817 bytes
    NEW    apps/mobile/test/screens/routine_detail_screen_test.dart  -> does not exist; parent apps/mobile/test/screens/ exists
    NEW    apps/mobile/test/widgets/context_meter_test.dart  -> does not exist; parent apps/mobile/test/widgets/ exists
    FILE   apps/mobile/test/screens/chat_screen_test.dart  -> exists, 1191 line(s), 39087 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-09-06T09:08:00Z] [CX] BLOCKED before implementation: `POST /routines/:id/test-run` is the sole exposed test-run route and returns `{ routine, warning: "test run performs real work" }` only with its `202` response, after `deps.testRunRoutine(...)` has already executed. TASK-183 requires that exact server-supplied warning be shown in a confirm dialog before firing, which cannot be obtained from this API before the side effect. Separately, `POST /roles/:roleId/routines` accepts `skillId`, but no routine update route exists for the required create/edit skill binding. Need an API contract decision: add side-effect-free routine metadata/preview plus an update endpoint, or explicitly permit an in-app copy of the warning and create-only skill binding.

- [2026-09-06T07:52:59Z] [CX] Completed the ORCH-resolved implementation on `task/TASK-183-cx`: create-time enabled-skill selector and `skillId` POST body, pause/resume plus literal-warning-confirmed test runs, typed thread context/fresh API calls, 60/80% context meter, fresh-confirm sheet preserving visible transcript, and context-compaction system-event coverage. Verified `flutter test` (112 passed) and `flutter analyze` (no issues); `git diff --check` clean.
