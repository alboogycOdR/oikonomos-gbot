# TASK-338 dossier

**Brief:** Claude lane: end a sandbox run that goes silent

**Assigned:** S5. **Depends on:** TASK-336.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log

- [2026-09-24T12:20:00Z] [CX9] Resumed `task/TASK-338-cx9` at `ff13825`; verified the partial implementation and the expanded sandbox-client territory with `python scripts/preflight_paths.py TASK-338`. The client now exposes backward-compatible per-SSE-event activity and cancellation hooks, while the Claude driver owns the 180000 ms default silence timer, cancellation, visible TASK-316-style message, and `run.sandbox_silence_timeout` audit category. Added the silent and periodic-activity integration regressions left uncommitted by the handoff. `scripts/test-isolated.ps1 -Filter @oikonomos/sandbox-client`: 26/26 passed. Sandbox-client typecheck passed; worker typecheck is blocked only by pre-existing 712688f1 navigation-category incompatibility at `chatRunDriver.ts:1830`. Isolated worker suite is still running under the shared test-database lock.
