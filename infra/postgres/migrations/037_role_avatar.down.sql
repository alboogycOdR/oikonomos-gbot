-- Reverse TASK-347. Statements remain safe for repeated rollback attempts.
ALTER TABLE roles DROP COLUMN IF EXISTS avatar_shape;
ALTER TABLE roles DROP COLUMN IF EXISTS avatar_color;
