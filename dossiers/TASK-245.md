# TASK-245 — Workspace-1 — acceptance execution on the integrated candidate, REVIEW.md backfill for TASK-214/224/227–235, decision sheet

**Unit:** TBD · **Priority:** high · **Depends_On:** TASK-236, TASK-237, TASK-238, TASK-239, TASK-240

## Brief
ORCH executes. Run the reworded cases A01–A19 and C01 (mobile) on a recorded candidate SHA built and deployed per TASK-240's runbook, against the isolated database where a database is needed for verification and against the real services for end-to-end cases. Paid runs draw on the R60 allowance (D3) with a ledger from `spend_records`; stop at the allowance. Record per case: SHA, build ids, principal, provider/model, run ids, expected, observed, cost or unknown, cleanup. A20 runs only if TASK-241 has merged; A12's timezone half, A15's in-flight resume and C02–C05 are NOT RUN until TASK-247, TASK-246 and TASK-235 respectively. Backfill REVIEW.md lines for TASK-214, 224, 227, 228, 229, 230, 231, 232, 233, 234, 235 from their PLAN.md evidence before citing them. Complete the decision sheet with the withheld-claims list from §10; a hold condition (wrong recipient, cross-principal read, secret exposure, replay, lost accepted work, missing evidence) blocks the "internal beta" label regardless of pass counts.

## Spec pointers
specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md §8.1–§8.3; GROKBOT-RESEARCH-DOCS/OIKONOMOS_RELEASE_ACCEPTANCE_2026-09-16.md; owner decision D3

Read `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §1 first for the product shape and §10 for what must not be claimed. The independent review that produced this wave (verdict, disposition matrix, execution proposal) is at `E:\DELL-PROJECTS\GROKBOT-RESEARCH-DOCS\ORCH_REVIEW\` — read the rows cited in Spec_References; do not treat the advisory documents themselves as spec.

## Intended approach
ORCH executes. Run the reworded cases A01–A19 and C01 (mobile) on a recorded candidate SHA built and deployed per TASK-240's runbook, against the isolated database where a database is needed for verification and against the real services for end-to-end cases. Paid runs draw on the R60 allowance (D3) with a ledger from `spend_records`; stop at the allowance. Record per case: SHA, build ids, principal, provider/model, run ids, expected, observed, cost or unknown, cleanup. A20 runs only if TASK-241 has merged; A12's timezone half, A15's in-flight resume and C02–C05 are NOT RUN until TASK-247, TASK-246 and TASK-235 respectively. Backfill REVIEW.md lines for TASK-214, 224, 227, 228, 229, 230, 231, 232, 233, 234, 235 from their PLAN.md evidence before citing them. Complete the decision sheet with the withheld-claims list from §10; a hold condition (wrong recipient, cross-principal read, secret exposure, replay, lost accepted work, missing evidence) blocks the "internal beta" label regardless of pass counts.

## Owned_Paths
REVIEW.md, docs/acceptance/**, docs/runbooks/release-workspace-1.md

## Work Log
