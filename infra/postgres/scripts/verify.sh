#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?Set DATABASE_URL, for example postgresql://user:password@127.0.0.1:5432/oikonomos}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgcrypto') ORDER BY extname;
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN
  ('tasks','runs','capabilities','role_grants','approvals','audit_events','profile_facts','knowledge_chunks')
ORDER BY table_name;
SQL
