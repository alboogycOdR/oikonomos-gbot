-- Reverse 001_schema_v1.up.sql. This intentionally removes all v1 data.
DROP TABLE IF EXISTS knowledge_chunks;
DROP TABLE IF EXISTS profile_facts;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS role_grants;
DROP TABLE IF EXISTS capabilities;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS tasks;
DROP TYPE IF EXISTS approval_status;
DROP TYPE IF EXISTS risk_tier;
DROP TYPE IF EXISTS run_status;
DROP TYPE IF EXISTS task_status;
