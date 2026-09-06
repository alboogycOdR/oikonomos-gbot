-- TASK-182 — Grok Bot routine parity: binding, pause state and bounded fire history.
ALTER TABLE role_routines ADD COLUMN IF NOT EXISTS skill_id uuid NULL REFERENCES skills(skill_id);
ALTER TABLE role_routines ADD COLUMN IF NOT EXISTS on_missing_source text NOT NULL DEFAULT 'report_and_stop';
ALTER TABLE role_routines ADD COLUMN IF NOT EXISTS notify_threshold text NOT NULL DEFAULT 'changes_only';
ALTER TABLE role_routines ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
ALTER TABLE role_routines DROP CONSTRAINT IF EXISTS role_routines_last_fire_status_check;
ALTER TABLE role_routines ADD CONSTRAINT role_routines_last_fire_status_check
  CHECK (last_fire_status IS NULL OR last_fire_status IN ('queued', 'missed', 'stopped', 'skipped_paused'));
ALTER TABLE role_routines ADD CONSTRAINT role_routines_on_missing_source_check
  CHECK (on_missing_source IN ('report_and_stop'));
ALTER TABLE role_routines ADD CONSTRAINT role_routines_notify_threshold_check
  CHECK (notify_threshold IN ('changes_only'));

CREATE TABLE IF NOT EXISTS routine_runs (
  routine_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id uuid NOT NULL REFERENCES role_routines(routine_id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN ('queued', 'missed', 'stopped', 'skipped_paused')),
  reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS routine_runs_routine_created_idx ON routine_runs (routine_id, created_at DESC, routine_run_id DESC);
