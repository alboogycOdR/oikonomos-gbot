# TASK-089 — infra/compose — the Office: durable environment, named volumes, durability canary

**Assigned_To:** S5 · **Depends_On:** —

## Brief

Build the Office: a long-lived per-tenant container whose durable state lives on named volumes, with the four lifecycle verbs (provision / rebuild / recover / restore) and — the centre of the task — a durability canary that proves the tiers behave.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §2.1 (F1), §2.2 (F2 durability tiers + canary), §2.3 (F3 lifecycle verbs), §4.3 layer 1, §9 OIK-205; CLAUDE.md control-liveness; docs/decisions/ADR-005-control-liveness.md

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`infra/compose/docker-compose.office.yml, infra/compose/office/**`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

The strongest control in the whole design is an omission: `oikonomos-secrets` is not mounted into the model container at all. Prove it from inside that container. The durability canary must survive a REAL rebuild and assert both halves — D1 marker present with an identical digest, D2 marker gone. Checking that the compose file lists a volume is the inert-control failure ADR-005 exists for and will be rejected. There is no checkpoint/resume (probe Q3): in-flight work is cancelled, never suspended.

## Work Log

- [2026-09-02T00:30:00Z] Session resumed after PreCompact checkpoint (checkpoint was stale — pointed at TASK-090, which had already merged; my active claim per PLAN.md is TASK-089, unstarted). Branch `task/TASK-089-s5` did not exist; created it off `7e06d3b` (the claim commit). Read §0, §2.1–2.3, §4.1, §4.3 of the addendum plus the existing `infra/compose/*.yml` and `infra/backup/*.sh` conventions (self-contained shell drills using disposable Docker resources, isolated by unique project/volume suffixes, torn down on exit — reused that pattern here).
- Implemented `infra/compose/docker-compose.office.yml`: two services, `office-model` (D1 workspace volume only) and `office-browser` (D1 + D3 secrets volume) — D3 is structurally absent from office-model's namespace, no mount to remove/misconfigure. Both use `${OFFICE_PROJECT}` for container naming so test runs can be fully isolated from a real tenant environment.
- Implemented the four lifecycle verbs under `infra/compose/office/`: `provision.sh`, `rebuild.sh` (force-recreate, D1/D3 reattached, D2 discarded), `recover.sh` (forced rm+recreate for an unreachable instance, same durable-state contract as rebuild), and `restore.sh` (wipes+repopulates the D1 volume from a `snapshot.sh` tar archive with a sha256 manifest, modelled directly on `infra/backup/backup.sh`/`restore-drill.sh`'s checksum-manifest pattern). Each verb prints which tiers it preserves/discards, per AC. `restore.sh` prints the explicit data-loss warning every run; README.md documents it in its own section too.
- Implemented `durability-canary.sh` — the mandatory liveness assertion: writes a digest-bearing marker into D1 (`/oikonomos/workspace/CANARY_D1`) and D2 (`/tmp/CANARY_D2`) inside `office-model`, runs a REAL `rebuild.sh` (not a simulation), then asserts D1 marker present with identical digest AND D2 marker gone. Also asserts D3 absence from inside `office-model` both pre- and post-rebuild (`test -e /oikonomos-secrets` fails both times) — proves layer 1 of N13 by executing against real container state, not by reading the compose file.
- Implemented `test-office-lifecycle.sh`, a self-contained drill (same shape as `infra/backup/test-drill.sh`): spins up an isolated `OFFICE_PROJECT`, runs `provision` → `durability-canary` → `recover` (asserts D1 marker survives) → `snapshot` → write-after-snapshot → `restore` (asserts the post-snapshot write is lost but the pre-snapshot marker survives) → tears everything down. **Ran it for real against Docker Desktop** (no simulation) — full output captured, ended `OFFICE_LIFECYCLE_TEST_PASSED`; confirmed zero leftover volumes/containers afterward (`docker volume ls` / `docker ps -a` both empty for the test project).
- Verified `docker-compose.local.yml` / `docker-compose.prod.yml` have zero diff against master (git diff --stat empty).
- Test evidence: `pnpm -r test` — full run 0 failed (one transient `packages/db` deadlock on the first run reproduced as flaky-under-parallelism, re-ran `pnpm --filter @oikonomos/db test` standalone → 107/107 pass; second full `pnpm -r test` run also 0 failed; the failing test/file is untouched by this diff regardless). `pnpm lint` exit 0. `pnpm canaries` 17/17 pass.
- Status: needs_review. Territory: `infra/compose/docker-compose.office.yml` + `infra/compose/office/**` + this dossier only.

