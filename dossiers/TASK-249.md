# TASK-249 — Workspace-1 follow-on — hosting ADR and migration of control-api, worker and dashboard to an always-on host with boot-without-logon

**Unit:** TBD · **Priority:** medium · **Depends_On:** TASK-240, TASK-245

## Brief
Owner decision D5 keeps the workstation for now and defers this. `docker-compose.prod.yml` defines Postgres only; the watchdog is a logon-triggered Scheduled Task; `clawsrv` is shared (~20 containers, ~5 GB free) and each browser sandbox reserves 2 GB. Write ADR-017 (protected path, different-model review) choosing the host (dedicated box vs `clawsrv` with headroom checks), process supervision with boot-without-logon, credentials provisioning via the existing `secret://` convention, backup/rollback, and the sandbox reachability path; then execute the migration with a real reboot test. Until this lands, every 24/7 or device-off claim stays withheld (§10).

## Spec pointers
specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md §9.5; ADR-010; docs/runbooks/service-supervision.md; owner decision D5

Read `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §1 first for the product shape and §10 for what must not be claimed. The independent review that produced this wave (verdict, disposition matrix, execution proposal) is at `E:\DELL-PROJECTS\GROKBOT-RESEARCH-DOCS\ORCH_REVIEW\` — read the rows cited in Spec_References; do not treat the advisory documents themselves as spec.

## Intended approach
Owner decision D5 keeps the workstation for now and defers this. `docker-compose.prod.yml` defines Postgres only; the watchdog is a logon-triggered Scheduled Task; `clawsrv` is shared (~20 containers, ~5 GB free) and each browser sandbox reserves 2 GB. Write ADR-017 (protected path, different-model review) choosing the host (dedicated box vs `clawsrv` with headroom checks), process supervision with boot-without-logon, credentials provisioning via the existing `secret://` convention, backup/rollback, and the sandbox reachability path; then execute the migration with a real reboot test. Until this lands, every 24/7 or device-off claim stays withheld (§10).

## Owned_Paths
docs/decisions/ADR-017-application-hosting.md, infra/compose/**, docs/runbooks/**

## Work Log
