-- Reverse 002_approval_binding.up.sql.
ALTER TABLE approvals
  DROP COLUMN IF EXISTS user_context_epoch,
  DROP COLUMN IF EXISTS control_plane_generation;
