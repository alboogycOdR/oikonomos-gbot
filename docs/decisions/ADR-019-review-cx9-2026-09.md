# ADR-019 adversarial review — CX9, 2026-09

**Subject:** `docs/decisions/ADR-019-project-entity-and-manager-role.md` at commit `6f2c57e12627bd47b2c3579be3d87766699035e5`

**Reviewer:** CX9 / Codex (GPT), a non-Anthropic model and therefore independent of the Fable 5.1 author.

**Verdict:** **Accept-with-changes.** The Project data model and manager-as-role boundary are sound, but disabled project capabilities and multi-axis budget enforcement need the changes below before the ADR can be accepted.

Evidence below was verified against the cited source at the subject commit; it is not inferred from the ADR's description of that source.

---

## Review questions

### Q1 — Can a manager reach `roles` or `role_grants` writes via current tools?

**Not through the currently mounted workspace MCP tools, but the ADR needs an end-to-end invariant.** The live workspace bridge exposes only `send_to_role`, `rename_self`, `request_secret` and `create_routine` ([`services/worker/src/workspaceMcpServer.ts:70`](../../services/worker/src/workspaceMcpServer.ts#L70)-[`76`](../../services/worker/src/workspaceMcpServer.ts#L76)); its handlers respectively persist a role message, secret request, routine, or update only the caller's name ([`83`](../../services/worker/src/workspaceMcpServer.ts#L83)-[`112`](../../services/worker/src/workspaceMcpServer.ts#L112)). `sendToRole` itself performs exactly its one message persistence ([`services/workspace/src/mailbox.ts:79`](../../services/workspace/src/mailbox.ts#L79)-[`115`](../../services/workspace/src/mailbox.ts#L115)); `createRoutine` inserts only into `role_routines` ([`packages/db/src/routines.ts:126`](../../packages/db/src/routines.ts#L126)-[`158`](../../packages/db/src/routines.ts#L158)).

That evidence supports the narrow present-tense claim. It does not prove the future project MCP server cannot reach direct DB calls, control-api routes, or a newly mounted connector. The existing human routes do directly create roles and grants ([`services/control-api/src/app.ts:1075`](../../services/control-api/src/app.ts#L1075)-[`1105`](../../services/control-api/src/app.ts#L1105), [`1150`](../../services/control-api/src/app.ts#L1150)-[`1165`](../../services/control-api/src/app.ts#L1165)), so the manager path must be positively separated rather than assumed safe because today's four-tool bridge lacks those verbs.

### Q2 — Is declared-but-disabled enforced both at registry construction (including C5 tier drift) and at L1?

**Unsound as written.** Construction verifies non-empty declarations, duplicate names, declaration syntax, persisted adapter ownership and default-tier equality ([`packages/broker/src/capabilityRegistry.ts:114`](../../packages/broker/src/capabilityRegistry.ts#L114)-[`139`](../../packages/broker/src/capabilityRegistry.ts#L139)); it does not compare a persisted `enabled` value with `DeclaredTool.enabled`. It correctly catches C5 tier drift, but it does not establish the claimed disabled state.

`enabledToolNames` filters declarations for a mount list ([`capabilityRegistry.ts:107`](../../packages/broker/src/capabilityRegistry.ts#L107)-[`111`](../../packages/broker/src/capabilityRegistry.ts#L111)), yet the L1 port resolves any declared entry whose *persisted* row is enabled ([`148`](../../packages/broker/src/capabilityRegistry.ts#L148)-[`160`](../../packages/broker/src/capabilityRegistry.ts#L160)). `decidePreToolUse` then treats that result as an ordinary grant/tier decision; its `capability.disabled` result is only the global capability kill switch ([`packages/broker/src/index.ts:501`](../../packages/broker/src/index.ts#L501)-[`570`](../../packages/broker/src/index.ts#L570)). Therefore a disabled declaration accidentally persisted as enabled can pass L1 if a grant exists. The ADR's assertion that “L1 denies `capability.disabled`” is not true at this commit.

### Q3 — Are the project and role budget axes evaluable without a wider TOCTOU than today?

**Needs change.** The current gate is pure and consumes already-read figures ([`packages/broker/src/budgetGate.ts:4`](../../packages/broker/src/budgetGate.ts#L4)-[`15`](../../packages/broker/src/budgetGate.ts#L15)). It reads/checks platform, provider and routine dimensions serially and returns `allow` without reserving spend ([`128`](../../packages/broker/src/budgetGate.ts#L128)-[`167`](../../packages/broker/src/budgetGate.ts#L167)). Adding two more independent reads then spawning a run makes the race broader: concurrent project runs can all observe spend below the project budget; concurrent turns for the same role can do likewise. The Workspace-1 concurrency gate bounds some executions but does not create an atomic budget reservation or protect all project-attributed ingress paths.

## Required changes

1. State an implementation invariant for manager execution: its project MCP server/mount contains no role-creation or grant route, and an integration/liveness test invokes every mounted manager tool then proves no `roles` or `role_grants` write occurred. The test must cover the real broker-to-MCP composition, not only the present workspace bridge.
2. Make declared disabled state an L1 invariant. `CapabilityRegistry.build` must reject persisted enabled-state drift (alongside C5 tier/adapter drift), and `brokerPorts.getCapability` must refuse a declaration with `enabled: false` even if persistence is stale. Return a per-capability disabled denial, not the global-kill-switch meaning currently attached to `capability.disabled`; add construction, direct-L1 and mount-absence tests.
3. Specify an atomic budget admission/reservation protocol: atomically read and reserve (or serialize by) project and role monthly spend before provider spawn, include the reservation in all applicable axis checks, and reconcile/release it exactly once when spend is recorded or the run fails before spend. Test two simultaneous near-limit admissions for each axis and assert at most one provider invocation. This preserves today's gate semantics rather than widening its TOCTOU window.

## Verdict rationale

The Project entity, group-thread binding, typed locator-only handoffs, optional manager, and roster-size fan-out cap have a coherent boundary. Acceptance is conditional because the declared-disabled statement currently relies on mounting behavior rather than verified L1 enforcement, and two new budget dimensions need an atomic admission design before they can be called independent ceilings.
