CREATE TABLE role_sandboxes (
  role_id TEXT PRIMARY KEY REFERENCES roles(role_id) ON DELETE CASCADE,
  sandbox_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('Pending', 'Running', 'Pausing', 'Paused', 'Resuming', 'Stopping', 'Terminated', 'Failed')),
  execd_token_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX role_sandboxes_last_used_at_idx ON role_sandboxes (last_used_at);
