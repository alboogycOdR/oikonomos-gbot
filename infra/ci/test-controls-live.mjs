#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  checkCoverageEvidence,
  checkControlQueue,
  checkDistFreshness,
  checkHookEvidence,
  collectControlQueueEvidence,
  collectHookRejectionEvidence,
  livenessExitCode,
  runLivenessChecks,
} from './controls-live.mjs';

const hook = { status: 1, output: '[territory-precommit] COMMIT REJECTED\n' };
const coverage = { status: 0, output: '% Coverage report from v8\nAll files | 100 | 100\n' };
const config = { builders: { active: ['CX'], defined: { CX: { model: 'test-model' } } } };
const packages = [{ name: 'packages/example', sourceFiles: [], distFiles: [] }];

function mainCheckoutRoot() {
  const commonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.equal(commonDir.status, 0);
  return dirname(resolve(process.cwd(), commonDir.stdout.trim()));
}

function baseline() {
  return {
    hook,
    coverage,
    queued: { exists: true, files: [] },
    config: structuredClone(config),
    packages: structuredClone(packages),
  };
}

function assertInducedFailure(name, mutate) {
  const evidence = baseline();
  mutate(evidence);
  const checks = runLivenessChecks('/fixture', evidence);
  const check = checks.find((item) => item.label === name);
  assert.equal(check.status, 1, `${name} must fail when its control is inert`);
  assert.equal(livenessExitCode(checks), 1, `${name} must make controls-live exit non-zero`);
}

test('each liveness assertion rejects its induced inert state', () => {
  assertInducedFailure('territory pre-commit hook', (evidence) => { evidence.hook = { status: 0, output: '' }; });
  assertInducedFailure('devteam control queue', (evidence) => { evidence.queued = { exists: true, files: ['stuck.json'] }; });
  assertInducedFailure('active builder model pins', (evidence) => { evidence.config.builders.defined.CX.model = null; });
  assertInducedFailure('policy coverage collection', (evidence) => { evidence.coverage = { status: 0, output: 'tests passed\n' }; });
  assertInducedFailure('workspace dist freshness', (evidence) => {
    evidence.packages = [{ name: 'packages/example', sourceFiles: ['/missing/source.ts'], distFiles: [] }];
  });
});

test('control queue distinguishes a missing directory from an empty drained queue', () => {
  assert.notEqual(checkControlQueue({ exists: false, files: [] }), null);
  assert.equal(checkControlQueue({ exists: true, files: [] }), null);
  assert.notEqual(checkControlQueue({ exists: true, files: ['stuck.json'] }), null);
});

test('control queue collector reads the main checkout queue, not this worktree queue', () => {
  const commonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.equal(commonDir.status, 0);
  const expected = join(dirname(resolve(process.cwd(), commonDir.stdout.trim())), '.devteam', 'control');
  assert.equal(collectControlQueueEvidence(process.cwd()).directory, expected);
});

test('coverage evidence accepts real ANSI-coloured Vitest output', () => {
  const result = spawnSync('pnpm', ['--filter', '@oikonomos/policy', 'test'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '1' },
    shell: process.platform === 'win32',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.match(output, /\u001B\[/, 'test must exercise captured ANSI-coloured output');
  assert.equal(checkCoverageEvidence({ status: result.status ?? 1, output }), null);
});

test('hook collector observes a real territory rejection through Git', () => {
  const result = collectHookRejectionEvidence(mainCheckoutRoot());
  assert.match(result.output, /\[territory-precommit\] COMMIT REJECTED/i);
  assert.equal(checkHookEvidence(result), null);
});

test('hook collector detects an inert exit-zero hook through an isolated hooks path', () => {
  const hookPath = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-commit'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.equal(hookPath.status, 0);
  const hooksPath = mkdtempSync(join(tmpdir(), 'oikonomos-controls-live-hooks-'));
  const fixtureHook = join(hooksPath, 'pre-commit');
  try {
    writeFileSync(fixtureHook, readFileSync(hookPath.stdout.trim()));
    chmodSync(fixtureHook, 0o755);
    const live = collectHookRejectionEvidence(mainCheckoutRoot(), { hooksPath });
    assert.match(live.output, /\[territory-precommit\] COMMIT REJECTED/i);
    writeFileSync(fixtureHook, '#!/bin/sh\nexit 0\n');
    chmodSync(fixtureHook, 0o755);
    const result = collectHookRejectionEvidence(mainCheckoutRoot(), { hooksPath });
    assert.equal(result.status, 0, 'exact inert hook must allow the staged fixture');
    assert.match(checkHookEvidence(result), /allowed an out-of-territory staged commit/);
  } finally {
    rmSync(hooksPath, { recursive: true, force: true });
  }
});

test('hook collector reports an unavailable builder worktree without blaming the hook', () => {
  const result = collectHookRejectionEvidence(mainCheckoutRoot(), {
    registry: { builders: { defined: { CX: { worktree_suffix: 'not-present' } } } },
  });
  assert.equal(result.status, 1);
  assert.match(result.output, /UNOBSERVABLE territory pre-commit hook from .*no registered builder worktree/i);
  assert.equal(checkHookEvidence(result), result.output.trim());
});

test('dist freshness catches output older than an existing source file', () => {
  const root = mkdtempSync(join(tmpdir(), 'oikonomos-controls-live-test-'));
  try {
    const source = join(root, 'src.ts');
    const dist = join(root, 'dist.js');
    writeFileSync(source, 'source');
    writeFileSync(dist, 'dist');
    const now = Date.now() / 1000;
    utimesSync(dist, now - 10, now - 10);
    utimesSync(source, now, now);
    assert.match(checkDistFreshness([{ name: 'packages/example', sourceFiles: [source], distFiles: [dist] }]), /10s behind src/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
