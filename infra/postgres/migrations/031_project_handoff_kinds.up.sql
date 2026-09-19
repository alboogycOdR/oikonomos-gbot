-- TASK-299 / ADR-019 §3, Project Workspace spec §5. Typed project
-- handoffs remain locators; role_messages_fact_ref_no_value_check is
-- intentionally unchanged from migration 007.
ALTER TABLE role_messages DROP CONSTRAINT IF EXISTS role_messages_handoff_kind_check;
ALTER TABLE role_messages ADD CONSTRAINT role_messages_handoff_kind_check
  CHECK (handoff_kind IS NULL OR handoff_kind IN (
    'research.complete',
    'draft.ready_for_review',
    'task.assigned',
    'task.completed',
    'task.blocked',
    'status.requested'
  ));
