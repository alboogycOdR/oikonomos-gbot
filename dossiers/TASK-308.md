# TASK-308 -- Mobile: project detail -- board with states and blocked reasons, artifact register, decision log, STATUS.md (P-7b)

## Brief
Build on TASK-307's api methods only -- do not edit api_client.dart or models.dart (if a method is genuinely missing, report OWNERSHIP_CONFLICT naming it). Assigned to CX9, priority high. Depends on: TASK-307.

## Spec pointers
specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md §3 (board, states, mandatory blocked reason), §3.3 (blocked visible), §4 (artifact register), §8 (decision log), §1.4 (STATUS.md), §9.2 (UI: board, register, attention on blocked).

## Owned paths
apps/mobile/lib/screens/project_detail_screen.dart, apps/mobile/test/screens/project_detail_screen_test.dart, apps/mobile/lib/screens/project_task_screen.dart, apps/mobile/test/screens/project_task_screen_test.dart

## Intended approach
Mirror chat_screen/templates_screen test style; reuse the existing theme tokens, no new design system.

## Acceptance criteria
- Board groups work items by state and shows every blocked item's reason. (spec §3, §3.3)
- A human can move a work item through the §3.1 state machine; blocked cannot be chosen without a reason; the server's refusal is surfaced verbatim.
- Artifact register and decision log render real data with loading/empty/error states. (spec §4, §8)
- The latest STATUS.md is shown when present. (spec §1.4)
- flutter analyze clean and flutter test green for the whole package.

## Work Log

- [2026-09-20T14:25:00Z] [CX9] Preflight evidence: `[preflight] TASK-308 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE`; all four owned screen/test files were NEW with existing parent directories. Implemented ProjectDetailScreen and ProjectTaskScreen using only TASK-307 API methods, with board state groups, prominent blocked reasons, roster/charter, artifact register, decision log, STATUS.md artifact, valid state transitions, required blocked-reason dialog, and server-error display. Focused widget tests and flutter analyze pass; full package test run next.
- [2026-09-20T14:40:00Z] [CX9] Verification complete: `flutter analyze` reports no issues; focused `flutter test test/screens/project_detail_screen_test.dart test/screens/project_task_screen_test.dart -r compact` passed 5/5; full `flutter test -r compact` completed successfully. `git diff --check` is clean. Ready for review.
