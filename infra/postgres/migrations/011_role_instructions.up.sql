-- TASK-156 — optional bot-specific system prompt material.  NULL means the
-- bot has no custom instructions and must use the driver's identity default.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS instructions text;
