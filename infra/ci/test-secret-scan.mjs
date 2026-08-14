#!/usr/bin/env node
/**
 * Self-tests for OIK-007.
 * Plants an obviously-fake PLACEHOLDER-structured key (never a realistic
 * value) and proves both the scanner and the pre-commit entrypoint catch it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  fakePlaceholderKey,
  findSecretHits,
  scanSecrets,
  SECRET_SCAN_EXEMPT_FILES,
} from './secret-scan.mjs';
import { repoRoot } from './lib/walk.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = join(here, 'hooks', 'pre-commit');

test('planted PLACEHOLDER-structured fake key is caught', () => {
  const fake = fakePlaceholderKey();
  assert.match(fake, /PLACEHOLDER/);
  assert.ok(findSecretHits(fake).includes('OpenAI/Anthropic-style API key'));

  const dir = mkdtempSync(join(tmpdir(), 'oik-secret-'));
  const planted = join(dir, 'planted.env');
  try {
    writeFileSync(planted, `API_TOKEN=${fake}\n`, 'utf8');
    const findings = scanSecrets({ root: dir, files: [planted] });
    assert.equal(findings.length, 1);
    assert.ok(findings[0].hits.includes('OpenAI/Anthropic-style API key'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pre-commit hook invokes the same scanner on staged files', () => {
  const hook = readFileSync(hookPath, 'utf8');
  assert.match(hook, /secret-scan\.mjs/);
  assert.match(hook, /--staged/);
});

test('pre-commit scanner path catches a planted PLACEHOLDER key', () => {
  const fake = fakePlaceholderKey();
  const dir = mkdtempSync(join(tmpdir(), 'oik-precommit-'));
  const planted = join(dir, 'staged.txt');
  try {
    writeFileSync(planted, `export const k = "${fake}";\n`, 'utf8');
    const findings = scanSecrets({ root: dir, files: [planted] });
    assert.equal(findings.length, 1, 'pre-commit code path must block the planted fixture');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('staged index with a planted PLACEHOLDER key is blocked', () => {
  const fake = fakePlaceholderKey();
  const dir = mkdtempSync(join(tmpdir(), 'oik-staged-'));
  try {
    const init = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    spawnSync('git', ['config', 'user.email', 'ci@example.test'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'ci'], { cwd: dir });
    writeFileSync(join(dir, 'planted.env'), `API_TOKEN=${fake}\n`, 'utf8');
    const add = spawnSync('git', ['add', 'planted.env'], { cwd: dir, encoding: 'utf8' });
    assert.equal(add.status, 0, add.stderr);
    const findings = scanSecrets({ root: dir, staged: true });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'planted.env');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clean text does not match', () => {
  assert.deepEqual(findSecretHits('const skill = "learning"; password=CHANGE_ME_LOCAL_ONLY\n'), []);
});

test('exemption is exactly hooks/run-tests.js — not a glob', () => {
  assert.deepEqual([...SECRET_SCAN_EXEMPT_FILES], ['hooks/run-tests.js']);
});

test('hooks/run-tests.js pack fixtures are exempt; a sibling file is not', () => {
  const fake = fakePlaceholderKey();
  const root = mkdtempSync(join(tmpdir(), 'oik-exempt-'));
  try {
    mkdirSync(join(root, 'hooks'));
    writeFileSync(join(root, 'hooks', 'run-tests.js'), `const k = "${fake}";\n`, 'utf8');
    writeFileSync(join(root, 'hooks', 'other.js'), `const k = "${fake}";\n`, 'utf8');
    const findings = scanSecrets({ root });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'hooks/other.js');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live hooks/run-tests.js would match if not exempt (pack corpus)', () => {
  const live = join(repoRoot(), 'hooks', 'run-tests.js');
  if (!existsSync(live)) return;
  const hits = findSecretHits(readFileSync(live, 'utf8'));
  assert.ok(hits.length > 0, 'pack fixture corpus is why the named exemption exists');
});

test('current repo has no known-secret pattern hits (after Amendment A exemption)', () => {
  const findings = scanSecrets();
  assert.deepEqual(
    findings,
    [],
    findings.map((f) => `${f.file}: ${f.hits.join('; ')}`).join('\n'),
  );
});
