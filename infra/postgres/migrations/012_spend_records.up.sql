-- TASK-143 / OIK-110/111 (narrowed scope: Codex/Grok subprocess path only).
-- Records real per-turn inference spend so a routine's accumulated cost and
-- the platform-wide monthly ceiling (CLAUDE.md "Budget") can be enforced
-- live, per decision, rather than from a cached/derived figure.
--
-- run_id/routine_id are plain text, not FKs: a subprocess-routed turn's
-- L1RunIdentity.runId is caller-supplied and is not guaranteed to match a
-- `runs` table row (see services/worker/src/executeRun.ts's isRunIdentity),
-- and routine_id is legitimately absent for a run with no owning routine.
CREATE TABLE IF NOT EXISTS spend_records (
  spend_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'basileia',
  run_id text NOT NULL,
  routine_id text NULL,
  provider text NOT NULL,
  model text NOT NULL,
  cost_usd numeric(14,6) NOT NULL CHECK (cost_usd >= 0),
  tokens integer NULL CHECK (tokens IS NULL OR tokens >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spend_records_routine_occurred_idx
  ON spend_records (routine_id, occurred_at);
CREATE INDEX IF NOT EXISTS spend_records_occurred_idx
  ON spend_records (occurred_at);
