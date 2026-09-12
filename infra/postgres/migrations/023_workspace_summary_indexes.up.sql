-- TASK-237: bounded workspace summaries resolve latest runs and pending
-- approvals by these two predicates. EXPLAIN before this migration showed
-- sequential scans on both messages.run_id and approvals(run_id, status).
CREATE INDEX IF NOT EXISTS messages_run_id_idx
  ON messages (run_id)
  WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS approvals_run_id_status_idx
  ON approvals (run_id, status);
