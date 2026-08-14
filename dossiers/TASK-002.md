# TASK-002 — OIK-011/012/013 Data-layer bootstrap (compose + schema v1 + append-only audit)

**Brief:** Postgres 16 + pgvector via docker compose, the Synthesis §5.1 schema as numbered SQL migrations, and append-only enforcement on audit_events. Deliberately Node-free (SQL + shell + compose only) so it runs concurrently with TASK-001's scaffold.

**Spec pointers:** Synthesis Spec §5.1 is THE schema authority — 4 enums (task_status, run_status, risk_tier, approval_status), 8 tables (tasks, runs, capabilities, role_grants, approvals, audit_events, profile_facts, knowledge_chunks), all indexes. WBS OIK-011/012/013 acceptance rows. Handover §8 (environments; Tailscale posture). Ambiguity in §5.1 = SPEC_AMBIGUITY block, never improvise.

**Intended approach:** infra/compose/docker-compose.local.yml (pgvector/pgvector:pg16 image or equivalent, localhost bind, named volume, healthcheck) + docker-compose.prod.yml (Tailscale-interface bind by config, clawsrv verification documented as deferred ops). infra/postgres/migrations/NNN_*.up.sql/.down.sql (NOT under packages/ — keeps territory disjoint from TASK-001's scaffold). Append-only via trigger raising no-op (or rule) — must not error callers. infra/postgres/scripts/: apply.sh (psql, idempotent via schema_migrations table), verify.sh (asserts extension + append-only property). .env.example placeholders only (N4).

## Work Log

- [2026-08-14T14:38:00Z] [CX] Resumed branch `task/TASK-002-cx`. Preflight output (c8b9872):
  ```text
  [preflight] TASK-002 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-codex-oikonomos
  [preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   infra/compose/**  -> 2 file(s):
             infra/compose/docker-compose.local.yml
             infra/compose/docker-compose.prod.yml
    GLOB   infra/postgres/**  -> 7 file(s):
             infra/postgres/migrations/001_schema_v1.down.sql
             infra/postgres/migrations/001_schema_v1.up.sql
             infra/postgres/scripts/apply.sh
             infra/postgres/scripts/revert.sh
             infra/postgres/scripts/test-append-only.sql
             infra/postgres/scripts/test.sh
             infra/postgres/scripts/verify.sh
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
  Read the implementation and Synthesis Spec §5.1 live; schema columns, enums, rule semantics, and the HNSW index match. Next: exercise compose/SQL scripts against a local container, without destructive shared-infrastructure operations.

- [2026-08-14T14:42:00Z] [CX] Validation complete in an isolated `oikonomos-task002-test` Docker Compose project. `docker compose ... up -d --wait` reported Postgres 16 healthy; local/prod `docker compose config` rendered `127.0.0.1:5432` and the configured Tailscale address respectively. Applied `001_schema_v1.up.sql` twice in the container (second apply succeeded with only expected “already exists” notices); verified `vector`, all 8 §5.1 tables, and 1 HNSW index. `test-append-only.sql` reported `UPDATE 0`, `DELETE 0`, and `append-only assertion passed`; it also cast a vector successfully. The down migration reduced the eight-table count to `0`, then a clean reapply succeeded. `bash -n` passed for all four host scripts. Removed only the test project’s known container, network, and named volume after validation. Ready for review.
