-- TASK-219: index the per-provider cap's own query.
--
-- TASK-209 added getProviderSpendUsd, whose predicate is
--   WHERE provider = $1 AND occurred_at >= $2
-- and it runs on every governed call that resolves a provider cap, against a
-- table that only ever grows. Existing indexes cover routine_id and
-- occurred_at, neither of which serves this pair.
--
-- IF NOT EXISTS keeps the migration safe to re-run, matching the conventions
-- of the migrations either side of it.
CREATE INDEX IF NOT EXISTS spend_records_provider_occurred_at_idx
  ON spend_records (provider, occurred_at);
