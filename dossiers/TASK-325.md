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
- [2026-09-21T22:05:00Z] [CX9] Implemented the Gemini-only guard. `navigationGuard.ts` parses and canonicalises hostnames before classifying network targets; it blocks metadata, loopback, link-local, RFC1918, IPv6 unique-local, IPv4-compatible/mapped IPv6, numeric IPv4 spellings, credentials, non-HTTP(S), and malformed input without retaining URLs in its denial decision. `geminiToolExecutors.ts` invokes it before the session/CDP lookup; a rejection sends a model-safe sentence and emits only a category through the new callback. `chatRunDriver.ts` persists that callback as `steel_navigation_denied` with payload `{ category }`. This preserves the existing egress marker check as defence in depth; it does not demonstrate a target-level block. Claude uses its separate broker lane and remains a follow-up by task scope.
- [2026-09-21T22:06:00Z] [CX9] Test evidence: `powershell -ExecutionPolicy Bypass -File scripts\\test-isolated.ps1 -Filter @oikonomos/worker` ran the touched suites successfully: `navigationGuard.test.ts` 22/22 and `geminiToolExecutors.test.ts` 27/27 (including the category-only audit liveness assertion and no-CDP-call assertion). The worker command remains non-zero only for existing environment/baseline failures: 9 suites cannot resolve the absent `@oikonomos/memory` workspace package; two TASK-143 budget tests see pre-existing platform-budget exhaustion. `pnpm --filter @oikonomos/worker typecheck` has the same missing `@oikonomos/memory` baseline error and no TASK-325 diagnostic. Full recursive isolated suite was invoked through `scripts/test-isolated.ps1`; its controlled runner completed after starting the workspace sequence, but its tool output was unavailable after the runner detached, so its final classification cannot be asserted beyond the focused isolated result.
