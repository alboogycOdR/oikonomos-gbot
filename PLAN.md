---
plan_version: 1.1
last_updated: 2026-08-14T16:58:00Z
overall_status: in_progress
orchestrator_notes: "Plan v1.1 — REVIEW COMPLETE 16:58Z (opus-4-8): Wave 1 DONE. TASK-001 (GB) and TASK-002 (CX) both APPROVED first-pass and merged --no-ff to master (ac55f31, c8ca135); branches deleted; dossiers landed. Verification was independent, not builder-claim: TASK-001 pnpm install/typecheck/build/test all exit 0 (15 projects resolved, 14/14 tests) re-run in wt-grok worktree; TASK-002 validated on live Docker Postgres 16 (extensions vector+pgcrypto, 8/8 tables, single mandated HNSW index, append-only UPDATE 0/DELETE 0 assertion passed, down→0, idempotent re-apply) — schema is verbatim-faithful to Synthesis §5.1, layout verbatim to Handover §3. Both matched Test_Evidence exactly. WAVE B NOW ELIGIBLE (all Depends_On TASK-001 satisfied): TASK-003 (S5, shared canonical JSON), TASK-004 (GB, CI+banned-mode grep, PROTECTED infra/ci — GB author/ORCH-opus reviewer satisfies different-model rule), TASK-005 (CX, lint rules N9/policy-zero-I/O). TASK-006 needs TASK-001+TASK-002 (both done) but stays TBD backlog until assigned. NEXT: /devteam-dispatch Wave B. Prior v1.0 status/planning note follows. Decomposed from specs/OIKONOMOS_BUILD_DIRECTIVE_v1.0.md (Master WBS + Addendum A backlog). Critical path E1→E2→E3→E4→G-GOV. Wave A (dispatch now): TASK-001 (GB, scaffold) + TASK-002 (CX, data layer bootstrap) — territories disjoint, TASK-002 is deliberately Node-free so it cannot collide with the scaffold. Wave B (eligible when TASK-001 is done): TASK-003 (S5, shared canonical JSON), TASK-004 (GB, CI + banned-mode grep per ADR-002 §4), TASK-005 (CX, lint rules N9/policy-zero-I/O). Backlog TBD: TASK-006 (db typed layer + seed), TASK-007 (policy tier resolution — PROTECTED, never assign S5; GB or CX only, per directive §3 different-model review rule). Prior plan v2.5 content was DEVDEPARTMENT pack history (ATLAS tasks), removed at decompose; recoverable at commit 0c6d341. control.mode=strict: builders never write this file — emit devteam-control blocks."
---

# Project Plan

Coordination blackboard for ORCH (Claude Code), GB (Grok Build), CX (Codex AI), S5 (Sonnet 5 headless).
Rules: `AGENTS.md` (summary) and `docs/COORDINATION_PROTOCOL.md` (authoritative).
Status lifecycle: `pending → claimed → in_progress → needs_review → done`, `blocked` from claimed/in_progress. Builders never set `done`.
control.mode is **strict**: builders never edit PLAN.md — the dispatcher claims, the supervisor applies state from your fenced `devteam-control` block (docs/CONTROL.md).

## Work Items

### TASK-001
**Title:** OIK-001 — Monorepo scaffold (pnpm workspaces, Node 22, TS strict)
**Status:** done
**Assigned_To:** GB
**Priority:** critical
**Spec_References:** specs/OIKONOMOS_BUILD_DIRECTIVE_v1.0.md §1; docs/architecture/OIKONOMOS_Master_Work_Breakdown_v1.0.md §5 E1 OIK-001; docs/architecture/OIKONOMOS_Build_Handover_Package_v1.0.md §3
**Owned_Paths:** package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig.base.json, vitest.workspace.ts, .npmrc, .nvmrc, .editorconfig, packages/*/package.json, packages/*/tsconfig.json, packages/*/vitest.config.ts, packages/*/src/index.ts, services/*/package.json, services/*/tsconfig.json, services/*/src/index.ts
**Depends_On:** —
**Description:** Single-owner integration task — the workspace skeleton every later task builds inside. Create the pnpm monorepo exactly per Build Handover §3: ten packages (broker, policy, approvals, audit, agent-providers, harness-factory, db, connectors, memory, shared) and four services (control-api, worker, gateway-telegram, workspace) as minimal compiling stubs (package.json, tsconfig extending tsconfig.base.json, src/index.ts). Node 22 (engines + .nvmrc), TypeScript strict everywhere, Vitest wired at the workspace level. apps/dashboard and apps/mobile are E9 work — do NOT scaffold them now. Do not add lint rules (TASK-005) or CI (TASK-004). Commit the lockfile. Root .gitignore is ORCH-owned and already covers node_modules/dist — do not edit it; if you need an ignore entry, note it and block if essential.
**Acceptance_Criteria:**
- [x] `pnpm install` succeeds from a clean checkout; `pnpm-lock.yaml` committed (WBS OIK-001 "workspace graph resolves")
- [x] `pnpm -r typecheck` and `pnpm -r build` green across all 14 workspaces (WBS OIK-001 "All packages build; typecheck clean")
- [x] `tsconfig.base.json` has `strict: true`; every workspace extends it; no workspace overrides strict off (CLAUDE.md "Strict TypeScript")
- [x] Workspace layout matches Build Handover §3 names exactly — packages: broker, policy, approvals, audit, agent-providers, harness-factory, db, connectors, memory, shared; services: control-api, worker, gateway-telegram, workspace
- [x] `pnpm -r test` runs (stub test per workspace acceptable) under Vitest
- [x] Node 22 pinned: `engines.node` >=22, `.nvmrc` present (Handover §3 "Node 22 LTS")
**Branch:** task/TASK-001-gb
**Started_At:** 2026-08-14T14:26:48Z
**Progress_Notes:**
- [2026-08-14T14:38:31Z] [SV:GB] pnpm monorepo scaffold complete: 10 packages + 4 services as compiling stubs, Node 22, TS strict, Vitest in-source stubs, lockfile committed. Branch task/TASK-001-gb @ d9c0b8e.
**Artifacts:** package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig.base.json, vitest.workspace.ts, .npmrc, .nvmrc, .editorconfig, packages/*/package.json, packages/*/tsconfig.json, packages/*/vitest.config.ts, packages/*/src/index.ts, services/*/package.json, services/*/tsconfig.json, services/*/src/index.ts, dossiers/TASK-001.md
**Test_Evidence:** pnpm install exit 0 (15 projects, lockfile written). pnpm -r typecheck exit 0 (14/14 tsc --noEmit). pnpm -r build exit 0 (14/14 tsc). pnpm -r test exit 0 — 14/14 workspaces, 1 in-source test each, 14 passed / 0 failed (Vitest 3.2.7). tsconfig.base.json strict:true; no workspace sets strict:false. .nvmrc=22; engines.node>=22 on every package.json.
**Review_Findings:** APPROVED first-pass (ORCH opus-4-8, 2026-08-14T16:58Z). Territory clean (61 files all in Owned_Paths + own dossier), preflight c8b9872 evidence in dossier, no PLAN.md edits on branch. Layout verbatim to Handover §3 (10 pkgs + 4 svcs). strict:true with no overrides, engines>=22 on all 15, in-source test on all 14. Independent re-run in wt-grok worktree: install/typecheck/build/test all exit 0, 14/14 tests — matches Test_Evidence. Merged ac55f31, branch deleted. Non-blocking: scaffold stubs carry one placeholder test each — real logic arrives in later E-tasks (expected).
**Blocked_Reason:** —
**Updated_By:** ORCH
**Updated_At:** 2026-08-14T16:58:00Z

### TASK-002
**Title:** OIK-011/012/013 (local scope) — Postgres 16 + pgvector compose, schema v1 migrations, append-only audit
**Status:** done
**Assigned_To:** CX
**Priority:** critical
**Spec_References:** specs/OIKONOMOS_BUILD_DIRECTIVE_v1.0.md §1; docs/architecture/OIKONOMOS_Master_Work_Breakdown_v1.0.md §5 E2 OIK-011, OIK-012, OIK-013; docs/architecture/OIKONOMOS_Platform_Synthesis_Spec_v0.1.md §5.1; docs/architecture/OIKONOMOS_Build_Handover_Package_v1.0.md §8
**Owned_Paths:** infra/compose/**, infra/postgres/**
**Depends_On:** —
**Description:** Data-layer bootstrap, deliberately Node-free so it runs concurrently with TASK-001 (no package.json, no npm deps — plain SQL + shell/psql + docker compose only; the typed query layer is TASK-006). Deliver: (1) `infra/compose/docker-compose.local.yml` — Postgres 16 with pgvector, localhost-bound, named volume; plus a `docker-compose.prod.yml` variant whose port binding is written for Tailscale-interface-only exposure with a comment noting live verification happens on clawsrv (ops step, out of this task's scope — Handover §8). (2) Numbered SQL migrations in `infra/postgres/migrations/` (NOT under packages/ — territory isolation from TASK-001's workspace scaffold; TASK-006's typed layer will consume them from there) implementing Synthesis Spec §5.1 exactly: enums task_status, run_status, risk_tier, approval_status; tables tasks, runs, capabilities, role_grants, approvals, audit_events, profile_facts, knowledge_chunks; all §5.1 indexes. (3) Append-only enforcement on audit_events (OIK-013): rules/triggers making UPDATE and DELETE provable no-ops. (4) `infra/postgres/scripts/` — apply/verify shell scripts (psql-based, idempotent re-run) and a SQL test script proving the append-only property and pgvector availability. Schema questions: Synthesis §5.1 is authoritative for v1 — do not improvise columns; a §5.1 ambiguity is a SPEC_AMBIGUITY block, not a judgment call.
**Acceptance_Criteria:**
- [x] `docker compose -f infra/compose/docker-compose.local.yml up -d` yields a healthy Postgres 16 with `CREATE EXTENSION vector` live (WBS OIK-011 "pgvector extension live")
- [x] Apply script creates every §5.1 enum, table, and index; re-running it is a no-op (WBS OIK-012 "idempotent"); down/reversal scripts exist per migration (WBS OIK-012 "reversible")
- [x] UPDATE and DELETE on audit_events are provable no-ops — test script demonstrates row survives both, and the attempt is not an error that breaks callers (WBS OIK-013)
- [x] Prod compose variant binds Postgres to a Tailscale-only interface by config, with the clawsrv live-verification step documented as deferred ops (WBS OIK-011 acceptance noted as environment-bound; Handover §8)
- [x] Zero Node/npm dependencies introduced anywhere in Owned_Paths (territory-isolation constraint, this plan)
- [x] No credentials anywhere — compose uses env-var references with a `.env.example` carrying obvious placeholders only (N4)
**Branch:** task/TASK-002-cx
**Started_At:** 2026-08-14T14:27:03Z
**Progress_Notes:**
- [2026-08-14T14:45:00Z] [ORCH] State repaired by ORCH: CX completed the task (commits a2a852c feat + 50d43a9 dossier evidence on task/TASK-002-cx, work log says "Ready for review") but its devteam-control block was lost to a dispatch.ps1 stdout-capture bug (codex stderr banner aborted the log pipeline under EAP=Stop; fixed same day in dispatch.ps1). Status set to needs_review by ORCH per the dossier evidence — no protocol violation by CX.
**Artifacts:** infra/compose/docker-compose.local.yml, infra/compose/docker-compose.prod.yml, infra/compose/.env.example, infra/postgres/migrations/001_schema_v1.up.sql, infra/postgres/migrations/001_schema_v1.down.sql, infra/postgres/scripts/apply.sh, infra/postgres/scripts/revert.sh, infra/postgres/scripts/verify.sh, infra/postgres/scripts/test.sh, infra/postgres/scripts/test-append-only.sql, dossiers/TASK-002.md
**Test_Evidence:** [from dossiers/TASK-002.md work log, 14:42:00Z] Isolated compose project oikonomos-task002-test: up -d --wait healthy (Postgres 16); local/prod `docker compose config` rendered 127.0.0.1:5432 and the Tailscale address respectively. 001_schema_v1.up.sql applied twice (second run only expected "already exists" notices); vector extension, all 8 §5.1 tables, 1 HNSW index verified. test-append-only.sql → UPDATE 0, DELETE 0, "append-only assertion passed", vector cast OK. Down migration → 0 tables, clean reapply OK. bash -n clean on all four scripts. Test project resources removed after validation.
**Review_Findings:** APPROVED first-pass (ORCH opus-4-8, 2026-08-14T16:58Z). Territory clean (infra/compose/** + infra/postgres/** + own dossier, no PLAN.md edits), preflight c8b9872 evidence in dossier. Schema verified verbatim against Synthesis §5.1 via spec extraction: 4 enums (values identical), 8 tables (columns/types/FKs/UNIQUE identical), the ONE mandated HNSW index on knowledge_chunks.embedding vector_cosine_ops, 2 append-only rules (DO INSTEAD NOTHING) — no missing/improvised columns or indexes. Independent live validation on Docker Postgres 16 (fresh container, host-port-isolated): extensions vector+pgcrypto live, 8/8 tables, idempotent second apply, append-only UPDATE 0/DELETE 0 assertion passed, down→0 tables. N4 clean (.env.example placeholders CHANGE_ME_LOCAL_ONLY only). Prod compose binds ${TAILSCALE_POSTGRES_HOST} with clawsrv verification documented as deferred ops. Merged c8ca135, branch deleted.
**Blocked_Reason:** —
**Updated_By:** ORCH
**Updated_At:** 2026-08-14T16:58:00Z

### TASK-003
**Title:** OIK-017/018 — packages/shared: canonical JSON + sha256 action digest
**Status:** pending
**Assigned_To:** S5
**Priority:** high
**Spec_References:** specs/OIKONOMOS_BUILD_DIRECTIVE_v1.0.md §1, §4; docs/architecture/OIKONOMOS_Master_Work_Breakdown_v1.0.md §5 E3 OIK-017, OIK-018; docs/architecture/OIKONOMOS_Build_Handover_Package_v1.0.md §4.3
**Owned_Paths:** packages/shared/src/**, packages/shared/test/**, packages/shared/README.md
**Depends_On:** TASK-001
**Description:** The single canonical-JSON + digest implementation for the whole platform (N10 — no reimplementation will ever be permitted elsewhere, so precision here is everything; this is why the task goes to the careful-reading builder). Implement per Handover §4.3: canonical form = sorted keys, no whitespace, UTF-8, numbers in shortest round-trip form; `action_digest = sha256(canonicalJson({toolName, input, destination}))`. Document the byte-level spec in packages/shared/README.md (WBS OIK-018 "documented byte-level spec") — edge cases explicitly: unicode normalization stance, -0 vs 0, exponent form, null vs absent keys, nested arrays/objects, non-finite numbers (reject). Node crypto only — zero runtime dependencies. packages/shared's package.json/tsconfig belong to TASK-001; if a manifest change is essential, block with OWNERSHIP_CONFLICT rather than editing it.
**Acceptance_Criteria:**
- [ ] Property tests prove stability under key order, unicode content, number forms, and nesting — same value object always yields byte-identical canonical JSON and digest (WBS OIK-017 acceptance)
- [ ] Digest reproducible across processes: test spawns a child process and compares digests (WBS OIK-018 "reproducible across processes")
- [ ] No collisions across the fixture set; fixtures contain no credential-like values (WBS OIK-017; N4)
- [ ] Non-finite numbers and undefined reject with a typed error, not silent coercion (fail-closed posture, directive §4)
- [ ] README byte-level spec covers every edge case above (WBS OIK-018)
- [ ] Zero runtime dependencies; strict types, no `any` (CLAUDE.md)
**Branch:** —
**Started_At:** —
**Progress_Notes:** —
**Artifacts:** —
**Test_Evidence:** —
**Review_Findings:** —
**Blocked_Reason:** —
**Updated_By:** ORCH
**Updated_At:** 2026-08-14T14:08:59Z

### TASK-004
**Title:** OIK-002/004/007 — CI skeleton, banned-mode grep (N2 per ADR-002 §4), secret scanning ⚑ protected
**Status:** claimed
**Assigned_To:** GB
**Priority:** critical
**Spec_References:** specs/OIKONOMOS_BUILD_DIRECTIVE_v1.0.md §1, §4, §6; docs/architecture/OIKONOMOS_Master_Work_Breakdown_v1.0.md §5 E1 OIK-002, OIK-004, OIK-007; docs/decisions/ADR-002-permission-bypass-ban-scope.md §4
**Owned_Paths:** .github/**, infra/ci/**
**Depends_On:** TASK-001
**Description:** PROTECTED PATH (infra/ci) — author is GB, review is ORCH on opus-4-8: different-model rule satisfied. Three deliverables. (1) CI skeleton (OIK-002): GitHub Actions workflow running lint, typecheck, test, build on every PR; each job also invocable locally (`pnpm run ci:*` mirrors) since the repo has no remote yet — local runnability is the verifiable acceptance. (2) Banned-mode grep (OIK-004) implemented exactly per ADR-002 §4: matches `bypassPermissions`, `acceptEdits`, AND `--dangerously-skip-permissions`; allowlist ONLY the ADR-002 §2 dev-tooling paths (autopilot.json, CLAUDE.md DEVDEPARTMENT appendix, AGENTS.md, docs/**, .claude/commands/**, briefings/**, scripts/**) plus docs/decisions/**; allowlist lives beside the grep and cites ADR-002. Include self-tests: a fixture violation in a temp packages/ path fails; the current repo passes. (3) Secret scanning (OIK-007): pre-commit + CI job; test fixture uses an OBVIOUSLY fake pattern (e.g. structured like a key but containing PLACEHOLDER text) — never a realistic-looking value (N4; the DEVDEPARTMENT secret-scan hook will mechanically block realistic ones).
**Acceptance_Criteria:**
- [ ] Workflow defines lint/typecheck/test/build jobs, triggered on PR and push; any red job fails the run (WBS OIK-002)
- [ ] Each CI job runnable locally via pnpm script and demonstrated green (local mirror of WBS OIK-002 acceptance, no-remote adaptation)
- [ ] Banned-mode grep fails the build on any occurrence of the three patterns outside the ADR-002 §4 allowlist; self-test proves both the catch and the current-repo pass (WBS OIK-004; ADR-002 §4)
- [ ] Allowlist file cites ADR-002 and contains only §2-enumerated paths + docs/decisions/** (ADR-002 §4)
- [ ] Secret scan blocks a planted obviously-fake fixture key in CI and via pre-commit; no realistic-looking credentials anywhere (WBS OIK-007; N4)
- [ ] No edits outside .github/** and infra/ci/** (protected-path discipline)
**Branch:** task/TASK-004-gb
**Started_At:** 2026-08-14T15:08:22Z
**Progress_Notes:** —
**Artifacts:** —
**Test_Evidence:** —
**Review_Findings:** —
**Blocked_Reason:** —
**Updated_By:** SV
**Updated_At:** 2026-08-14T15:08:22Z

### TASK-005
**Title:** OIK-005/006 — Lint enforcement: no direct query() outside harness-factory (N9); packages/policy zero I/O (lint)
**Status:** claimed
**Assigned_To:** CX
**Priority:** high
**Spec_References:** specs/OIKONOMOS_BUILD_DIRECTIVE_v1.0.md §1, §4; docs/architecture/OIKONOMOS_Master_Work_Breakdown_v1.0.md §5 E1 OIK-005, OIK-006
**Owned_Paths:** eslint.config.mjs, infra/lint/**
**Depends_On:** TASK-001
**Description:** Two custom lint rules that mechanize non-negotiables N9 and the policy-purity rule. (1) OIK-005: any import/call of the Agent SDK `query()` (and the SDK's client entry points) outside `packages/harness-factory` fails lint with an actionable message naming packages/harness-factory as the only sanctioned path. (2) OIK-006: any import of fs, net, http(s), child_process, worker_threads, a DB driver, or process-env access inside `packages/policy` fails lint — policy is pure functions only (CLAUDE.md "zero I/O imports (lint-enforced)"). Implement as an ESLint flat config at root plus custom rules under infra/lint/ with rule unit tests (ESLint RuleTester). Wire `pnpm lint` at root. eslint.config.mjs is a root file: TASK-001 will be done before you start (Depends_On), and no concurrent task owns root config — territory is clean.
**Acceptance_Criteria:**
- [ ] A fixture file calling `query()` outside packages/harness-factory fails lint with the actionable message; the same code inside harness-factory passes (WBS OIK-005)
- [ ] Fixture I/O imports in packages/policy each independently fail lint (fs, net/http, child_process, DB driver, process.env) (WBS OIK-006)
- [ ] RuleTester unit tests cover positive and negative cases for both rules
- [ ] `pnpm lint` runs workspace-wide and is green on the current tree
- [ ] Rules documented in infra/lint/README.md with the N9/policy-purity rationale one-liners
**Branch:** task/TASK-005-cx
**Started_At:** 2026-08-14T15:08:32Z
**Progress_Notes:** —
**Artifacts:** —
**Test_Evidence:** —
**Review_Findings:** —
**Blocked_Reason:** —
**Updated_By:** SV
**Updated_At:** 2026-08-14T15:08:32Z

### TASK-006
**Title:** OIK-014/016 — packages/db: typed query layer, pooling, seed data (inbox-triage)
**Status:** pending
**Assigned_To:** TBD
**Priority:** medium
**Spec_References:** specs/OIKONOMOS_BUILD_DIRECTIVE_v1.0.md §1; docs/architecture/OIKONOMOS_Master_Work_Breakdown_v1.0.md §5 E2 OIK-014, OIK-016; docs/architecture/OIKONOMOS_Platform_Synthesis_Spec_v0.1.md §5.1
**Owned_Paths:** packages/db/src/**, packages/db/test/**, packages/db/seeds/**
**Depends_On:** TASK-001, TASK-002
**Description:** Backlog (TBD — assign at next dispatch). Typed query layer over the TASK-002 schema (migrations live in infra/postgres/migrations — consume, don't relocate): no raw SQL outside packages/db (WBS OIK-014), connection pooling with configured limits (pgbouncer-compatible posture; in-process pool acceptable for v1 with limits configured), and the idempotent seed script for capabilities + role_grants matching the inbox-triage role (WBS OIK-016; tiers must match the Gmail manifest shape in Handover §4.4). Integration tests run against the TASK-002 compose database.
**Acceptance_Criteria:**
- [ ] All schema access goes through typed functions in packages/db; no raw SQL strings outside it (WBS OIK-014)
- [ ] Pool limits configured and documented (WBS OIK-014)
- [ ] Seed script idempotent — double-run yields identical rows; tiers match connector-manifest values (WBS OIK-016)
- [ ] Integration tests green against the local compose Postgres
**Branch:** —
**Started_At:** —
**Progress_Notes:** —
**Artifacts:** —
**Test_Evidence:** —
**Review_Findings:** —
**Blocked_Reason:** —
**Updated_By:** ORCH
**Updated_At:** 2026-08-14T14:08:59Z

### TASK-007
**Title:** OIK-019 — packages/policy: risk-tier resolution, pure functions, 100% branch coverage ⚑ protected
**Status:** pending
**Assigned_To:** TBD
**Priority:** high
**Spec_References:** specs/OIKONOMOS_BUILD_DIRECTIVE_v1.0.md §1, §3, §4; docs/architecture/OIKONOMOS_Master_Work_Breakdown_v1.0.md §5 E3 OIK-019; docs/architecture/OIKONOMOS_Build_Handover_Package_v1.0.md §4.2
**Owned_Paths:** packages/policy/src/**, packages/policy/test/**
**Depends_On:** TASK-005, TASK-006
**Description:** Backlog (TBD — **assignment constraint: GB or CX only, NEVER S5**; protected path, directive §3 different-model review rule). Pure-function risk-tier resolution per Handover §4.2: `effectiveTier = max(capabilities.default_tier, roleGrantOverride)` — more-restrictive-wins; unregistered capability ⇒ deny (fail closed, directive §4). Zero I/O — the TASK-005 lint rule enforces this mechanically. 100% branch coverage is the WBS acceptance bar, not aspiration.
**Acceptance_Criteria:**
- [ ] More-restrictive-wins verified across the full tier matrix (WBS OIK-019; Handover §4.2)
- [ ] Unregistered capability resolves to deny with audit-ready reason value (WBS OIK-019; N3)
- [ ] 100% branch coverage reported by Vitest coverage (WBS OIK-019)
- [ ] Zero I/O imports — lint green under the OIK-006 rule (CLAUDE.md)
**Branch:** —
**Started_At:** —
**Progress_Notes:** —
**Artifacts:** —
**Test_Evidence:** —
**Review_Findings:** —
**Blocked_Reason:** —
**Updated_By:** ORCH
**Updated_At:** 2026-08-14T14:08:59Z
