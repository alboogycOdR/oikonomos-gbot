-- TASK-327 — durable delivery state for role-message workers.
ALTER TABLE role_messages ADD COLUMN IF NOT EXISTS delivery_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE role_messages ADD COLUMN IF NOT EXISTS last_delivery_error text NULL;
ALTER TABLE role_messages ADD COLUMN IF NOT EXISTS delivery_claimed_at timestamptz NULL;
ALTER TABLE role_messages ADD COLUMN IF NOT EXISTS delivery_claim_token uuid NULL;
ALTER TABLE role_messages ADD COLUMN IF NOT EXISTS delivery_failed_at timestamptz NULL;

ALTER TABLE role_messages DROP CONSTRAINT IF EXISTS role_messages_delivery_attempts_check;
ALTER TABLE role_messages ADD CONSTRAINT role_messages_delivery_attempts_check
  CHECK (delivery_attempts >= 0 AND delivery_attempts <= 5);

CREATE INDEX IF NOT EXISTS role_messages_pending_delivery_idx
  ON role_messages (tenant_id, created_at, message_id)
  WHERE read_at IS NULL;
