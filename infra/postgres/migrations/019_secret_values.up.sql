-- TASK-192 — dynamically fulfilled secrets remain separate from request metadata.
-- No ordinary list/detail route should ever select this ciphertext-bearing table.

CREATE TABLE secret_values (
  ref uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  role_id text NOT NULL REFERENCES roles(role_id),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  key_version smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
