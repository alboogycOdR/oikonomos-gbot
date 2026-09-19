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
