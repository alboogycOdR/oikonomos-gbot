-- audit_events is append-only.  Its UPDATE/DELETE rules do not intercept
-- TRUNCATE, so reject that separate statement class with a table trigger.
CREATE OR REPLACE FUNCTION audit_events_reject_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: TRUNCATE is not permitted'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_reject_truncate ON audit_events;
CREATE TRIGGER audit_events_reject_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit_events_reject_truncate();

-- `audit_events.run_id` references `runs`. PostgreSQL does not invoke the
-- child trigger when `TRUNCATE runs CASCADE` adds audit_events, so protect the
-- only direct FK parent too; otherwise that command bypasses the audit guard.
DROP TRIGGER IF EXISTS audit_events_reject_truncate_via_runs ON runs;
CREATE TRIGGER audit_events_reject_truncate_via_runs
  BEFORE TRUNCATE ON runs
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit_events_reject_truncate();
