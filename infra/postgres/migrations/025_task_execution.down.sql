ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_execution_shape_check;
ALTER TABLE tasks DROP COLUMN IF EXISTS execution;
