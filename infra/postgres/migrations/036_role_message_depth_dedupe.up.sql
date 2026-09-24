-- TASK-328 — bound bot-to-bot handoff chains and make a run's resend idempotent.
ALTER TABLE role_messages ADD COLUMN IF NOT EXISTS hop_depth integer NOT NULL DEFAULT 0;
ALTER TABLE role_messages ADD COLUMN IF NOT EXISTS dedupe_key text NULL;

ALTER TABLE role_messages DROP CONSTRAINT IF EXISTS role_messages_hop_depth_check;
ALTER TABLE role_messages ADD CONSTRAINT role_messages_hop_depth_check CHECK (hop_depth >= 0);

-- The key includes source_run_id, so this permits the same envelope in a
-- different run while making concurrent retries of one run converge.
CREATE UNIQUE INDEX IF NOT EXISTS role_messages_dedupe_key_unique
  ON role_messages (dedupe_key)
  WHERE dedupe_key IS NOT NULL;
