-- TASK-099 / OIK-102. Typed mailbox handoffs carry a memory fact locator,
-- never a copied fact value. Both fields remain nullable for old handoffs.
ALTER TABLE role_messages ADD COLUMN IF NOT EXISTS handoff_kind text NULL;
ALTER TABLE role_messages ADD COLUMN IF NOT EXISTS fact_ref jsonb NULL;

ALTER TABLE role_messages DROP CONSTRAINT IF EXISTS role_messages_typed_handoff_pair_check;
ALTER TABLE role_messages ADD CONSTRAINT role_messages_typed_handoff_pair_check
  CHECK ((handoff_kind IS NULL) = (fact_ref IS NULL));

ALTER TABLE role_messages DROP CONSTRAINT IF EXISTS role_messages_handoff_kind_check;
ALTER TABLE role_messages ADD CONSTRAINT role_messages_handoff_kind_check
  CHECK (handoff_kind IS NULL OR handoff_kind IN ('research.complete', 'draft.ready_for_review'));

ALTER TABLE role_messages DROP CONSTRAINT IF EXISTS role_messages_fact_ref_no_value_check;
ALTER TABLE role_messages ADD CONSTRAINT role_messages_fact_ref_no_value_check
  CHECK (fact_ref IS NULL OR (jsonb_typeof(fact_ref) = 'object' AND NOT (fact_ref ? 'value')));
