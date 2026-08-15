#!/usr/bin/env node
/**
 * territory-precommit.js — git pre-commit territory enforcement (CLI-agnostic).
 *
 * WHY THIS EXISTS (ADR-002 §5, decision of 2026-08-15).
 * ADR-002 §5 permits builder permission-bypass on product paths only "where the
 * territory firewall is active for that unit (DEVTEAM_UNIT set), which mechanically
 * confines writes to the task's Owned_Paths". That exception was false in practice
 * for two of three units: hooks/territory-firewall.js is a Claude Code PreToolUse
 * hook, and neither grok (GB) nor codex (CX) reads .claude/settings.json, so it
 * never fired for them at all (scripts/dispatch.ps1:427 says so in as many words).
 * dispatch.ps1 sets DEVTEAM_UNIT for every builder, satisfying the letter of the
 * parenthetical while the mechanism it names was absent. Five builder tasks merged
 * under that gap before it was noticed; none wrote outside territory, but the only
 * control was post-hoc ORCH review.
 *
 * This hook restores the premise at the git layer, where every CLI is equal: a
 * commit is rejected if it stages any path outside the committing unit's active
 * Owned_Paths. grok, codex, claude and any future unit are covered identically,
 * and the ban in CLAUDE.md non-negotiable #2 needs no amendment.
 *
 * DESIGN NOTES — the three things that make this a control rather than a gesture:
 *
 *  1. FAILS CLOSED. territory-firewall.js deliberately fails OPEN (exit 0) so a hook
 *     bug can never brick an interactive session; it is one control among several and
 *     review is its backstop. This hook is the ONLY mechanical control for grok/codex,
 *     so the same choice would be self-defeating: any error, any unresolvable state,
 *     any unreadable PLAN.md rejects the commit. A builder that cannot prove its
 *     territory does not get to commit.
 *
 *  2. UNIT COMES FROM THE WORKTREE, NOT THE ENVIRONMENT. git hooks inherit the
 *     environment of whatever ran `git commit`; a builder that shells out through a
 *     wrapper, or a human committing by hand, can arrive with DEVTEAM_UNIT unset —
 *     and lib.unit() maps unset to ORCH (unrestricted). Trusting it here would mean
 *     the control silently disables itself in exactly the case it is meant to catch.
 *     The unit is therefore derived from the worktree directory name against
 *     autopilot.json's builders registry (wt-<worktree_suffix>-<project>), which is
 *     a property of where the commit is happening and cannot be unset. DEVTEAM_UNIT
 *     is consulted only to CROSS-CHECK, and a mismatch is a rejection.
 *
 *  3. PLAN.md IS READ FROM THE MAIN CHECKOUT, NOT THE WORKTREE. PLAN.md is the
 *     coordination blackboard and lives on the integration branch. A worktree's copy
 *     is whatever its branch happens to carry — possibly stale, and in principle
 *     editable on the branch. Reading territory from the worktree copy would let a
 *     commit widen the Owned_Paths that authorise it. Territory is always read from
 *     the main checkout's working tree.
 *
 * Hooks are SHARED across worktrees (`git rev-parse --git-path hooks` inside a
 * worktree resolves to the main checkout's .git/hooks), so this runs for every
 * worktree and for the main checkout from a single installed file. Commits in the
 * main checkout resolve to ORCH and are allowed — ORCH holds structural authority
 * and its discipline is enforced by review, matching territory-firewall.js §ORCH.
 *
 * Exit codes: 0 = allow the commit. 1 = reject it (stderr explains why).
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Run git, returning stdout. Throws on non-zero — callers let that reach failClosed. */
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function failClosed(message) {
  process.stderr.write(
    '\n[territory-precommit] COMMIT REJECTED\n' + message + '\n\n' +
    'This hook fails closed by design (ADR-002 §5): it is the only mechanical territory\n' +
    'control for non-hook-capable builder CLIs, so an unresolvable state rejects rather\n' +
    'than allows. If this is wrong, fix the state — do not bypass with --no-verify.\n'
  );
  process.exit(1);
}

/** Map a worktree directory name to a unit via autopilot.json's builders registry. */
function unitFromWorktree(worktreeRoot, mainRoot) {
  if (path.resolve(worktreeRoot) === path.resolve(mainRoot)) return 'ORCH';

  const raw = fs.readFileSync(path.join(mainRoot, 'autopilot.json'), 'utf-8');
  const builders = (JSON.parse(raw) || {}).builders;

  // Registry is dual-shape (scripts/builder_registry.py): a flat active array, or
  // {active:[], defined:{}}. Only the object shape carries worktree_suffix, which is
  // what we need; a flat-array registry cannot be mapped and must fail closed.
  const defined = builders && typeof builders === 'object' ? builders.defined : null;
  if (!defined || typeof defined !== 'object') {
    failClosed(
      "  autopilot.json's builders registry has no `defined` map, so a worktree cannot be\n" +
      '  resolved to a unit. Territory cannot be determined.'
    );
  }

  const dirName = path.basename(path.resolve(worktreeRoot));
  const projectName = path.basename(path.resolve(mainRoot));
  const matches = [];
  for (const [unitId, cfg] of Object.entries(defined)) {
    const suffix = cfg && cfg.worktree_suffix;
    if (!suffix) continue;
    if (dirName === `wt-${suffix}-${projectName}`) matches.push(unitId.toUpperCase());
  }

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    failClosed(
      `  Worktree '${dirName}' matches more than one unit (${matches.join(', ')}) in the\n` +
      '  builders registry. Ambiguous ownership cannot be resolved safely.'
    );
  }
  failClosed(
    `  Commit is being made from '${dirName}', which is neither the main checkout\n` +
    `  ('${projectName}') nor a registered builder worktree (expected wt-<suffix>-${projectName}\n` +
    '  for one of the worktree_suffix values in autopilot.json). Refusing to guess which\n' +
    '  territory applies.'
  );
}

function main() {
  const cwd = process.cwd();
  const worktreeRoot = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const commonDir = git(['rev-parse', '--git-common-dir'], cwd).trim();
  const mainRoot = path.dirname(path.resolve(worktreeRoot, commonDir));

  const unitId = unitFromWorktree(worktreeRoot, mainRoot);

  // Point lib at the main checkout so controlMode()/knownUnits() read coordination
  // truth rather than the worktree branch's possibly-stale copy.
  process.env.CLAUDE_PROJECT_DIR = mainRoot;
  const lib = require(path.join(mainRoot, 'hooks', 'lib.js'));

  if (unitId === 'ORCH') return 0; // main checkout; ORCH discipline is review-enforced

  // Cross-check the environment when it is present. Disagreement means the commit is
  // happening somewhere other than where the dispatcher thinks it is — never guess.
  const envUnit = process.env.DEVTEAM_UNIT
    ? String(process.env.DEVTEAM_UNIT).toUpperCase()
    : null;
  if (envUnit && envUnit !== unitId) {
    failClosed(
      `  DEVTEAM_UNIT='${envUnit}' but this worktree belongs to ${unitId}.\n` +
      '  A unit is committing into another unit\'s worktree, or the dispatcher launched\n' +
      '  with the wrong identity. Both are territory violations in the making.'
    );
  }

  const planPath = path.join(mainRoot, 'PLAN.md');
  let planText;
  try {
    planText = fs.readFileSync(planPath, 'utf-8');
  } catch (_e) {
    failClosed(`  Cannot read the coordination blackboard at ${planPath}.\n  Territory is undefined, so no commit can be authorised.`);
  }

  const tasks = lib.parsePlan(planText);
  const active = lib.activeTasksFor(tasks, unitId);
  if (active.length === 0) {
    failClosed(
      `  Unit ${unitId} has no active (claimed/in_progress/needs_review) task in PLAN.md,\n` +
      '  so it owns no territory and may not commit. If you are resuming, the dispatcher\n' +
      '  should have claimed your task before the session started.'
    );
  }

  const territories = active.flatMap(lib.ownedPathsOf);
  const activeIds = active.map((t) => t.task_id);
  const strict = lib.controlMode() === 'strict';

  const staged = git(['diff', '--cached', '--name-only', '-z'], cwd)
    .split('\0')
    .filter(Boolean);
  if (staged.length === 0) return 0; // nothing staged (e.g. --amend of message only)

  const violations = [];
  for (const rel of staged) {
    // A builder's own dossier is its heartbeat and is always permitted; any other
    // dossier is not. Mirrors territory-firewall.js's strict-mode positive rule.
    if (rel.startsWith('dossiers/')) {
      if (activeIds.some((id) => rel === `dossiers/${id}.md`)) continue;
      violations.push([rel, `only your own active task's dossier is writable (${activeIds.map((i) => `dossiers/${i}.md`).join(' or ')})`]);
      continue;
    }

    if (rel === 'PLAN.md') {
      if (strict) {
        violations.push([rel, 'PLAN.md is supervisor-only in control.mode=strict — report state via a devteam-control block']);
        continue;
      }
      continue; // legacy mode: block-level discipline is enforced downstream
    }

    if (lib.pathInAnyGlob(rel, lib.PROTECTED_FOR_BUILDERS) &&
        !lib.pathInAnyException(rel, lib.PROTECTED_EXCEPTIONS)) {
      violations.push([rel, 'protected path — hard prohibition for builders']);
      continue;
    }

    if (!lib.pathInAnyGlob(rel, territories)) {
      violations.push([rel, 'outside Owned_Paths']);
    }
  }

  if (violations.length > 0) {
    const listed = violations.map(([p, why]) => `    ${p}\n        ${why}`).join('\n');
    failClosed(
      `  Unit ${unitId}, active task(s) ${activeIds.join(', ')}.\n` +
      `  ${violations.length} staged path(s) are not in your territory:\n\n` +
      listed + '\n\n' +
      `  Your Owned_Paths: ${territories.join(', ') || '(none defined)'}\n\n` +
      '  Unstage them (git restore --staged <path>). If a file is genuinely required,\n' +
      '  stop and report blocked with Blocked_Reason: OWNERSHIP_CONFLICT, listing the\n' +
      '  exact paths, so ORCH can re-carve the territory.'
    );
  }

  return 0;
}

try {
  process.exit(main());
} catch (e) {
  // Deliberately NOT fail-open — see header note 1.
  failClosed(`  Unexpected hook error: ${e && e.message ? e.message : String(e)}`);
}
