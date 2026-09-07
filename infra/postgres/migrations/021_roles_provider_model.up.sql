-- TASK-213: per-bot provider/model selection.
--
-- NULL means "use the configured platform default" rather than a hardcoded
-- literal, so the default can move without rewriting every row — and so a
-- bot that has never been given an explicit choice is distinguishable from
-- one deliberately pinned to today's default. That distinction is what makes
-- the eventual switch reversible per bot.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS model text;
