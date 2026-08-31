-- TASK-075: intake idempotency ledger (nonce + input-digest binding).
-- Source: docs/STUDY-grok-bot-018.md §Tier 2 (prompt-acceptance ledger),
-- Directive §4 N8 spirit. Additive-only, reversible via 003 down.
CREATE TABLE IF NOT EXISTS intake_nonces (
  intake_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'basileia',
  client_nonce text NOT NULL,
  input_digest text NOT NULL,
  status text NOT NULL DEFAULT 'admitted',
  task_id uuid REFERENCES tasks(task_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_nonce)
);
