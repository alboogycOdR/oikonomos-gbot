DROP TRIGGER IF EXISTS audit_events_reject_truncate ON audit_events;
DROP TRIGGER IF EXISTS audit_events_reject_truncate_via_runs ON runs;
DROP FUNCTION IF EXISTS audit_events_reject_truncate();
