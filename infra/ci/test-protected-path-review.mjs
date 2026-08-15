#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  APPROVAL_MARKER,
  PROTECTED_PATHS,
  checkProtectedPathReview,
  isProtectedPath,
} from './protected-path-review.mjs';

const scriptPath = fileURLToPath(new URL('./protected-path-review.mjs', import.meta.url));
const codeownersPath = fileURLToPath(new URL('../../.github/CODEOWNERS', import.meta.url));

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function makeFixture(path) {
  const root = mkdtempSync(join(tmpdir(), 'oik-protected-review-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'ci@example.test']);
  git(root, ['config', 'user.name', 'ci']);
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'baseline']);
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'changed\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'change']);
  return { root, base };
}

function runGate(root, base, approvalMarker) {
  const args = [scriptPath, '--root', root, '--base', base];
  if (approvalMarker) args.push('--approval-marker', approvalMarker);
  return spawnSync('node', args, { encoding: 'utf8' });
}

test('every protected path required by CLAUDE.md has a review rule', () => {
  assert.deepEqual(PROTECTED_PATHS, [
    'packages/broker/**',
    'packages/policy/**',
    'packages/approvals/**',
    'packages/harness-factory/**',
    'infra/ci/**',
    'docs/decisions/**',
    '.claude/**',
    '.codex/**',
    'hooks/**',
    '.github/CODEOWNERS',
    '.github/workflows/**',
  ]);
});

test('CODEOWNERS covers every local protected-path rule', () => {
  const paths = readFileSync(codeownersPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('/'))
    .map((line) => line.split(/\s+/)[0].slice(1));
  for (const pattern of PROTECTED_PATHS) {
    assert.ok(paths.includes(pattern), `CODEOWNERS is missing ${pattern}`);
  }
});

test('a protected diff without approval is blocked', () => {
  const result = checkProtectedPathReview({ paths: ['packages/broker/src/handler.ts'] });
  assert.deepEqual(result.protectedPaths, ['packages/broker/src/handler.ts']);
  assert.equal(result.approved, false);
});

test('the local check script exits non-zero for an unapproved protected diff', () => {
  const fixture = makeFixture('packages/broker/src/handler.ts');
  try {
    const result = runGate(fixture.root, fixture.base);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /missing the Fable approval marker/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a clean diff passes without an approval marker', () => {
  const result = checkProtectedPathReview({ paths: ['packages/shared/src/digest.ts'] });
  assert.deepEqual(result.protectedPaths, []);
  assert.equal(result.approved, true);
});

test('the local check script exits zero for an unprotected diff', () => {
  const fixture = makeFixture('packages/shared/src/digest.ts');
  try {
    const result = runGate(fixture.root, fixture.base);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clean diff/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a protected diff passes after the required marker', () => {
  const result = checkProtectedPathReview({
    paths: ['infra/ci/protected-path-review.mjs'],
    approvalMarker: APPROVAL_MARKER,
  });
  assert.equal(result.approved, true);
});

test('control-plane configuration paths are protected', () => {
  assert.equal(isProtectedPath('.claude/settings.local.json'), true);
  assert.equal(isProtectedPath('.claude/agents/reviewer.md'), true);
  assert.equal(isProtectedPath('.claude/commands/review.md'), true);
  assert.equal(isProtectedPath('.codex/config.toml'), true);
  assert.equal(isProtectedPath('.codex/agents/reviewer.toml'), true);
  assert.equal(isProtectedPath('hooks/territory-precommit.js'), true);
});
