#!/usr/bin/env node
/**
 * Self-tests for TASK-023: CI test job must build before it tests.
 *
 * Proves: the live workflow and run-local are in the required order; a
 * test-without-build workflow fails the check; a reversed run-local fails
 * the check; and `pnpm test` in a tree lacking dist cannot resolve a
 * workspace export (the failure the ordering exists to prevent).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  checkRunLocalTestJobOrder,
  checkTestJobBuildOrder,
  checkWorkflowTestJobOrder,
  extractJobRunSteps,
  pnpmScriptsInRuns,
} from './lib/test-job-order.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const goodWorkflow = `name: ci
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm lint
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test
  build:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm build
`;

const goodRunLocal = `
jobs.push(run('typecheck', 'pnpm', ['typecheck']));
jobs.push(run('build', 'pnpm', ['build']));
jobs.push(run('test', 'pnpm', ['test']));
`;

test('live CI test job runs pnpm build before pnpm test', () => {
  const yaml = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const scripts = pnpmScriptsInRuns(extractJobRunSteps(yaml, 'test'));
  assert.deepEqual(
    scripts.filter((name) => name === 'build' || name === 'test'),
    ['build', 'test'],
  );
  assert.equal(checkWorkflowTestJobOrder(yaml), null);
});

test('live run-local.mjs invokes pnpm build before pnpm test', () => {
  const source = readFileSync(join(here, 'run-local.mjs'), 'utf8');
  assert.equal(checkRunLocalTestJobOrder(source), null);
  assert.equal(checkTestJobBuildOrder({
    workflow: readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8'),
    runLocal: source,
  }), null);
});

test('a test job with no build step fails the check', () => {
  const yaml = `jobs:
  test:
    steps:
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
`;
  assert.match(checkWorkflowTestJobOrder(yaml), /no prior pnpm build/);
  assert.match(
    checkTestJobBuildOrder({ workflow: yaml, runLocal: goodRunLocal }),
    /no prior pnpm build/,
  );
});

test('a test job that tests before it builds fails the check', () => {
  const yaml = `jobs:
  test:
    steps:
      - run: pnpm test
      - run: pnpm build
`;
  assert.match(checkWorkflowTestJobOrder(yaml), /before pnpm build/);
});

test('a parallel build job does not satisfy the test job', () => {
  const yaml = `jobs:
  test:
    steps:
      - run: pnpm test
  build:
    steps:
      - run: pnpm build
`;
  assert.match(checkWorkflowTestJobOrder(yaml), /no prior pnpm build/);
});

test('run-local that tests first fails the check', () => {
  const source = `
jobs.push(run('test', 'pnpm', ['test']));
jobs.push(run('build', 'pnpm', ['build']));
`;
  assert.match(checkRunLocalTestJobOrder(source), /before pnpm build/);
});

test('run-local that never builds fails the check', () => {
  const source = `jobs.push(run('test', 'pnpm', ['test']));`;
  assert.match(checkRunLocalTestJobOrder(source), /no prior pnpm build/);
});

test('a well-ordered pair of fixtures passes', () => {
  assert.equal(checkTestJobBuildOrder({ workflow: goodWorkflow, runLocal: goodRunLocal }), null);
});

test('pnpm test without a prior build cannot resolve a workspace export when dist/ is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'oikonomos-test-job-order-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'order-fixture',
      private: true,
      packageManager: 'pnpm@10.23.0',
    }));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    mkdirSync(join(root, 'packages', 'lib', 'src'), { recursive: true });
    mkdirSync(join(root, 'packages', 'app', 'src'), { recursive: true });
    writeFileSync(join(root, 'packages', 'lib', 'package.json'), JSON.stringify({
      name: '@fixture/lib',
      type: 'module',
      exports: { '.': './dist/index.js' },
      scripts: { build: 'node ./build.mjs' },
    }));
    writeFileSync(join(root, 'packages', 'lib', 'src', 'index.js'), 'export const value = 1;\n');
    writeFileSync(
      join(root, 'packages', 'lib', 'build.mjs'),
      "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\nwriteFileSync('dist/index.js', 'export const value = 1;\\n');\n",
    );
    writeFileSync(join(root, 'packages', 'app', 'package.json'), JSON.stringify({
      name: '@fixture/app',
      type: 'module',
      dependencies: { '@fixture/lib': 'workspace:*' },
      scripts: { test: 'node --input-type=module -e "import { value } from \'@fixture/lib\'; if (value !== 1) process.exit(1)"' },
    }));

    const installIn = spawnSync('pnpm', ['install'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    assert.equal(installIn.status, 0, installIn.stderr || installIn.stdout);

    const withoutBuild = spawnSync('pnpm', ['--filter', '@fixture/app', 'test'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    assert.notEqual(withoutBuild.status, 0, 'test must fail when dist/ is absent');
    const combined = `${withoutBuild.stdout ?? ''}${withoutBuild.stderr ?? ''}`;
    assert.match(combined, /ERR_MODULE_NOT_FOUND|Cannot find module|Failed to resolve|ERR_PACKAGE_PATH_NOT_EXPORTED/i);

    const build = spawnSync('pnpm', ['--filter', '@fixture/lib', 'build'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const withBuild = spawnSync('pnpm', ['--filter', '@fixture/app', 'test'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    assert.equal(withBuild.status, 0, withBuild.stderr || withBuild.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
