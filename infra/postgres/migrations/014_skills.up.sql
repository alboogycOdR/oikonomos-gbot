-- TASK-176 — account-scoped skill library and per-role enablement.
-- A skill body is prompt material, never an authorization decision (N12).

CREATE TABLE IF NOT EXISTS skills (
  skill_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'basileia',
  name text NOT NULL,
  description text NOT NULL,
  when_to_use text,
  body text NOT NULL,
  inputs jsonb NOT NULL DEFAULT '[]',
  access jsonb NOT NULL DEFAULT '[]',
  approvals jsonb NOT NULL DEFAULT '[]',
  failure_policy jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skills_tenant_name_key UNIQUE (tenant_id, name),
  CONSTRAINT skills_name_slash_token_check
    CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,63}$')
);

CREATE TABLE IF NOT EXISTS role_skills (
  role_id text NOT NULL REFERENCES roles(role_id),
  skill_id uuid NOT NULL REFERENCES skills(skill_id),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (role_id, skill_id)
);

CREATE INDEX IF NOT EXISTS role_skills_skill_id_idx ON role_skills (skill_id);
