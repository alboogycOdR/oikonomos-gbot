-- Reverse 004_roles_routines_rules.up.sql. Drops only what 004 created:
-- the two FKs it added to pre-existing tables, then the four new tables
-- (indexes and check constraints go with their owning table). Does not
-- touch profile_facts, the risk_tier enum, or migrations 001-003.

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_routine_id_fkey;
ALTER TABLE role_grants DROP CONSTRAINT IF EXISTS role_grants_role_id_fkey;

DROP TABLE IF EXISTS require_approval_rules;
DROP TABLE IF EXISTS role_messages;
DROP TABLE IF EXISTS role_routines;
DROP TABLE IF EXISTS roles;
