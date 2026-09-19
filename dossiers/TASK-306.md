# TASK-306 -- Inject profile-tier memory (user, agent and project scopes) into every chat run's system prompt, both lanes

## Brief
SPEC PREMISE CORRECTED BY ORCH 2026-09-19: the spec assumes an 'existing memory injection', but ORCH verified directly that NO profile memory reaches any chat run today -- services/worker has zero imports of @oikonomos/memory and promptAssembly.ts builds the prompt from role identity + skills only. Assigned to S5, priority high. Depends on: TASK-303.

## Spec pointers
specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md §1.2 ('stored as project-scope profile-tier memory facts, so every member's prompt sees it through the existing memory injection'), §11 first bullet ('visible to every member's next run and to no non-member'); packages/memory/src/facts.ts readProfileTier (already supports user/agent/project scopes and visible_to).

## Owned paths
services/worker/src/promptAssembly.ts, services/worker/src/promptAssembly.test.ts, services/worker/src/chatRunDriver.ts

## Intended approach
Add memory as a parameter to assembleSystemPrompt so promptAssembly stays testable without a DB; chatRunDriver does the read.

## Acceptance criteria
- A roster member's next run sees the project's charter facts; a non-member's run in any thread does not. (spec §11, §1.2)
- A role's own agent-scope facts and the tenant's user-scope facts appear in its prompt; another role's agent-scope facts never do; expired and superseded facts never do.
- Both lanes include the same memory block, proven by tests on each.
- The block is bounded by an explicit, justified cap.
- Full recursive suite via scripts/test-isolated.ps1 only.

## Work Log
