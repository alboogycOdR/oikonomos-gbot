-- An expired request has neither secret_ref nor fulfilled_at, so it can be
-- conservatively represented as declined before restoring the old enum set.
UPDATE secret_requests SET status = 'declined' WHERE status = 'expired';
ALTER TABLE secret_requests DROP CONSTRAINT IF EXISTS secret_requests_status_check;
ALTER TABLE secret_requests ADD CONSTRAINT secret_requests_status_check
  CHECK (status IN ('pending', 'fulfilled', 'declined'));
