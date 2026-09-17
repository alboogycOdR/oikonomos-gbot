-- TASK-280 / ADR-018 "Storage" section (specs/OIKONOMOS_TEMPLATES_v1.0.md
-- §4). Deliberately excluded from 026_bot_templates (TASK-276's own scope
-- note): "role_template_installs is deliberately out of this task's scope
-- -- it belongs to the install feature that consumes it, not to the bare
-- storage layer this task builds." This migration is that install feature's
-- own table, field-for-field per the spec's own SQL block.
CREATE TABLE IF NOT EXISTS role_template_installs (
  role_id text PRIMARY KEY REFERENCES roles(role_id),
  template_id uuid NOT NULL,
  version integer NOT NULL,
  digest text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (template_id, version) REFERENCES bot_templates(template_id, version)
);
