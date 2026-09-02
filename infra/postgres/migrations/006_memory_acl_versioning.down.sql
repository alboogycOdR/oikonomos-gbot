-- Reverse TASK-098. This is safe only when no version chains remain; an
-- operator must resolve historical duplicates before restoring 005's key.
DROP INDEX IF EXISTS profile_facts_superseded_by_idx;
DROP INDEX IF EXISTS profile_facts_current_key_idx;

ALTER TABLE profile_facts DROP COLUMN IF EXISTS superseded_by;
ALTER TABLE profile_facts DROP COLUMN IF EXISTS visible_to;

CREATE UNIQUE INDEX IF NOT EXISTS profile_facts_tenant_scope_role_project_key_key
  ON profile_facts (tenant_id, scope, COALESCE(role_id, ''), COALESCE(project_id, ''), key);
