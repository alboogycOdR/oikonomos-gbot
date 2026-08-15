#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  checkCoverageEvidence,
  checkDistFreshness,
  checkHookEvidence,
  collectHookRejectionEvidence,
  livenessExitCode,
  runLivenessChecks,
} from './controls-live.mjs';

const hook = { status: 1, output: '[territory-precommit] COMMIT REJECTED\n' };
const coverage = { status: 0, output: '% Coverage report from v8\nAll files | 100 | 100\n' };
const config = { builders: { active: ['CX'], defined: { CX: { model: 'test-model' } } } };
const packages = [{ name: 'packages/example', sourceFiles: [], distFiles: [] }];

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
  const root = mkdtempSync(join(tmpdir(), 'oikonomos-controls-live-test-'));
  try {
    const missing = runLivenessChecks(root, { hook, coverage, config, packages });
    assert.equal(missing.find((item) => item.label === 'devteam control queue').status, 1);

    mkdirSync(join(root, '.devteam', 'control'), { recursive: true });
    const drained = runLivenessChecks(root, { hook, coverage, config, packages });
    assert.equal(drained.find((item) => item.label === 'devteam control queue').status, 0);

    writeFileSync(join(root, '.devteam', 'control', 'stuck.json'), '{}');
    const undrained = runLivenessChecks(root, { hook, coverage, config, packages });
    assert.equal(undrained.find((item) => item.label === 'devteam control queue').status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const result = collectHookRejectionEvidence(process.cwd());
  assert.match(result.output, /\[territory-precommit\] COMMIT REJECTED/i);
  assert.equal(checkHookEvidence(result), null);
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
