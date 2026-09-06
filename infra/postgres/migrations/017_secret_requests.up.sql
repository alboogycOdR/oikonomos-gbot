-- TASK-184 — request metadata is deliberately separate from encrypted values.
CREATE TABLE secret_requests (
  request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  role_id text NOT NULL REFERENCES roles(role_id),
  run_id uuid NOT NULL REFERENCES runs(run_id),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'declined')),
  secret_ref text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  fulfilled_at timestamptz NULL,
  CHECK ((status = 'fulfilled') = (secret_ref IS NOT NULL)),
  CHECK ((status = 'fulfilled') = (fulfilled_at IS NOT NULL))
);

CREATE INDEX secret_requests_pending_role_idx ON secret_requests (tenant_id, role_id, status, created_at);
