\set ON_ERROR_STOP on
BEGIN;
INSERT INTO audit_events (actor, event_type, payload)
VALUES ('test:append-only', 'test.audit', '{"fixture":"append-only"}')
RETURNING event_id AS audit_event_id \gset

UPDATE audit_events SET event_type = 'mutated' WHERE event_id = :audit_event_id;
DELETE FROM audit_events WHERE event_id = :audit_event_id;

SELECT CASE WHEN count(*) = 1 AND max(event_type) = 'test.audit' THEN true ELSE false END
  AS append_only_ok
FROM audit_events
WHERE event_id = :audit_event_id
\gset
\if :append_only_ok
  \echo 'append-only assertion passed'
\else
  \quit 1
\endif

SELECT '[1,2,3]'::vector;
ROLLBACK;
