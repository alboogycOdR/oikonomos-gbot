-- Reverse TASK-299. Restore TASK-099's original closed set.
ALTER TABLE role_messages DROP CONSTRAINT IF EXISTS role_messages_handoff_kind_check;
ALTER TABLE role_messages ADD CONSTRAINT role_messages_handoff_kind_check
  CHECK (handoff_kind IS NULL OR handoff_kind IN ('research.complete', 'draft.ready_for_review'));
