-- TASK-179 (G-03a) — per-thread context hygiene: a token meter, rolling
-- compaction into thread_summaries, and a 'start fresh' epoch bump.
-- Addendum F §3.3: summaries are THREAD state, not memory — nothing here
-- touches packages/memory's tables.

CREATE TABLE IF NOT EXISTS thread_context (
  thread_id uuid PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  context_tokens integer NOT NULL DEFAULT 0,
  context_limit integer NOT NULL DEFAULT 8000,
  compacted_through_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  epoch integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT thread_context_tokens_nonneg_check CHECK (context_tokens >= 0),
  CONSTRAINT thread_context_limit_positive_check CHECK (context_limit > 0),
  CONSTRAINT thread_context_epoch_nonneg_check CHECK (epoch >= 0)
);

-- One summary row per compaction. `epoch` lets promptAssembly filter out
-- every summary from a pre-'start fresh' epoch without deleting history
-- (older turns must stay visible via GET /threads/:id/messages).
CREATE TABLE IF NOT EXISTS thread_summaries (
  summary_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  epoch integer NOT NULL,
  covers_through_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT thread_summaries_epoch_nonneg_check CHECK (epoch >= 0)
);

CREATE INDEX IF NOT EXISTS thread_summaries_thread_epoch_created_idx
  ON thread_summaries (thread_id, epoch, created_at);
