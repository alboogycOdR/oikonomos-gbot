# TASK-002 — OIK-011/012/013 Data-layer bootstrap (compose + schema v1 + append-only audit)

**Brief:** Postgres 16 + pgvector via docker compose, the Synthesis §5.1 schema as numbered SQL migrations, and append-only enforcement on audit_events. Deliberately Node-free (SQL + shell + compose only) so it runs concurrently with TASK-001's scaffold.

**Spec pointers:** Synthesis Spec §5.1 is THE schema authority — 4 enums (task_status, run_status, risk_tier, approval_status), 8 tables (tasks, runs, capabilities, role_grants, approvals, audit_events, profile_facts, knowledge_chunks), all indexes. WBS OIK-011/012/013 acceptance rows. Handover §8 (environments; Tailscale posture). Ambiguity in §5.1 = SPEC_AMBIGUITY block, never improvise.

**Intended approach:** infra/compose/docker-compose.local.yml (pgvector/pgvector:pg16 image or equivalent, localhost bind, named volume, healthcheck) + docker-compose.prod.yml (Tailscale-interface bind by config, clawsrv verification documented as deferred ops). infra/postgres/migrations/NNN_*.up.sql/.down.sql (NOT under packages/ — keeps territory disjoint from TASK-001's scaffold). Append-only via trigger raising no-op (or rule) — must not error callers. infra/postgres/scripts/: apply.sh (psql, idempotent via schema_migrations table), verify.sh (asserts extension + append-only property). .env.example placeholders only (N4).

## Work Log
