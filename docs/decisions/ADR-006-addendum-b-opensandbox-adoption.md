# ADR-006 — Addendum B confirmed: OpenSandbox adopted as the E5 isolation runtime

**Status:** Accepted
**Date:** 2026-08-16
**Confirmed by:** Alister (owner), 2026-08-16
**Recorded by:** ORCH
**Supersedes:** `docs/architecture/OIKONOMOS_Master_Work_Breakdown_v1.0.md` §5 E5, in full
**Related:** `docs/specs/OIKONOMOS_WBS_Addendum_B_v1.0.md` §1, §2, §5, §6; `docs/handovers/2026-08-15.md`

---

## 1. Why this ADR exists

Two reasons, and the second is the more important one.

**(a) Document precedence requires it.** CLAUDE.md fixes the order ADRs > Build Handover Package > Gap Closure Plan > Synthesis Spec, and requires an ADR for any decision that conflicts with an existing document. Addendum B supersedes Master WBS §5 E5 in full and retires OIK-046. Until now that supersession lived only in an inline note inside the superseded document itself (`Master_Work_Breakdown` lines 163 and 336) and in a spec addendum — neither of which outranks the Handover Package under the precedence rule. This ADR puts the decision at the top of the order where it belongs.

**(b) A decision was requested in terms no document defined — that is the process defect this ADR closes.** The 2026-08-15 handover instructed the owner to confirm by saying *"reconciliation path (a) confirmed"*. **No document anywhere in this repository defines a reconciliation path (a), (b) or (c).** The options existed only in a prior ORCH session's conversation and were never written down. The owner reasonably confirmed the substance while noting they did not know what form the confirmation should take. That is an ORCH recording failure, not an owner failure: a decision request that survives into a handover must carry its options with it, or the person answering cannot know what they are agreeing to.

**Rule adopted from this:** any decision escalated to the owner is recorded — options, recommendation, and consequences — in a document *before* it is escalated, never solely in session prose. A handover may reference a decision request; it may not be the only place the request exists.

## 2. Decision

Adopt OpenSandbox (opensandbox-group/OpenSandbox, Apache 2.0) as the E5 agent-isolation runtime. Confirmed on the substance recorded in Addendum B §1–§6, specifically:

1. **OpenSandbox replaces hand-built Docker isolation.** Docker backend now, Kubernetes backend at scale — one tool, one API, no migration and no evaluation gate between the two.
2. **OIK-046 (hibernating-workspace evaluation spike) is RETIRED, not deferred.** This is an explicit decision to commit without a bake-off against Daytona or E2B. The reasoning in Addendum B §1 is licence and operational fit (Daytona AGPL flagged; E2B Nomad/Consul-heavy; OpenSandbox Apache 2.0 and Docker-first, lighter to operate solo), plus shipped capability the alternatives would have required building.
3. **A third-party project becomes load-bearing for the isolation boundary.** Accepted knowingly. The project is young and its API surface moves; R14 and R16 below are the mitigations, and they are binding rather than advisory.
4. **Two capabilities pull forward from Phase 3 into the foundation** — Credential Vault (OIK-045a) and per-role egress policy (OIK-045b) — because OpenSandbox ships them. OIK-121 (OpenBao) is **narrowed, not removed**: OAuth session leasing for the browser lane remains its job.
5. **E8 changes with it.** Steel Browser is unchanged as the browser/live-viewer layer but now runs *inside* an OpenSandbox sandbox. OIK-077 is **narrowed, not removed** — it retains the application-layer allowlist as defence in depth beneath OIK-045b's network-layer control.

## 3. Binding constraints

- **R14 — pin a specific release.** Do not track latest. The version is recorded in config, and the SDK-drift watch (OIK-010) is extended to cover OpenSandbox release notes.
- **R16 — Docker backend only.** The Kubernetes path is out of scope until a real multi-tenant or high-concurrency trigger exists. A future move to Kubernetes is a scheduling decision, not a re-architecture, which is the point of adopting one tool for both.
- **Tailscale-bound.** The server is reachable only over Tailscale, verified by a refused connection from a non-Tailscale interface — not by configuration review.
- **Non-negotiable #5 still governs.** Basileia-owned infrastructure only (clawsrv). Adopting a third-party runtime does not widen the account-ownership boundary.

## 4. Consequences

**Unlocks:** TASK-019 (OIK-042) is released from hold and becomes dispatchable. It is the only Addendum B ticket dependency-eligible today — OIK-043/044/045 need OIK-033 (harness-factory, E4), OIK-045a needs OIK-120 (secrets), OIK-045b needs OIK-020.

**Sequencing (Addendum B §6):** OIK-042/043 should run early, in parallel with E2, so E4's harness work lands directly on the isolated runtime instead of being retrofitted onto it.

**New risk accepted, and it is not the usual kind.** TASK-019 is the first task in this project that **deploys a running service to a real host** rather than producing code that CI can verify. Its acceptance criteria are satisfied by the state of a machine, not by a test suite, and a headless builder performing it acts on infrastructure rather than on a worktree. ORCH's standing review method — territory diff, spec check, re-run the tests, mutate the control — does not transfer cleanly to it. Two consequences follow, and they are requirements on the task, not observations about it:

- The Tailscale-only criterion must be proven by an **observed refused connection from a non-Tailscale interface**, in the same spirit as ADR-005 §2: evidence the control emits by doing its job, never configuration that merely looks correct. A firewall rule that is present but not in force is exactly the configured-but-inert class this project has found seven times.
- The deployment must be **reproducible from `infra/sandbox/README.md` alone**. If the only record of how the server came to run is a builder session transcript, the control plane depends on state no document can rebuild.

**Documentation placement:** deployment notes go in `infra/sandbox/README.md`, NOT `docs/runbooks/`. `docs/**` is blocked for builders by the territory firewall, so a runbook written there would be rejected mid-session.

## 5. What this ADR does not decide

- Whether OpenSandbox remains the right choice at fleet scale. R14's pinned release plus the drift watch is the review mechanism; a re-evaluation is a new ADR, not a silent upgrade.
- Isolation-strength selection per tier (OIK-045c) — it depends on OIK-019 and is out of scope here.
- Whether TASK-019 is executed by a builder unit or by the owner directly. See §4: it is a deployment, not a code change, and that question is answered at dispatch time.
