-- Reverse TASK-327. Each statement is intentionally idempotent.
DROP INDEX IF EXISTS role_messages_pending_delivery_idx;
ALTER TABLE role_messages DROP CONSTRAINT IF EXISTS role_messages_delivery_attempts_check;
ALTER TABLE role_messages DROP COLUMN IF EXISTS delivery_failed_at;
ALTER TABLE role_messages DROP COLUMN IF EXISTS delivery_claimed_at;
ALTER TABLE role_messages DROP COLUMN IF EXISTS delivery_claim_token;
ALTER TABLE role_messages DROP COLUMN IF EXISTS last_delivery_error;
ALTER TABLE role_messages DROP COLUMN IF EXISTS delivery_attempts;
