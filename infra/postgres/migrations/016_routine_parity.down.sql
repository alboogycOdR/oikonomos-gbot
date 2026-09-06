DROP TABLE IF EXISTS routine_runs;
ALTER TABLE role_routines DROP CONSTRAINT IF EXISTS role_routines_notify_threshold_check;
ALTER TABLE role_routines DROP CONSTRAINT IF EXISTS role_routines_on_missing_source_check;
ALTER TABLE role_routines DROP CONSTRAINT IF EXISTS role_routines_last_fire_status_check;
ALTER TABLE role_routines ADD CONSTRAINT role_routines_last_fire_status_check
  CHECK (last_fire_status IS NULL OR last_fire_status IN ('queued', 'missed'));
ALTER TABLE role_routines DROP COLUMN IF EXISTS paused;
ALTER TABLE role_routines DROP COLUMN IF EXISTS notify_threshold;
ALTER TABLE role_routines DROP COLUMN IF EXISTS on_missing_source;
ALTER TABLE role_routines DROP COLUMN IF EXISTS skill_id;
