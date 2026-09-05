# TASK-176 — G-01a — Skills primitive: schema, migration, typed query layer (packages/db)

## Brief

Create the Skills store. Table `skills(skill_id uuid PK, tenant_id text NOT NULL DEFAULT 'basileia', name text NOT NULL, description text NOT NULL, when_to_use text, body text NOT NULL, inputs jsonb NOT NULL DEFAULT '[]', access jsonb NOT NULL DEFAULT '[]', approvals jsonb NOT NULL DEFAULT '[]', failure_policy jsonb NOT NULL DEFAULT '{}', version int NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'active', created_at, updated_at)` with UNIQUE(tenant_id, name) and name constrained to `^[a-z0-9][a-z0-9-]{1,63}$` (it is the `/name` slash token). Table `role_skills(role_id text REFERENCES roles, skill_id uuid REFERENCES skills, enabled boolean NOT NULL DEFAULT true, PRIMARY KEY(role_id, skill_id))` — the per-Bot enable list. Typed layer in skills.ts following routines.ts conventions exactly (row interface, column list, mapper, create/get/list/update/setEnabledForRole/listEnabledForRole). Add a `Skill` export to index.ts. NOT in scope: API routes, prompt injection, UI, routine binding (TASK-177/178/182). Migration numbering: 013 is the latest; use 014.

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-01; docs/research/grok-bot-technical-report-and-replication-blueprint-2026-09-05.md §12.3 schemas/skill.yaml; docs/research/grok-bot-technical-report-2026-09-05.pdf §3.4 (six-part structure); Addendum F §3.2 N12 (a skill body is prompt material, never a control)

## Territory

infra/postgres/migrations/014_skills.up.sql, infra/postgres/migrations/014_skills.down.sql, packages/db/src/skills.ts, packages/db/src/skills.test.ts, packages/db/src/index.ts

Depends_On: —

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log
