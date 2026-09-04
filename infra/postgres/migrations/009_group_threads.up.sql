-- TASK-120 / OIK-150 — multi-bot group thread schema (Chat-2a).
-- Additive: adds a thread_members join table for multi-bot threads and a
-- nullable sender_role_id on messages, without breaking the existing 1:1
-- thread model (threads.role_id stays UNIQUE NOT NULL-equivalent for 1:1
-- threads via a partial unique index, but becomes nullable so a future
-- group-thread creation path, TASK-121, can leave it null).

-- 1) threads.role_id becomes nullable. Group threads (created by TASK-121)
--    will leave this null and rely on thread_members instead.
ALTER TABLE threads ALTER COLUMN role_id DROP NOT NULL;

-- 2) Replace the old blanket UNIQUE(role_id) constraint (which also forbade
--    more than one null) with a partial unique index that only applies to
--    1:1 threads, so multiple group threads (role_id IS NULL) can coexist.
ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_role_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS threads_role_id_key
  ON threads (role_id)
  WHERE role_id IS NOT NULL;

-- 3) thread_members: every bot participating in a thread. For today's 1:1
--    threads this always has exactly one row (backfilled below); group
--    threads (TASK-121) will insert one row per participating bot.
CREATE TABLE IF NOT EXISTS thread_members (
  thread_id uuid NOT NULL REFERENCES threads(id),
  role_id text NOT NULL REFERENCES roles(role_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, role_id)
);

INSERT INTO thread_members (thread_id, role_id)
SELECT id, role_id FROM threads WHERE role_id IS NOT NULL
ON CONFLICT (thread_id, role_id) DO NOTHING;

-- 4) messages.sender_role_id: which bot sent this message, when role='bot'.
--    Null means "the human user" (matches today's role='user' rows) or a
--    system message; set means "this bot sent it". Works alongside the
--    existing role check, does not replace it.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_role_id text REFERENCES roles(role_id);
