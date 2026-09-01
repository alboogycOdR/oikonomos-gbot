-- TASK-085 / Addendum F §3.3 (F6).
-- Extends the EXISTING profile_facts table (does not create a parallel
-- store — four-fifths of the shape already exists per F6) with the columns
-- the three-scope / three-tier memory model needs: role_id (required when
-- scope='agent'), project_id (optional, used by scope='project'), and tier
-- (profile | log | note, defaulting to 'profile' for backward compatibility
-- with any pre-existing rows). Does NOT touch roles/role_routines/
-- role_messages/require_approval_rules (TASK-084's tables) or
-- knowledge_chunks.

ALTER TABLE profile_facts ADD COLUMN IF NOT EXISTS role_id text NULL;
ALTER TABLE profile_facts ADD COLUMN IF NOT EXISTS project_id text NULL;
ALTER TABLE profile_facts ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'profile';

-- F6: role_id must be present exactly when scope is 'agent' — this is the
-- mechanical half of "a role cannot read another role's agent-scope memory
-- at all" (the other half is the query layer never accepting a query
-- without a role_id filter on scope='agent' reads).
DO $$ BEGIN
  ALTER TABLE profile_facts
    ADD CONSTRAINT profile_facts_agent_scope_role_id_check
    CHECK ((scope = 'agent') = (role_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE profile_facts
    ADD CONSTRAINT profile_facts_tier_check
    CHECK (tier IN ('profile', 'log', 'note'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Widen the unique key from (tenant_id, scope, key) to include role_id and
-- project_id so the same key can independently exist per-role, per-project,
-- and per-user without colliding. Drop only if the old constraint is still
-- there (a repeat `up` run after this migration already succeeded once
-- would otherwise throw "constraint does not exist").
DO $$ BEGIN
  ALTER TABLE profile_facts DROP CONSTRAINT profile_facts_tenant_id_scope_key_key;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- A plain multi-column UNIQUE constraint would NOT catch two user-scope
-- rows sharing (tenant_id, key): standard SQL unique semantics treat every
-- NULL as distinct from every other NULL, and role_id/project_id are both
-- NULL for scope='user'. Coalescing to '' inside a unique EXPRESSION index
-- makes two NULLs collide as intended, so "one value per key per scope"
-- actually holds for every scope, not just 'agent'.
DROP INDEX IF EXISTS profile_facts_tenant_scope_role_project_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS profile_facts_tenant_scope_role_project_key_key
  ON profile_facts (tenant_id, scope, COALESCE(role_id, ''), COALESCE(project_id, ''), key);

CREATE INDEX IF NOT EXISTS profile_facts_tier_idx ON profile_facts (tier);
CREATE INDEX IF NOT EXISTS profile_facts_role_id_idx ON profile_facts (role_id);
