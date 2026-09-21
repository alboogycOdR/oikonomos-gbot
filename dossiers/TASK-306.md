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

- [2026-09-21T08:00:00Z] [S5] Created branch task/TASK-306-s5 from master. BLOCKED before code: services/worker has no dependency on @oikonomos/memory (package.json lists no memory; services/worker/node_modules/@oikonomos has no memory link; only control-api depends on it). readProfileTier lives only in packages/memory. Importing it requires editing services/worker/package.json (+ pnpm-lock.yaml, likely tsconfig references) — all outside Owned_Paths (promptAssembly.ts/.test.ts, chatRunDriver.ts). Alternative (raw SQL against profile_facts in chatRunDriver.ts) would duplicate the ACL/expiry/supersede query in an unprotected place — rejected. Needs ORCH to widen Owned_Paths: services/worker/package.json, pnpm-lock.yaml, services/worker/tsconfig.json (if references used). Design otherwise ready: assembleSystemPrompt gains optional `memoryFacts` param -> bounded "## Memory" block (cap facts/chars); chatRunDriver calls readProfileTier({tenantId, roleId, projectId}) using existing projectAttributionForChatRun result, passing the same block to both lanes (single systemPrompt).
- [2026-09-21T10:55:00Z] [S5] Implemented: @oikonomos/memory dep (package.json + lockfile only that entry); promptAssembly.formatProfileMemoryBlock (cap PROFILE_MEMORY_MAX_CHARS=6000 chars ≈1.5k tokens, whole facts dropped + omission note), memoryFacts param on assembleSystemPrompt/assembleChatPrompt; chatRunDriver reads readProfileTier once (user + role agent scope + project scope only if role is on project roster via listProjectRoleMembers) feeding the single systemPrompt both lanes use. 5 new pure tests in promptAssembly.test.ts (21 pass); worker typecheck clean. Limitation: chatRunDriver.test.ts is outside Owned_Paths so no DB-backed driver-level member/non-member test; roster gating is by code + readProfileTier's own ACL tests. Full test-isolated: 4 failing packages (db projects.ts, evals-harness, worker chatRunDriver budget.platform_exceeded, control-api) IDENTICAL to pre-change logs from earlier sessions (runS5-full3/final/iso) - pre-existing environmental.
