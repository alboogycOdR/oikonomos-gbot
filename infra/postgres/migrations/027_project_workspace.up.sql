-- TASK-276 / ADR-019 §2-§8 (specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md §§2-8).
-- Foundation storage only -- the four tables this task's Acceptance_Criteria
-- names explicitly (projects, project_tasks, project_artifacts,
-- project_decisions). `project_roles`, `project_task_runs`,
-- `spend_reservations` and `budget_ledgers` are real ADR-019 tables too, but
-- they belong to the manager-role/budget-reservation tasks that consume
-- them, not to this bare storage slice -- deliberately not created here.
CREATE TABLE IF NOT EXISTS projects (
  project_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  thread_id uuid NOT NULL UNIQUE REFERENCES threads(id),
  name text NOT NULL,
  goal text NOT NULL,
  done_criterion text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','archived')),
  budget_usd numeric(14,6) NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_tenant_id_idx ON projects (tenant_id);

CREATE TABLE IF NOT EXISTS project_tasks (
  task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(project_id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_role_id text NULL REFERENCES roles(role_id),
  state text NOT NULL DEFAULT 'todo' CHECK (state IN ('todo','doing','blocked','review','done','cancelled')),
  blocked_reason text NULL,
  done_criterion text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS project_tasks_project_id_idx ON project_tasks (project_id);

CREATE TABLE IF NOT EXISTS project_artifacts (
  artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(project_id),
  task_id uuid NULL REFERENCES project_tasks(task_id),
  kind text NOT NULL CHECK (kind IN ('workspace_file','attachment','run_receipt')),
  ref text NOT NULL,
  sha256 text NULL,
  byte_size integer NULL,
  produced_by_role_id text NULL REFERENCES roles(role_id),
  produced_by_run_id uuid NULL REFERENCES runs(run_id),
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_artifacts_project_id_idx ON project_artifacts (project_id);
CREATE INDEX IF NOT EXISTS project_artifacts_task_id_idx ON project_artifacts (task_id);

CREATE TABLE IF NOT EXISTS project_decisions (
  decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(project_id),
  task_id uuid NULL REFERENCES project_tasks(task_id),
  kind text NOT NULL CHECK (kind IN ('approval','human_decision','manager_decision','review_finding')),
  approval_id uuid NULL REFERENCES approvals(approval_id),
  summary text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_decisions_project_id_idx ON project_decisions (project_id);
