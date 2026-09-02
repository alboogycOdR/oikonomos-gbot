-- TASK-098 / ADR-012 §2.1-2.2. Extend the canonical profile_facts store;
-- no parallel fact table is introduced. NULL visible_to keeps the previous
-- whole-tenant project/user read behaviour.
ALTER TABLE profile_facts ADD COLUMN IF NOT EXISTS visible_to text[] NULL;
ALTER TABLE profile_facts ADD COLUMN IF NOT EXISTS superseded_by uuid NULL
  REFERENCES profile_facts(fact_id);

-- Versioned facts intentionally share a key. The former unique expression
-- index prevented retaining history, so replace it with query indexes.
DROP INDEX IF EXISTS profile_facts_tenant_scope_role_project_key_key;
CREATE INDEX IF NOT EXISTS profile_facts_current_key_idx
  ON profile_facts (tenant_id, scope, role_id, project_id, key)
  WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS profile_facts_superseded_by_idx
  ON profile_facts (superseded_by);
