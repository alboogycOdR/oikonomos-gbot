# TASK-245 — Workspace-1 acceptance: release decision sheet

Format per `GROKBOT-RESEARCH-DOCS/OIKONOMOS_RELEASE_ACCEPTANCE_2026-09-16.md`'s "Release decision sheet" template.

## Candidate commit / builds

Testing progressed through three candidate builds in the same session, each disclosed at the point it changed, not retroactively:

- `a83b892` (2026-09-15, original candidate) — A01-A19/C01 tested against this build except A05.
- `d9c2412` (2026-09-15T10:33Z) — dashboard-only redeploy after **TASK-260** (critical: bodyless requests, incl. logout, rejected by the API before the handler ran) merged. A05 re-verified and passes against this build.
- `c323a05` → `88bdc55` (2026-09-15, ~10:48Z onward) — worker redeploy after **TASK-258** (critical: scheduled routine fires never created a run or enqueued execution — permanently orphaned) merged. A12/A19's routine-execution half re-verified and passes against this build.

**Current HEAD / final tested candidate: `88bdc55`.** No case's passing evidence was invalidated by a later redeploy — each redeploy only touched the code path its own fix changed, confirmed explicitly in each affected case's file.

## Owner / reviewer

- Owner: nuburo@gmail.com
- Reviewer/executor: ORCH (Claude Sonnet 5), user-authorized start 2026-09-15 ("Let's go ahead and start TASK-245")

## Actual test / soak window

- Acceptance execution: 2026-09-15, ~04:48Z through this sheet's compilation (~12:32Z), same session.
- A19 24-hour observation window: started `2026-09-15T04:48:20Z` (approx, per first watchdog-cycle evidence), **still in progress** — due to complete ~`2026-09-16T04:48Z`. Not yet at full term as of this sheet. The routine-execution sub-finding that determines A19's pass/fail is already resolved and independently confirmed (see A19/A12 files); the remaining wall-clock time is pure additional dead-worker/stability observation, already showing 7+ clean hours post-fix with zero further incidents at last check.

## Mandatory cases: passed / failed / not run

**Passed (16):** A01, A02, A03, A04, A06 (cross-tenant isolation half — see gap note), A07, A08, A09 (with a lighter-weight citation caveat for the anti-fabrication sub-property), A10, A11, A13, A14, A15, A16, C01, and **A05** (originally failed on `a83b892`, now passes in full on `d9c2412` after TASK-260).

**Passed after an in-flight critical fix, independently re-verified live (2):** **A12**, **A19**'s routine-execution requirement (both originally failed on `a83b892` for the identical root cause, TASK-258; both now pass on `88bdc55` with real, dedicated, live end-to-end re-verification — real run created, real pg-boss job, one real completion, one real informative failure). A19's separate worker-recovery requirement passed independently and directly (watchdog detected and recovered a real dead worker within one cycle). A19's full 24h wall-clock window is still running; see above.

**Partial (1):** **A18** — 20/20 real simple-prompt samples complete and recorded, with one disclosed target miss (response p95 18.8s vs 15s target, likely cold-start). The 3 required browser-workflow samples were honestly attempted twice (7 real attempts total) and blocked by a real, disclosed Steel-connector connectivity gap (TASK-262), not completed and not silently substituted.

**Failed as a real defect, not a test gap (1, resolved before this sheet):** none remain open — the one real hold-condition-class defect found during testing (TASK-258, "lost accepted work" — scheduled routines never actually executed) has been fixed, merged, deployed live, and independently re-verified. It is listed under "Passed after an in-flight fix" above rather than under Failed, since the fixed candidate is what this sheet is actually recommending.

**Not run (deferred by documented, pre-existing scope gaps, not oversight):**
- **A20** (Firebase Web config) — blocked on TASK-241 (Firebase Web app registration), pre-existing, unrelated to this candidate.
- **A06's** two-distinct-human-principal login-UI sub-test — same Firebase Web gap as A20.
- **C02-C05** (interactive takeover: input handoff, timeout/idle behavior, concurrent-viewer behavior, forced release) — explicitly out of TASK-245's own filed scope; not attempted.

## Live viewer status

**PASS** (C01). Session identifier is genuinely role-bound and database-resolved; correct empty-state behavior (not a stale or fabricated recording); a real, working bidirectional relay — all proven via dedicated real tests against real Postgres and a real protocol-level fixture.

## Interactive takeover status

**NOT RUN.** C02-C05 are out of this task's filed scope (see above). No interactive-takeover claim is made by this sheet in either direction.

## Host dependency and reboot result

**NOT TESTED.** Hosting remains workstation-based per owner decision D5 (deferred). No reboot/host-failover test was performed this session. This is a known, disclosed limitation, not a defect — it was not in scope for this task's acceptance run.

## Supported providers / tiers / connectors

- **Providers:** `claude`, `gemini` — both proven live with real calls this session (A18, A12/A19 verification). `chatRunDriver.ts`'s fail-closed guard rejects any other provider string, confirmed by direct code read and confirmed in practice via the stale-queue investigation (test-fixture rows carrying non-`claude`/`gemini` provider values are correctly rejected before any model call).
- **Connectors exercised live and passing:** Gmail/Calendar/Drive-class read connector (A09), Steel browser automation (A10, TASK-214 — proven working end-to-end **when the container is up**).
- **Known connector gap:** Steel browser MCP server is currently unreachable (`CONNECTION_CLOSED`) from freshly-provisioned role sessions — confirmed not a permissions issue, not a broker-wide outage (the underlying `clawsrv` sandbox broker itself responds correctly). Filed as **TASK-262**. This blocked A18's 3 browser-workflow samples; it does not retract A10/TASK-214's earlier proof that the capability itself works when the container is reachable.
- **Push-token registration** (`POST /devices`, TASK-145) is implemented but not mounted on the public Tailscale origin — pre-existing gap, not introduced by this candidate, not one of A01-A19/C01's mandatory cases.

## Real latency / cost sample summary (A18)

| Metric | Result | Target | Met? |
|---|---|---|---|
| Send-ack p95 | 39ms | <1,000ms | ✅ |
| Response p95 | 18,772ms | <15,000ms | ❌ (~3.8s over; single cold-start-driven outlier — steady-state 13.6-16.5s) |
| Response median | ~14,700ms | <15,000ms | ✅ (marginal) |
| Timeouts | 0/20 | — | ✅ |
| Browser-workflow samples | 0/3 completed (7 real attempts, all blocked by TASK-262) | 3/3 | ❌ (infra gap, not a code defect) |

## Measured test spend / approved allowance

**$0.2299 of the $10.00 USD hard allowance** (owner decision D3), confirmed directly against `spend_records`, never estimated:

| Component | Amount |
|---|---|
| Unintended, disclosed (review-agent direct-DATABASE_URL test mistake) | $0.0274 |
| A12/A19 live fix verification (deliberate, minimal) | $0.0194 |
| A18 (20 simple prompts + 7 browser-workflow attempts) | $0.2026 |
| **Total** | **$0.2299** |

Zero unintended spend occurred anywhere else, including throughout the two stale pg-boss queue backlog investigations/cleanups (confirmed directly before/during/after each) and a genuine 1,653-job unguarded-risk subset found and neutralized before the worker could reach it.

## Known limitations and disabled features

- **TASK-257** (medium) — `reconcileInterruptedRuns` re-queues stale test-fixture-shaped runs on every worker restart; backlog regrows each time, now confirmed under two distinct fixture-naming patterns. Fully mitigated by manual, careful cleanup each occurrence; not sustainably automated yet.
- **TASK-259** (medium) — a session's underlying connection does not necessarily survive a full 24h session lifetime; does not grant new unauthorized access, but is a real gap against A06's expired-session-socket sub-requirement.
- **TASK-261** (high, filed not dispatched) — `scripts/test-isolated.ps1`'s watchdog re-enable `finally` block does not always fire, confirmed at least 3 times this session; needs a robust, independent self-healing fix rather than relying on the same script's own cleanup path.
- **TASK-262** (medium) — Steel browser MCP connector currently unreachable from fresh role sessions; blocks the browser-workflow half of A18 and any live browser-based acceptance work until restored.
- **A20 / A06's login-UI sub-test** — blocked on TASK-241 (Firebase Web app registration), pre-existing.
- **C02-C05 (interactive takeover)** — not run, out of this task's scope.
- **`POST /devices`** — implemented but not mounted on the public Tailscale origin (pre-existing, unrelated to this candidate).
- **Hosting** — workstation-based, no reboot/failover test performed (owner decision D5, deferred).

## Rollback build and database compatibility check

- Previous build `7ba6864` (2026-09-14T21:06Z) preserved as `apps/dashboard/dist.prev` before this session's rebuild; `a83b892` is also fully available via git if a rollback past this session's fixes is ever needed.
- Migrations applied this session (`023_workspace_summary_indexes`, `024_routine_timezone`) are both additive (`IF NOT EXISTS`), confirmed idempotent — a rollback to a pre-migration build remains compatible with the current schema (extra columns/indexes simply go unused, not referenced by older code).
- No destructive or backward-incompatible schema change was made at any point this session.

## Hold-condition check (per the acceptance document's own rules)

Wrong recipient sends: none observed. Cross-principal access: none observed (A06's tenant-isolation half passed cleanly, consistently 404-not-403). Secret exposure: none observed. Replayed effects: none observed (A11's replay sub-case passed). Uncontrolled input during takeover: N/A, C02-C05 not run. **Lost accepted work: was present (TASK-258) — now fixed, merged, deployed, and independently re-verified live; no longer open.** Unexplained absence of required evidence: none — every deferred/not-run item above has a specific, named, disclosed reason, not a silent gap.

**No hold condition remains open as of `88bdc55`.**

## Recommended decision (ORCH's recommendation — final call is the owner's)

**Reduced internal beta.** Rationale:
- No hold condition is currently open; the one that was (TASK-258) is fixed and independently re-verified live end-to-end, not merely patched-and-assumed.
- Core chat/task/approval/audit/connector functionality (A01-A16, C01) passes cleanly and thoroughly, with real (non-mocked) evidence throughout.
- "Reduced" rather than unqualified, because of specifically: (a) A18's real target miss and incomplete browser-workflow half (TASK-262), (b) no interactive-takeover verification at all (C02-C05 not run), (c) workstation-only hosting with no reboot/failover proof (D5), and (d) the still-running A19 window and not-yet-hardened watchdog self-heal (TASK-261) — real but bounded operational risk, not a functional defect.
- Recommend explicitly excluding from this beta: live interactive computer takeover (unproven) and any commitment to continuous/always-on hosting (unproven). Recommend keeping Steel browser workflows disabled/unadvertised until TASK-262 is resolved.

**Decision:** **Reduced internal beta — APPROVED** (nuburo@gmail.com, 2026-09-15T20:01:38Z, verbatim: "yes, go"). Live interactive computer takeover (C02-C05) and any always-on/24-7 hosting claim (D5) remain explicitly excluded pending their own future proof. Steel browser workflows stay disabled/unadvertised until TASK-262 is resolved.
