-- TASK-298 / ADR-019 §2, §5 (specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md §2, §3,
-- §6.1, §6.2). The remainder of the P-1 schema that migration 027 deliberately
-- left out: the roster/manager table, the work-item -> run link, the two
-- reservation tables, and the two budget columns.
--
-- Storage only. Reservation LOGIC (admit/release under SELECT ... FOR UPDATE)
-- is TASK-300; this migration only creates the tables that logic locks.

-- Spec §2: the roster is the thread's existing thread_members; project_roles
-- adds the manager flag and per-member responsibility on top of it.
CREATE TABLE IF NOT EXISTS project_roles (
  project_id uuid NOT NULL REFERENCES projects(project_id),
  role_id text NOT NULL REFERENCES roles(role_id),
  is_manager boolean NOT NULL DEFAULT false,
  responsibility text NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, role_id)
);

-- Spec §2.1: at most one manager per project, enforced by the database.
-- Zero managers is valid (the human is the manager).
CREATE UNIQUE INDEX IF NOT EXISTS project_roles_one_manager_idx
  ON project_roles (project_id)
  WHERE is_manager;

-- Spec §3: a work item links to zero or more runs; runtime tasks/runs are a
-- different thing and are never overloaded.
CREATE TABLE IF NOT EXISTS project_task_runs (
  task_id uuid NOT NULL REFERENCES project_tasks(task_id),
  run_id uuid NOT NULL REFERENCES runs(run_id),
  PRIMARY KEY (task_id, run_id)
);

CREATE INDEX IF NOT EXISTS project_task_runs_run_id_idx ON project_task_runs (run_id);

-- Spec §6.1: text, no FK -- same convention as spend_records.run_id/routine_id.
ALTER TABLE spend_records ADD COLUMN IF NOT EXISTS project_id text NULL;
CREATE INDEX IF NOT EXISTS spend_records_project_id_idx
  ON spend_records (project_id, occurred_at)
  WHERE project_id IS NOT NULL;

-- Spec §6.2: per-role monthly ceiling. NULL = no ceiling.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS budget_usd numeric(14,6) NULL;

-- Spec §6.2: one row per open/released reservation. run_id is a plain text
-- run identity (like spend_records.run_id), not a runs FK.
CREATE TABLE IF NOT EXISTS spend_reservations (
  reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  axis text NOT NULL CHECK (axis IN ('project','role')),
  axis_id text NOT NULL,
  run_id text NOT NULL,
  reserved_usd numeric(14,6) NOT NULL CHECK (reserved_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz NULL
);

-- Open reservations per axis are summed on every admission.
CREATE INDEX IF NOT EXISTS spend_reservations_open_idx
  ON spend_reservations (axis, axis_id)
  WHERE released_at IS NULL;

-- Spec §6.2: rows that exist only to be locked (SELECT ... FOR UPDATE).
CREATE TABLE IF NOT EXISTS budget_ledgers (
  axis text NOT NULL CHECK (axis IN ('project','role')),
  axis_id text NOT NULL,
  month date NOT NULL,
  PRIMARY KEY (axis, axis_id, month)
);
