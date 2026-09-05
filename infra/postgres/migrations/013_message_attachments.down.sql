DROP INDEX IF EXISTS message_attachments_message_id_idx;
DROP TABLE IF EXISTS message_attachments;
-- In case an earlier revision of this migration added a column on messages:
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_attachments_is_array;
ALTER TABLE messages DROP COLUMN IF EXISTS attachments;
