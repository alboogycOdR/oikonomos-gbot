-- Reverse 005_agent_memory.up.sql. Restores profile_facts to its 001 shape:
-- drops the widened unique index and the two new CHECK constraints, then
-- the three added columns, then restores the original (tenant_id, scope,
-- key) unique constraint. Does not touch any other table.

DROP INDEX IF EXISTS profile_facts_tenant_scope_role_project_key_key;

ALTER TABLE profile_facts DROP CONSTRAINT IF EXISTS profile_facts_tier_check;
ALTER TABLE profile_facts DROP CONSTRAINT IF EXISTS profile_facts_agent_scope_role_id_check;

DROP INDEX IF EXISTS profile_facts_role_id_idx;
DROP INDEX IF EXISTS profile_facts_tier_idx;

ALTER TABLE profile_facts DROP COLUMN IF EXISTS tier;
ALTER TABLE profile_facts DROP COLUMN IF EXISTS project_id;
ALTER TABLE profile_facts DROP COLUMN IF EXISTS role_id;

DO $$ BEGIN
  ALTER TABLE profile_facts
    ADD CONSTRAINT profile_facts_tenant_id_scope_key_key UNIQUE (tenant_id, scope, key);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
