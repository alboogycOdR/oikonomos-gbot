-- TASK-276 / ADR-018 "Storage" section (specs/OIKONOMOS_TEMPLATES_v1.0.md §4).
-- Foundation storage only: no export/install API, no packages/templates
-- projection code (TASK-278). `role_template_installs` is deliberately out
-- of this task's scope -- it belongs to the install feature that consumes
-- it, not to the bare storage layer this task builds.
CREATE TABLE IF NOT EXISTS bot_templates (
  template_id uuid NOT NULL,
  version integer NOT NULL,
  tenant_id text NOT NULL,
  name text NOT NULL,
  manifest jsonb NOT NULL,
  digest text NOT NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);

CREATE INDEX IF NOT EXISTS bot_templates_tenant_id_idx ON bot_templates (tenant_id);
