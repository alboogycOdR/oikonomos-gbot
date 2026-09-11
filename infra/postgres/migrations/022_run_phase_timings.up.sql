-- TASK-230: per-phase latency instrumentation for chat runs. Nothing
-- previously recorded how long a real run actually took broken down by
-- phase (manifest/registry load, connector resolution, the model call
-- itself, DB writes) — only the coarse started_at/ended_at on `runs`.
--
-- One row per (run_id, phase). A run's full timing is the set of rows
-- sharing its run_id; querying "the model-call phase across the last 500
-- runs" is a normal indexed WHERE phase = ... scan.
CREATE TABLE IF NOT EXISTS run_phase_timings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  duration_ms DOUBLE PRECISION NOT NULL CHECK (duration_ms >= 0),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_phase_timings_run_id_idx ON run_phase_timings(run_id);
CREATE INDEX IF NOT EXISTS run_phase_timings_phase_recorded_at_idx ON run_phase_timings(phase, recorded_at DESC);
