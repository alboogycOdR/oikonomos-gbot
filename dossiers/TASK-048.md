# TASK-048 — OIK-052 Wave 1: Gmail connector

## Brief
First real connector through the pipeline: Gmail manifest (readonly + compose; `email.send` present at T3_external but `enabled: false` until Gmail's G-CONN) plus a 3–5 task golden suite scoring ≥90% via the OIK-051 runner.

## Spec pointers
- Build Handover §4.4 — the gmail example IS this manifest; follow it (no gmail.send scope in Wave 1).
- WBS OIK-052 acceptance: "Evals ≥90%; send capability present but `enabled: false`".
- N4/N5: `account_ownership: basileia`; `url_ref` is a secret reference; zero credentials in manifest or fixtures.

## Intended approach
Author `packages/connectors/manifests/gmail.yaml`; build `evals/golden/suites/gmail/` (triage unread, summarise thread, draft reply — draft-only tiers). Run TASK-043 validator + TASK-044 registration against local pg (record both), then the TASK-046 runner with the fake-query seam. ORCH writes `docs/connectors/gmail.md` at review (TASK-047) and rules on G-CONN.

## Work Log
