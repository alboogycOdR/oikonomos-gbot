# TASK-339 dossier

**Brief:** Provenance block in every chat run's system prompt (both lanes)

**Assigned:** S5. **Depends on:** nothing.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log
- [2026-09-24T00:55:00Z] [S5] PROVENANCE_BLOCK added to buildRoleSystemPrompt (both lanes go through it); test covers empty instructions, null role, assembleSystemPrompt, assembleChatPrompt. Token cost: ~50 words / ~60 tokens (~290 chars). Full suite via test-isolated.ps1: 1 worker-file-level failure set = budget.platform_exceeded (env DB spend state, chatRunDriver etc.), plus control-api and evals-harness failures; none touch promptAssembly (22/22 pass). Log: runS5-339.log.
