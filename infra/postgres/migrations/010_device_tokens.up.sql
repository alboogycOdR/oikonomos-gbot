-- TASK-145 — registered mobile push targets.  There are no per-user
-- accounts yet, so tokens are intentionally global and are broadcast to by
-- the control-api (see its composition comment).
CREATE TABLE IF NOT EXISTS device_tokens (
  token text PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_tokens_last_seen_at_idx
  ON device_tokens (last_seen_at DESC);
