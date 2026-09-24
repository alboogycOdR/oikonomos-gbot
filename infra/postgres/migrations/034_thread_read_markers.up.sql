-- TASK-333 — per-tenant viewer state. Control API authentication currently
-- identifies a tenant, not an individual end user, so tenant_id is the
-- viewer identity until a finer-grained principal exists.
CREATE TABLE IF NOT EXISTS thread_viewer_states (
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  last_read_at timestamptz,
  pinned_at timestamptz,
  PRIMARY KEY (thread_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS thread_viewer_states_tenant_pinned_idx
  ON thread_viewer_states (tenant_id, pinned_at DESC NULLS LAST);
