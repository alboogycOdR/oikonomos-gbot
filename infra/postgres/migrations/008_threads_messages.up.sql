-- TASK-105 / OIK-129, OIK-156 — web chat transcript storage.
-- A v1 thread is one persistent conversation per bot role. The unique
-- constraint makes getOrCreateThreadForRole safe under concurrent requests.
CREATE TABLE IF NOT EXISTS threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id text NOT NULL REFERENCES roles(role_id),
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT threads_role_id_key UNIQUE (role_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES threads(id),
  role text NOT NULL CHECK (role IN ('user', 'bot', 'system')),
  body text NOT NULL,
  run_id uuid REFERENCES runs(run_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_thread_id_created_at_idx
  ON messages (thread_id, created_at);
