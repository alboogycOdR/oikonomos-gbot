-- TASK-347 — optional, client-rendered avatar selections for roles.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS avatar_color text NULL;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS avatar_shape text NULL;
