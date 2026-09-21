# TASK-325 dossier

**Brief:** Guard Steel navigation targets: block metadata addresses and private ranges (Gemini lane)

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21. Borrow the idea, never the code.

**Approach:** see the task Description and Acceptance_Criteria in PLAN.md. Read our own code first and verify every UNVERIFIED or REPORTED claim.

## Work Log

- [2026-09-21T21:55:00Z] [CX9] Preflight completed before edits:
  ```text
  [preflight] TASK-325 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    services/worker/src/navigationGuard.ts  -> does not exist; parent services/worker/src/ exists
    NEW    services/worker/src/navigationGuard.test.ts  -> does not exist; parent services/worker/src/ exists
    FILE   services/worker/src/geminiToolExecutors.ts  -> exists, 898 line(s), 45601 bytes
    FILE   services/worker/src/geminiToolExecutors.test.ts  -> exists, 479 line(s), 25642 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-09-21T21:55:00Z] [CX9] Blocked before implementation: `createSteelGeminiTools` receives only `SandboxToolContext` plus `onHumanTakeover`; it has no `connectionString`, tenant, run ID, or audit callback. The only production construction site is `services/worker/src/chatRunDriver.ts:818`, outside TASK-325 `Owned_Paths`. That call site holds all required audit data and already persists takeover events. AC2 and ADR-005 require refusal audit from the real executor path, so a guard confined to the assigned files would either omit the audit or require an out-of-territory `chatRunDriver.ts` change. Please widen `Owned_Paths` to include that file (or provide an owned audit integration point). Verification: the Steel REST/CDP commands run via the sandbox client, and the worker calls `assertEgressPolicyApplied` before construction, but the inspected source supplies no demonstrated internal-target block; guard remains necessary as defence in depth. The Claude lane follows a separate broker-protected path; its equivalent navigation hardening is a follow-up, per task scope.
