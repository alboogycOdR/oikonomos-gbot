#!/usr/bin/env node
/**
 * test-territory-precommit.js — self-test for the ADR-002 §5 territory pre-commit hook.
 *
 * Builds a throwaway git repo with its own PLAN.md, autopilot.json and a registered
 * builder worktree, installs the real hook into it, and drives REAL `git commit`
 * invocations. Every assertion is a commit that must either land or be refused —
 * nothing here inspects the hook's source or trusts its return value in isolation.
 *
 * The catch direction and the pass direction are asserted separately, because a hook
 * that rejects everything would satisfy "violations are blocked" while being useless.
 *
 * Run: node hooks/test-territory-precommit.js
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;
const failures = [];

function ok(name) { pass += 1; console.log(`  PASS  ${name}`); }
function bad(name, detail) {
  fail += 1;
  failures.push(`${name}\n        ${String(detail).split('\n').join('\n        ')}`);
  console.log(`  FAIL  ${name}`);
}

function git(args, cwd, env) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(env || {}) },
  });
}

/** Attempt a commit; returns {committed:boolean, stderr:string}. */
function tryCommit(cwd, message, env) {
  const r = spawnSync('git', ['commit', '-m', message], {
    cwd, encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e.st',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e.st',
      ...(env || {}),
    },
  });
  return { committed: r.status === 0, stderr: (r.stderr || '') + (r.stdout || '') };
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

/** Stage a path, attempt commit, then unstage+remove whatever survived. */
function attempt(wt, rel, content, message, env) {
  write(wt, rel, content);
  git(['add', '--', rel], wt);
  const res = tryCommit(wt, message, env);
  if (!res.committed) {
    try { git(['restore', '--staged', '--', rel], wt); } catch (_e) { /* nothing staged */ }
    try { fs.rmSync(path.join(wt, rel), { force: true }); } catch (_e) { /* gone */ }
  }
  return res;
}

function planFor(entries) {
  // entries: [{id, status, unit, owned}]
  const blocks = entries.map((e) => `### ${e.id}
**Title:** test task ${e.id}
**Status:** ${e.status}
**Assigned_To:** ${e.unit}
**Priority:** high
**Spec_References:** specs/none.md
**Owned_Paths:** ${e.owned}
**Depends_On:** —
**Description:** fixture.
**Acceptance_Criteria:**
- [ ] fixture
**Branch:** —
**Started_At:** —
**Progress_Notes:** —
**Artifacts:** —
**Test_Evidence:** —
**Review_Findings:** —
**Blocked_Reason:** —
**Updated_By:** ORCH
**Updated_At:** 2026-08-15T00:00:00Z`).join('\n\n');

  return `---
plan_version: 1.0
last_updated: 2026-08-15T00:00:00Z
overall_status: in_progress
orchestrator_notes: "test fixture"
---

# Project Plan

## Work Items

${blocks}
`;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terrhook-'));
  // Project dir name is load-bearing: worktrees are wt-<suffix>-<projectname>.
  const project = 'proj';
  const main_ = path.join(tmp, project);
  fs.mkdirSync(main_, { recursive: true });

  try {
    git(['init', '-q', '-b', 'master'], main_);
    git(['config', 'user.name', 'test'], main_);
    git(['config', 'user.email', 't@e.st'], main_);

    // Real hook + real lib — not a stand-in.
    fs.mkdirSync(path.join(main_, 'hooks'), { recursive: true });
    fs.copyFileSync(path.join(SRC, 'hooks', 'lib.js'), path.join(main_, 'hooks', 'lib.js'));
    fs.copyFileSync(
      path.join(SRC, 'hooks', 'territory-precommit.js'),
      path.join(main_, 'hooks', 'territory-precommit.js')
    );

    write(main_, 'autopilot.json', JSON.stringify({
      control: { mode: 'strict' },
      builders: {
        active: ['GB', 'CX'],
        defined: {
          GB: { cli: 'grok', worktree_suffix: 'grok', branch_suffix: 'gb' },
          CX: { cli: 'codex', worktree_suffix: 'codex', branch_suffix: 'cx' },
        },
      },
    }, null, 2));

    write(main_, 'PLAN.md', planFor([
      { id: 'TASK-001', status: 'in_progress', unit: 'GB', owned: 'packages/db/src/**, packages/db/test/**' },
      { id: 'TASK-002', status: 'pending', unit: 'CX', owned: 'packages/audit/src/**' },
    ]));
    write(main_, 'packages/db/src/keep.ts', 'export const a = 1;\n');
    git(['add', '-A'], main_);
    git(['commit', '-q', '-m', 'base'], main_);

    // Install the real hook via the real installer.
    const inst = spawnSync('powershell', [
      '-ExecutionPolicy', 'Bypass', '-File',
      path.join(SRC, 'scripts', 'install_git_hooks.ps1'),
    ], { cwd: main_, encoding: 'utf-8', env: { ...process.env } });
    // The installer resolves its repo root from its own location, so point it at the
    // fixture by copying the generated hook if it landed in the source repo instead.
    const fixtureHook = path.join(main_, '.git', 'hooks', 'pre-commit');
    if (!fs.existsSync(fixtureHook)) {
      const srcHook = path.join(SRC, '.git', 'hooks', 'pre-commit');
      if (!fs.existsSync(srcHook)) {
        throw new Error('installer produced no hook to copy: ' + (inst.stderr || inst.stdout));
      }
      fs.mkdirSync(path.dirname(fixtureHook), { recursive: true });
      fs.copyFileSync(srcHook, fixtureHook);
    }

    const wtGrok = path.join(tmp, `wt-grok-${project}`);
    git(['worktree', 'add', '-q', '--detach', wtGrok, 'master'], main_);

    // --- catch direction ----------------------------------------------------
    let r = attempt(wtGrok, 'packages/policy/src/evil.ts', 'export const x = 1;\n', 'out of territory');
    if (!r.committed && /outside Owned_Paths|protected path/.test(r.stderr)) {
      ok('rejects a file outside Owned_Paths');
    } else {
      bad('rejects a file outside Owned_Paths', r.committed ? 'COMMIT LANDED' : r.stderr);
    }

    r = attempt(wtGrok, 'PLAN.md', 'tampered\n', 'plan edit');
    if (!r.committed && /supervisor-only|strict/.test(r.stderr)) {
      ok('rejects PLAN.md in control.mode=strict');
    } else {
      bad('rejects PLAN.md in control.mode=strict', r.committed ? 'COMMIT LANDED' : r.stderr);
    }
    try { git(['checkout', '--', 'PLAN.md'], wtGrok); } catch (_e) { /* ignore */ }

    r = attempt(wtGrok, 'dossiers/TASK-002.md', 'not mine\n', 'other dossier');
    if (!r.committed && /own active task/.test(r.stderr)) {
      ok("rejects another task's dossier");
    } else {
      bad("rejects another task's dossier", r.committed ? 'COMMIT LANDED' : r.stderr);
    }

    r = attempt(wtGrok, 'packages/db/src/mismatch.ts', 'export const m = 1;\n', 'unit mismatch', { DEVTEAM_UNIT: 'CX' });
    if (!r.committed && /belongs to GB|another unit/.test(r.stderr)) {
      ok('rejects when DEVTEAM_UNIT disagrees with the worktree');
    } else {
      bad('rejects when DEVTEAM_UNIT disagrees with the worktree', r.committed ? 'COMMIT LANDED' : r.stderr);
    }

    // --- pass direction (the half that proves it is not just "reject all") ---
    r = attempt(wtGrok, 'packages/db/src/feature.ts', 'export const f = 1;\n', 'in territory [TASK-001]');
    if (r.committed) {
      ok('ALLOWS a file inside Owned_Paths');
    } else {
      bad('ALLOWS a file inside Owned_Paths', r.stderr);
    }

    r = attempt(wtGrok, 'dossiers/TASK-001.md', '# log\n', 'own dossier [TASK-001]');
    if (r.committed) {
      ok("ALLOWS the unit's own active-task dossier");
    } else {
      bad("ALLOWS the unit's own active-task dossier", r.stderr);
    }

    write(main_, 'orch-file.md', 'orch writes freely\n');
    git(['add', '-A'], main_);
    r = tryCommit(main_, 'orch commit in main checkout');
    if (r.committed) {
      ok('ALLOWS ORCH in the main checkout');
    } else {
      bad('ALLOWS ORCH in the main checkout', r.stderr);
    }

    // --- fail-closed states -------------------------------------------------
    // CX's only task is `pending`, so CX owns no territory and must not commit.
    const wtCodex = path.join(tmp, `wt-codex-${project}`);
    git(['worktree', 'add', '-q', '--detach', wtCodex, 'master'], main_);
    r = attempt(wtCodex, 'packages/audit/src/x.ts', 'export const x = 1;\n', 'no active task');
    if (!r.committed && /no active/.test(r.stderr)) {
      ok('rejects a unit with no active task (pending is not territory)');
    } else {
      bad('rejects a unit with no active task', r.committed ? 'COMMIT LANDED' : r.stderr);
    }

    // A worktree that is not in the registry cannot be resolved to a unit.
    const wtRogue = path.join(tmp, 'wt-unknown-proj');
    git(['worktree', 'add', '-q', '--detach', wtRogue, 'master'], main_);
    r = attempt(wtRogue, 'packages/db/src/rogue.ts', 'export const r = 1;\n', 'rogue worktree');
    if (!r.committed && /registered builder worktree|Refusing to guess/.test(r.stderr)) {
      ok('rejects an unregistered worktree rather than guessing');
    } else {
      bad('rejects an unregistered worktree', r.committed ? 'COMMIT LANDED' : r.stderr);
    }

    // Unreadable PLAN.md => no territory can be proven => reject (fail closed).
    fs.rmSync(path.join(main_, 'PLAN.md'), { force: true });
    r = attempt(wtGrok, 'packages/db/src/noplan.ts', 'export const n = 1;\n', 'no plan');
    if (!r.committed && /coordination blackboard|Territory is undefined/.test(r.stderr)) {
      ok('FAILS CLOSED when PLAN.md is unreadable');
    } else {
      bad('FAILS CLOSED when PLAN.md is unreadable', r.committed ? 'COMMIT LANDED' : r.stderr);
    }
  } finally {
    try {
      // Detach worktrees before removing the tree so git does not complain later.
      execFileSync('git', ['worktree', 'prune'], { cwd: main_, stdio: 'ignore' });
    } catch (_e) { /* best effort */ }
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch (_e) { /* windows lock */ }
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFailures:\n  - ' + failures.join('\n  - ') + '\n');
    process.exit(1);
  }
  process.exit(0);
}

main();
