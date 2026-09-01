-- TASK-065: bind approvals to the issuing process generation and user context.
-- Nullable columns deliberately leave all existing approvals unbound.
ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS control_plane_generation uuid,
  ADD COLUMN IF NOT EXISTS user_context_epoch bigint;
