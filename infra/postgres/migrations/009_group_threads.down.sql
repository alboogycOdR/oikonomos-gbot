-- Reverse TASK-120 / OIK-150.
ALTER TABLE messages DROP COLUMN IF EXISTS sender_role_id;

DROP TABLE IF EXISTS thread_members;

DROP INDEX IF EXISTS threads_role_id_key;
-- Restore the original NOT NULL + plain UNIQUE constraint. Any group thread
-- (role_id IS NULL) rows must be gone before this can succeed, which is
-- expected: down-migrations run against the additive schema they reversed,
-- and group threads only start existing once TASK-121 ships.
ALTER TABLE threads ALTER COLUMN role_id SET NOT NULL;
ALTER TABLE threads ADD CONSTRAINT threads_role_id_key UNIQUE (role_id);
