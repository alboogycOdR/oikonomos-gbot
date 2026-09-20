# TASK-307 -- Mobile: project API client, projects list, create-project flow (roster, manager, charter), entry from the roster screen (P-7a)

## Brief
Mobile is the primary client. Assigned to S5, priority high. Depends on: TASK-304.

## Spec pointers
specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md §1.1 (create a project with goal and done criterion, up to six bots, optionally one manager), §1.2 (charter captured at creation), §9.1 (routes), §9.2 (UI).

## Owned paths
apps/mobile/lib/api/api_client.dart, apps/mobile/lib/api/models.dart, apps/mobile/test/api/api_client_test.dart, apps/mobile/lib/screens/projects_screen.dart, apps/mobile/test/screens/projects_screen_test.dart, apps/mobile/lib/screens/create_project_screen.dart, apps/mobile/test/screens/create_project_screen_test.dart, apps/mobile/lib/screens/roster_screen.dart, apps/mobile/test/screens/roster_screen_test.dart

## Intended approach
Use Flutter at C:/src/flutter/bin/flutter; mirror templates_screen.dart for list states.

## Acceptance criteria
- ApiClient has typed methods for every §9.1 route with unit tests. (spec §9.1)
- ProjectsScreen lists real projects with loading/empty/error states and is reachable from the roster screen. (spec §9.2)
- CreateProjectScreen enforces at most six members and at most one manager client-side and surfaces the server's own rejection if violated. (spec §1.1)
- Charter fields are captured and sent at creation. (spec §1.2)
- flutter analyze clean and flutter test green for the whole package.

## Work Log
- [2026-09-20] S5: Implemented all §9.1 ApiClient methods + models, ProjectsScreen (detailBuilder hook for TASK-308 wiring), CreateProjectScreen (cap 6, one manager, charter, server error surfaced), roster entry button. flutter analyze clean; flutter test 194 passed. Note: server requires roster >=2 (schema minItems 2); client only requires >=1 and surfaces the server's rejection.
