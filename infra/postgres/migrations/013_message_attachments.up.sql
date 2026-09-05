-- TASK-166 — structured chat message attachments.
-- Side table (not a new column on messages) so the structured reference
-- lives on the message via message_id without changing the messages
-- column set that TASK-105's schema snapshot pins.
CREATE TABLE IF NOT EXISTS message_attachments (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size >= 0),
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_attachments_message_id_idx
  ON message_attachments (message_id);
