-- TASK-293 / spec §6.1 (drift = role changed since install). TASK-289's
-- `GET /roles/:roleId/template-status` route compared the live role
-- against the *template version's* raw manifest, but install intentionally
-- does not reproduce that manifest exactly -- a name override, opt-in
-- `include_memories`, reuse of an existing same-named tenant skill, and
-- integrations surfaced only as a grant checklist (not auto-granted) all
-- mean a role installed a moment ago with zero edits can legitimately
-- differ from the template it came from. This nullable column stores the
-- role's own projected manifest at the moment install finished, so status
-- can compare the live role against what was ACTUALLY installed rather
-- than the template's ideal shape.
--
-- Nullable, and left that way permanently: rows written before this
-- migration have no baseline and fall back to the legacy template-manifest
-- compare (see services/control-api/src/templates.ts). Once written by a
-- post-293 install, a row's baseline_manifest is never updated again --
-- same immutability as the rest of this table (028_role_template_installs).
ALTER TABLE role_template_installs
  ADD COLUMN IF NOT EXISTS baseline_manifest jsonb;
