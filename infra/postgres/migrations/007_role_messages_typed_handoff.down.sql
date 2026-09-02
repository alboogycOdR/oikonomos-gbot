-- Reverse TASK-099. Existing untyped handoffs are untouched.
ALTER TABLE role_messages DROP CONSTRAINT IF EXISTS role_messages_handoff_kind_check;
ALTER TABLE role_messages DROP CONSTRAINT IF EXISTS role_messages_fact_ref_no_value_check;
ALTER TABLE role_messages DROP CONSTRAINT IF EXISTS role_messages_typed_handoff_pair_check;
ALTER TABLE role_messages DROP COLUMN IF EXISTS fact_ref;
ALTER TABLE role_messages DROP COLUMN IF EXISTS handoff_kind;
