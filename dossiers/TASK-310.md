# TASK-310 -- Adversarial review of ADR-019 Amendment 2026-09-19

## Brief
Review ORCH's amendment (managers create and retire bots through the existing workspace tools) against the real code. Write the verdict here; ORCH commits it under docs/decisions/.

## Spec pointers
docs/decisions/ADR-019-project-entity-and-manager-role.md (Amendment 2026-09-19, and the 2026-09-17 amendment); specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md v1.2.

## Intended approach
Answer the five questions in the task Description with file:line evidence. Do not edit any ADR or source.

## Work Log

- [2026-09-19T08:20:00Z] [CX9] Preflight completed: `[preflight] TASK-310 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE`; `FILE dossiers/TASK-310.md -> exists, 12 line(s), 587 bytes`. Reviewed live code and the TASK-282/TASK-285 integration coverage at `a93223e8e86141bf5673e8782baa5ecd2786acc8`.

## Adversarial review verdict

**Verdict: accept-with-changes.** The existing workspace tools, when reached through the worker's broker hook, give the intended approval boundary and do not offer a grant-escalation path. Two changes are required before TASK-304 gives managers these grants: (1) narrow `retire_bot` server-side to the manager's project authority; and (2) define demotion as an approval-invalidating lifecycle transition, with an atomic test of demotion while create/retire approval is pending. The current ADR correctly calls the retirement scope an open point, but it must be resolved before this capability is put in a manager's regular mount.

### 1. Creation floor and approval parking — **yes, with the normal broker/MCP composition**

`workspace.create_bot` is declared T3 and enabled at `packages/broker/src/builtinTools.ts:55-65`. Its sole Claude handler calls `createRoleWithDefaultCapabilities` at `services/worker/src/workspaceMcpServer.ts:126-138`; Gemini calls the same function at `services/worker/src/geminiToolExecutors.ts:814-833`. That creation path grants only capability IDs from the explicit floor (`packages/db/src/roles.ts:279-290`), selecting only enabled rows from that set and inserting only those grants (`packages/db/src/roles.ts:313-334`). The real-Postgres test verifies every created grant is in that floor (`packages/db/src/roles.test.ts:366-391`). No tool argument supplies a capability or grant.

The broker gets the role grant before resolving the approval path (`packages/broker/src/index.ts:634-654`), then issues a T3 approval when no nonce is supplied (`packages/broker/src/index.ts:466-517`). TASK-285's real DB composition test proves `create_bot` initially returns `approval_pending`, finds the pending approval, and only permits the follow-up after a human grant (`services/worker/src/workspaceTools.test.ts:239-256`). The test currently proves the resulting role's default-floor behavior separately, not in that exact approved-call sequence; TASK-304's promised liveness test should combine them and assert row counts before parking, then exactly one role and only floor grants after approved execution.

### 2. Narrowed Invariant B — **no new autonomous role/grant hole, but it relies on L1 rather than project-MCP absence**

The ADR's narrowed wording is factually necessary: the workspace server exposes `create_bot` and `retire_bot` (`services/worker/src/workspaceMcpServer.ts:80-88`) and their handlers do create/retire roles (`services/worker/src/workspaceMcpServer.ts:126-160`). The worker wires every normal chat run through `handlePreToolUse` (`services/worker/src/chatRunDriver.ts:785-795`); the broker's live-grant check happens before the approval nonce is consumed (`packages/broker/src/index.ts:642-654`, `466-492`). That is a real governed path, not an absence-of-verb claim.

However, `handleWorkspaceMcpRequest` itself deliberately has no grant or nonce check and directly performs both mutations (`services/worker/src/workspaceMcpServer.ts:126-160`). It is a trusted child MCP endpoint, so the protection is the worker composition. The requested liveness test must therefore exercise the actual worker broker-to-MCP path for both lanes, not merely call L1 and then invoke the exported MCP handler separately as TASK-285's test does (`services/worker/src/workspaceTools.test.ts:240-256`, `260-275`). This is a test-strengthening requirement, not a claim that an external caller can reach the stdio child server.

### 3. Demotion and a pending approval — **revoking the grant blocks normal resume, but is not a complete lifecycle treatment**

For a pending call resumed through L1, revocation is security-effective: the role grant is read and required before `resolveApprovalRequired` reaches `verifyAndConsume` (`packages/broker/src/index.ts:642-654`, `466-492`). A demoted manager therefore receives `role.grant_missing` and cannot consume its previously granted nonce on a subsequent governed call.

But approval rows are not tied to a role grant or manager state. The action digest contains only tool name, input, and destination (`packages/broker/src/index.ts:319-326`); consumption predicates only on nonce, granted/unexpired/unused status, plus optional control-plane/user-context bindings (`packages/db/src/approvals.ts:229-232`; `packages/approvals/src/consume.ts:65-84`). Demotion/revoke code shown by the current DB accessor only deletes the role-grant row (`packages/db/src/database.ts:253-256`), with no approval invalidation. A human can thus grant a stale pending request, which will later fail at L1; and a demotion racing after L1 has returned allow but before the trusted MCP handler runs is not rechecked by that handler.

**Required change:** TASK-304 must specify and test one transactional demotion operation that revokes both manager grants and invalidates pending manager `workspace.create_bot`/`workspace.retire_bot` approvals (or binds approvals to an incremented manager-authorization generation checked at consumption). Test pending → demote → human grants/retries and assert no mutation. The implementation must also state the intended handling of an already-L1-authorized but not-yet-executed invocation; the strongest design binds the authorization generation at the handler boundary or otherwise serializes demotion against execution.

### 4. Tenant-wide retirement — **not acceptable for manager grants; scope it before TASK-304**

`retireRole` checks only that the target is not the caller and shares the tenant (`packages/db/src/roles.ts:405-429`). Its input contains no project ID, roster membership, or creator provenance. Both Gemini and Claude pass only tenant, caller role, and target role to it (`services/worker/src/geminiToolExecutors.ts:843-859`; `services/worker/src/workspaceMcpServer.ts:140-160`). Consequently, a manager can request retirement of any other tenant role; per-call approval makes that a human-confirmed action, not a project-scoped authorization boundary.

**Required change:** before granting `workspace.retire_bot` to managers, choose and enforce server-side target scope from authoritative project data—at minimum the manager's own project's current roster, and, if owner intent is to retire created specialists outside that roster, an explicit persisted project/creator provenance relation. Do not rely on model prompt text or approval-card review for this check. Add tests for another project in the same tenant and an unrelated tenant role (both denied before creating an approval), plus the allowed scoped target parking for approval.

### 5. Capability escalation for a created bot — **no path found**

The manager cannot choose creation grants (Question 1 evidence). `retire_bot` only changes a status (`packages/db/src/roles.ts:425-429`). Workspace tool parsing accepts only the documented bot fields (`services/worker/src/workspaceMcpServer.ts:213-239`), and the remaining workspace handlers are messaging, self-rename, secret request, and routine creation (`services/worker/src/workspaceMcpServer.ts:95-124`). The broker independently rejects any call absent a role grant (`packages/broker/src/index.ts:642-650`). Thus a manager can direct a new bot to use its default-floor capabilities or send handoffs, but cannot grant it additional capabilities. A human-controlled grant remains the only identified route beyond the floor.

## Verification

- `powershell -ExecutionPolicy Bypass -File scripts\test-isolated.ps1 -Filter worker` — exit 0 against isolated `oikonomos_test`; relevant `src/workspaceTools.test.ts` passed 7/7. Expected sandbox-error logging appeared only in tests that intentionally exercise reaper release/sweep failures; no test failed.
- `git status --short` — only this dossier modified.
