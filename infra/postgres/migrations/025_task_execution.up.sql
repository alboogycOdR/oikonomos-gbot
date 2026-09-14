-- TASK-246 / ADR-016 Amendment 1a: durable, reference-only worker command.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS execution jsonb;

ALTER TABLE tasks ADD CONSTRAINT tasks_execution_shape_check CHECK (
  execution IS NULL OR (
    jsonb_typeof(execution) = 'object'
    AND execution->>'version' = '1'
    AND execution->>'kind' IN ('chat', 'fanout')
    AND execution ? 'threadId'
  )
);
