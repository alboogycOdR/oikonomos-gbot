-- OIKONOMOS schema v0.1. Source: Platform Synthesis Spec §5.1.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('draft','queued','running','waiting_approval','paused','completed','failed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE run_status AS ENUM ('started','waiting_approval','resumed','completed','failed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE risk_tier AS ENUM ('T0_observe','T1_draft','T2_internal','T3_external','T4_irreversible');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE approval_status AS ENUM ('pending','granted','rejected','expired','invalidated','consumed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tasks (
  task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL DEFAULT 'basileia',
  role_id text NOT NULL, title text NOT NULL, goal text NOT NULL,
  status task_status NOT NULL DEFAULT 'draft', routine_id uuid, requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES tasks(task_id),
  tenant_id text NOT NULL DEFAULT 'basileia', provider text NOT NULL, session_ref text,
  status run_status NOT NULL DEFAULT 'started', started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz, failure_note text
);
CREATE TABLE IF NOT EXISTS capabilities (
  capability_id text PRIMARY KEY, description text NOT NULL, default_tier risk_tier NOT NULL,
  adapter text NOT NULL, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS role_grants (
  role_id text NOT NULL, capability_id text NOT NULL REFERENCES capabilities(capability_id),
  max_tier risk_tier NOT NULL, constraints jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (role_id, capability_id)
);
CREATE TABLE IF NOT EXISTS approvals (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL DEFAULT 'basileia',
  run_id uuid NOT NULL REFERENCES runs(run_id), capability_id text NOT NULL REFERENCES capabilities(capability_id),
  action_digest bytea NOT NULL, action_render text NOT NULL, destination text NOT NULL,
  nonce uuid NOT NULL DEFAULT gen_random_uuid(), status approval_status NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  decided_by text, decided_at timestamptz, consumed_at timestamptz, UNIQUE (nonce)
);
CREATE TABLE IF NOT EXISTS audit_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id text NOT NULL DEFAULT 'basileia',
  run_id uuid, at timestamptz NOT NULL DEFAULT now(), actor text NOT NULL, event_type text NOT NULL,
  capability text, tier risk_tier, payload jsonb NOT NULL DEFAULT '{}', evidence_uri text
);
DO $$ BEGIN
  CREATE RULE audit_no_update AS ON UPDATE TO audit_events DO INSTEAD NOTHING;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE RULE audit_no_delete AS ON DELETE TO audit_events DO INSTEAD NOTHING;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS profile_facts (
  fact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL DEFAULT 'basileia',
  scope text NOT NULL, key text NOT NULL, value text NOT NULL, source text NOT NULL,
  confidence real NOT NULL DEFAULT 0.8, expires_at timestamptz, UNIQUE (tenant_id, scope, key)
);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  chunk_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL DEFAULT 'basileia',
  acl_scope text NOT NULL, source_uri text NOT NULL, content text NOT NULL, embedding vector(1024)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
