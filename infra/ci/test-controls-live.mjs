#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { livenessExitCode, runLivenessChecks } from './controls-live.mjs';

const hook = { status: 0, output: '[install-hooks] installed: /fixture/.git/hooks/pre-commit\n' };
const coverage = { status: 0, output: '% Coverage report from v8\nAll files | 100 | 100\n' };
const config = { builders: { active: ['CX'], defined: { CX: { model: 'test-model' } } } };
const packages = [{ name: 'packages/example', sourceFiles: [], distFiles: [] }];

function baseline() {
  return {
    hook,
    coverage,
    queued: [],
    config,
    packages,
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
  assertInducedFailure('territory pre-commit hook', (evidence) => { evidence.hook = { status: 0, output: 'nothing installed\n' }; });
  assertInducedFailure('devteam control queue', (evidence) => { evidence.queued = ['stuck.json']; });
  assertInducedFailure('active builder model pins', (evidence) => { evidence.config.builders.defined.CX.model = null; });
  assertInducedFailure('policy coverage collection', (evidence) => { evidence.coverage = { status: 0, output: 'tests passed\n' }; });
  assertInducedFailure('workspace dist freshness', (evidence) => {
    evidence.packages = [{ name: 'packages/example', sourceFiles: ['/missing/source.ts'], distFiles: [] }];
  });
});
