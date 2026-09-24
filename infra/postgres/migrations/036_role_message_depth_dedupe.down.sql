-- Reverse TASK-328. Every statement is intentionally idempotent.
DROP INDEX IF EXISTS role_messages_dedupe_key_unique;
ALTER TABLE role_messages DROP CONSTRAINT IF EXISTS role_messages_hop_depth_check;
ALTER TABLE role_messages DROP COLUMN IF EXISTS dedupe_key;
ALTER TABLE role_messages DROP COLUMN IF EXISTS hop_depth;
