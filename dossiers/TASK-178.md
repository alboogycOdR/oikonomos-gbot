# TASK-178 — G-01c — Skills on mobile: library screen, per-bot enable toggle, `/` picker in the composer

## Brief

Flutter surface for TASK-177's API. A Skills library screen (list/create/edit — name, description, when-to-use, body as multiline markdown, approvals list) reached from the roster; a per-bot enable/disable toggle list on the bot settings surface (TASK-165 built title/instructions there — extend, don't fork); and a composer affordance: typing `/` in chat_screen's composer opens a bottom-sheet picker listing ONLY skills enabled for the active bot and inserts `/name` on tap. Match the Grok-Bot-reference visual bar (TASK-168 polish). Do not add any client-side enforcement beyond filtering the picker — the server decides (TASK-177).

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-01; docs/research/grok-bot-technical-report-and-replication-blueprint-2026-09-05.md §8.2 ('Reference a skill with /'); memory: docs/STUDY-grok-bot-018.md UI primitives

## Territory

apps/mobile/lib/screens/skills_screen.dart, apps/mobile/lib/screens/skill_edit_screen.dart, apps/mobile/lib/widgets/skill_picker.dart, apps/mobile/lib/screens/chat_screen.dart, apps/mobile/lib/api/api_client.dart, apps/mobile/lib/api/models.dart, apps/mobile/test/screens/skills_screen_test.dart, apps/mobile/test/widgets/skill_picker_test.dart, apps/mobile/test/screens/chat_screen_test.dart

Depends_On: TASK-177

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log

- [2026-09-06T05:18:00Z] [CX] Branch `task/TASK-178-cx` created. Preflight output: `[preflight] TASK-178 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE`; `9 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.`; `NEW apps/mobile/lib/screens/skills_screen.dart -> does not exist; parent apps/mobile/lib/screens/ exists`; `NEW apps/mobile/lib/screens/skill_edit_screen.dart -> does not exist; parent apps/mobile/lib/screens/ exists`; `NEW apps/mobile/lib/widgets/skill_picker.dart -> does not exist; parent apps/mobile/lib/widgets/ exists`; `FILE apps/mobile/lib/screens/chat_screen.dart -> exists, 999 line(s), 33806 bytes`; `FILE apps/mobile/lib/api/api_client.dart -> exists, 381 line(s), 14972 bytes`; `FILE apps/mobile/lib/api/models.dart -> exists, 303 line(s), 8832 bytes`; `NEW apps/mobile/test/screens/skills_screen_test.dart -> does not exist; parent apps/mobile/test/screens/ exists`; `NEW apps/mobile/test/widgets/skill_picker_test.dart -> does not exist; parent apps/mobile/test/widgets/ exists`; `FILE apps/mobile/test/screens/chat_screen_test.dart -> exists, 1098 line(s), 35908 bytes`.
- [2026-09-06T05:48:00Z] [CX] Implemented typed Skills API methods/models, skills library create/edit screens, server-confirmed per-bot settings toggles, and the enabled-only slash picker. Added widget coverage for library CRUD, picker selection, composer insertion, and toggle confirmation. Verification: `flutter test` — 108 tests passed; `flutter analyze` — no issues; `git diff --check` — clean.
