-- TASK-323: unanswered secret requests are terminal, just like a declined request.
ALTER TABLE secret_requests DROP CONSTRAINT IF EXISTS secret_requests_status_check;
ALTER TABLE secret_requests ADD CONSTRAINT secret_requests_status_check
  CHECK (status IN ('pending', 'fulfilled', 'declined', 'expired'));
