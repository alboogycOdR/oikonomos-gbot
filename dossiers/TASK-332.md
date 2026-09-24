# TASK-332 dossier

**Brief:** Mobile roster: show each thread's title and preview

**Assigned:** S5. **Depends on:** TASK-331.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log
- [2026-09-24] [S5] Implemented on task/TASK-332-s5 (from master): defensive preview/lastMessageAt parsing in models.dart, title/preview/relative time in roster_screen.dart, 3 new tests. flutter test roster_screen_test.dart 15/15; flutter analyze clean. Dart is outside pnpm -r.
