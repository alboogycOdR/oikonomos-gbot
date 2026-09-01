-- TASK-084 / Addendum F §3.1 (F4), §3.4 (F7), §3.5 (F8), §5.4 (F15).
-- Adds the D0 identity/routine/message/require-approval tables the ADR-010
-- pivot depends on, and wires FKs from the two columns that already
-- reference them as free text: role_grants.role_id and tasks.routine_id.
-- Does NOT touch profile_facts, the risk_tier enum, or migrations 001-003.

-- F4 — roles: role_id gains a home. description is ADVISORY ONLY (N12) —
-- no query helper in this migration's companion modules may use it for an
-- authorization decision; role_grants remains the enforcer.
CREATE TABLE IF NOT EXISTS roles (
  role_id text PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT 'basileia',
  name text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_status_check CHECK (status IN ('active', 'hidden', 'deleted'))
);

-- F7 — routines are D0 rows; the scheduler (TASK-076) reads this table but
-- lives off-environment. Firing does not resume anything (F3).
CREATE TABLE IF NOT EXISTS role_routines (
  routine_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id text NOT NULL REFERENCES roles(role_id),
  tenant_id text NOT NULL DEFAULT 'basileia',
  name text NOT NULL,
  schedule text,
  lane text NOT NULL DEFAULT 'background',
  enabled boolean NOT NULL DEFAULT true,
  definition jsonb NOT NULL DEFAULT '{}',
  last_fire_at timestamptz,
  next_fire_at timestamptz,
  -- Bookkeeping column beyond Addendum F §3.4's literal column list, added to
  -- satisfy this task's own acceptance criterion "a missed fire is recorded
  -- distinctly from a queued one" (§3.4 "recorded as missed, never queued
  -- for catch-up"). NULL until the first fire attempt.
  last_fire_status text,
  CONSTRAINT role_routines_lane_check CHECK (lane IN ('user', 'agent', 'background')),
  CONSTRAINT role_routines_last_fire_status_check
    CHECK (last_fire_status IS NULL OR last_fire_status IN ('queued', 'missed'))
);

-- F8 — async role-to-role handoff. No file bytes travel; workspace_refs
-- carries paths only. A handoff carries no privilege (R13).
CREATE TABLE IF NOT EXISTS role_messages (
  message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'basileia',
  from_role_id text NOT NULL REFERENCES roles(role_id),
  to_role_id text NOT NULL REFERENCES roles(role_id),
  body text NOT NULL,
  workspace_refs jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

-- F15 — Require Approval rules. role_id NULL means whole-tenant. A matching
-- rule promotes an otherwise-autonomous action to enforced (rank 3 of the
-- total precedence order in §5.4); evaluation itself is TASK-086's (policy).
CREATE TABLE IF NOT EXISTS require_approval_rules (
  rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'basileia',
  role_id text REFERENCES roles(role_id),
  capability_id text NOT NULL REFERENCES capabilities(capability_id),
  target_predicate jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill guard, part 1: role_grants.role_id is about to gain a FK to
-- roles. Pre-existing grants for a role_id with no roles row would make the
-- migration fail outright; instead synthesize a minimal placeholder row
-- (status active, description empty per this task's brief) so the FK add
-- below succeeds without losing any existing grant.
INSERT INTO roles (role_id, tenant_id, name, title, description, status)
SELECT DISTINCT rg.role_id, 'basileia', rg.role_id, rg.role_id, '', 'active'
FROM role_grants rg
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.role_id = rg.role_id)
ON CONFLICT (role_id) DO NOTHING;

-- Backfill guard, part 2: tasks.routine_id is about to gain a FK to
-- role_routines, which itself requires a role_id that exists in roles.
-- First backfill any roles referenced only via such a task's own role_id...
INSERT INTO roles (role_id, tenant_id, name, title, description, status)
SELECT DISTINCT t.role_id, t.tenant_id, t.role_id, t.role_id, '', 'active'
FROM tasks t
WHERE t.routine_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM roles r WHERE r.role_id = t.role_id)
ON CONFLICT (role_id) DO NOTHING;

-- ...then backfill one role_routines row per orphaned routine_id, picking a
-- single (role_id, tenant_id) deterministically per routine_id in case more
-- than one task row shares the same routine_id.
INSERT INTO role_routines (routine_id, role_id, tenant_id, name, schedule, lane, enabled, definition)
SELECT DISTINCT ON (t.routine_id)
  t.routine_id, t.role_id, t.tenant_id,
  'backfilled-' || t.routine_id::text, NULL, 'background', true, '{}'::jsonb
FROM tasks t
WHERE t.routine_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM role_routines rr WHERE rr.routine_id = t.routine_id)
ORDER BY t.routine_id, t.created_at
ON CONFLICT (routine_id) DO NOTHING;

-- The FKs the task exists to add. Any grant/task referencing a nonexistent
-- role_id/routine_id at this point is a genuine data error, not a backfill
-- case, and correctly fails the migration.
ALTER TABLE role_grants
  ADD CONSTRAINT role_grants_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(role_id);

ALTER TABLE tasks
  ADD CONSTRAINT tasks_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES role_routines(routine_id);

CREATE INDEX IF NOT EXISTS role_routines_role_id_idx ON role_routines (role_id);
CREATE INDEX IF NOT EXISTS role_messages_to_role_id_idx ON role_messages (to_role_id);
CREATE INDEX IF NOT EXISTS role_messages_from_role_id_idx ON role_messages (from_role_id);
CREATE INDEX IF NOT EXISTS require_approval_rules_capability_id_idx ON require_approval_rules (capability_id);
