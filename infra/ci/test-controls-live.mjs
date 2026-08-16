#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
import {
  ATLAS_COVERAGE_TOLERANCE,
  PYTHON_CANDIDATES,
  checkAtlasCoverage,
  collectAtlasCoverageEvidence,
  loadWorkspacePackageGlobs,
  parsePnpmWorkspacePackageGlobs,
  resolvePythonInterpreter,
  workspaceDiscoveryError,
} from './lib/atlas-coverage.mjs';

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

const liveWorkflow = `jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test
`;
const liveRunLocal = `
jobs.push(run('build', 'pnpm', ['build']));
jobs.push(run('test', 'pnpm', ['test']));
`;

function baseline() {
  return {
    hook,
    coverage,
    queued: { exists: true, files: [] },
    config: structuredClone(config),
    packages: structuredClone(packages),
    workflow: liveWorkflow,
    runLocal: liveRunLocal,
    atlas: {
      error: null,
      indexed: ['docs/a.md'],
      indexable: ['docs/a.md'],
      missing: [],
      tolerance: ATLAS_COVERAGE_TOLERANCE,
      workspaceGlobs: ['packages/*'],
      droppedPackages: [],
    },
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
  assertInducedFailure('CI test job builds before test', (evidence) => {
    evidence.workflow = `jobs:
  test:
    steps:
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
`;
  });
  assertInducedFailure('ATLAS index coverage', (evidence) => {
    evidence.atlas = {
      error: null,
      indexed: ['docs/kept.md'],
      indexable: ['docs/kept.md', 'packages/policy/src/index.ts', 'packages/broker/src/index.ts'],
      missing: ['packages/policy/src/index.ts', 'packages/broker/src/index.ts'],
      tolerance: 0,
      workspaceGlobs: ['packages/*'],
      droppedPackages: [],
    };
  });
  const named = runLivenessChecks('/fixture', (() => {
    const evidence = baseline();
    evidence.atlas = {
      error: null,
      indexed: ['docs/kept.md'],
      indexable: ['docs/kept.md', 'packages/policy/src/index.ts', 'packages/broker/src/index.ts'],
      missing: ['packages/policy/src/index.ts', 'packages/broker/src/index.ts'],
      tolerance: 0,
      workspaceGlobs: ['packages/*'],
      droppedPackages: [],
    };
    return evidence;
  })()).find((item) => item.label === 'ATLAS index coverage');
  assert.match(named.detail, /packages\/policy\/src\/index\.ts/);
  assert.match(named.detail, /packages\/broker\/src\/index\.ts/);
  assert.match(named.detail, /missing 2 tracked indexable file/);
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

const POLICY_PACKAGE_FILES = [
  'packages/policy/package.json',
  'packages/policy/src/index.ts',
  'packages/policy/test/risk-tier.test.ts',
  'packages/policy/test/role-constraints.test.ts',
  'packages/policy/tsconfig.json',
  'packages/policy/vitest.config.ts',
];

const AGENT_PROVIDERS_PACKAGE_FILES = [
  'packages/agent-providers/package.json',
  'packages/agent-providers/src/index.ts',
  'packages/agent-providers/tsconfig.json',
  'packages/agent-providers/vitest.config.ts',
];

function writeFixtureAtlas(dbPath, paths) {
  const python = resolvePythonInterpreter();
  assert.ok(python, `fixture setup needs one of ${PYTHON_CANDIDATES.join(', ')}`);
  const script = [
    'import sqlite3, sys',
    'con = sqlite3.connect(sys.argv[1])',
    'con.execute("CREATE TABLE files (path TEXT PRIMARY KEY)")',
    'con.executemany("INSERT INTO files(path) VALUES (?)", [(p,) for p in sys.argv[2:]])',
    'con.commit()',
  ].join('\n');
  const result = spawnSync(python, ['-c', script, dbPath, ...paths], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('ATLAS coverage absorbs a miss inside the stated lag-window tolerance', () => {
  assert.equal(ATLAS_COVERAGE_TOLERANCE, 4, 'tolerance is the largest observed lag, not padded headroom');
  assert.equal(checkAtlasCoverage({
    error: null,
    indexed: ['docs/a.md'],
    indexable: ['docs/a.md', 'packages/shared/test/prng.ts'],
    missing: ['packages/shared/test/prng.ts'],
    tolerance: ATLAS_COVERAGE_TOLERANCE,
    workspaceGlobs: ['packages/*'],
    droppedPackages: [],
  }), null);
  const fourMissing = Array.from({ length: 4 }, (_, index) => `packages/shared/test/lag-${index}.ts`);
  assert.equal(checkAtlasCoverage({
    error: null,
    indexed: ['docs/a.md'],
    indexable: ['docs/a.md', ...fourMissing],
    missing: fourMissing,
    tolerance: ATLAS_COVERAGE_TOLERANCE,
    workspaceGlobs: ['packages/*'],
    droppedPackages: [],
  }), null, 'spec-time diagnosis of 4 missing files must still pass');
  const fiveMissing = [...fourMissing, 'packages/shared/test/lag-4.ts'];
  const fiveError = checkAtlasCoverage({
    error: null,
    indexed: ['docs/a.md'],
    indexable: ['docs/a.md', ...fiveMissing],
    missing: fiveMissing,
    tolerance: ATLAS_COVERAGE_TOLERANCE,
    workspaceGlobs: ['packages/*'],
    droppedPackages: [],
  });
  assert.match(fiveError, /missing 5 tracked indexable file/);
  assert.doesNotMatch(fiveError, /whole workspace package|package dropout/);
});

test('ATLAS coverage collector reads the main checkout index, not this worktree', () => {
  const evidence = collectAtlasCoverageEvidence(process.cwd());
  const expected = join(mainCheckoutRoot(), '.devteam', 'atlas.db');
  const loaded = loadWorkspacePackageGlobs(mainCheckoutRoot());
  assert.equal(evidence.dbPath, expected);
  assert.equal(evidence.mainRoot, mainCheckoutRoot());
  assert.equal(loaded.error, null);
  assert.deepEqual(evidence.workspaceGlobs, loaded.globs);
  assert.ok(evidence.workspaceGlobs.includes('packages/*'), 'workspace globs come from pnpm-workspace.yaml');
  assert.ok(evidence.workspaceGlobs.includes('services/*'), 'workspace globs come from pnpm-workspace.yaml');
  assert.deepEqual(evidence.droppedPackages, []);
  assert.equal(checkAtlasCoverage(evidence), null, JSON.stringify(evidence.missing));
});

test('ATLAS coverage fails when a whole workspace package drops out of the index', () => {
  assert.ok(
    POLICY_PACKAGE_FILES.length > ATLAS_COVERAGE_TOLERANCE,
    'package-dropout fixture must be larger than the lag window or the constant is not anchored',
  );
  const root = mkdtempSync(join(tmpdir(), 'oikonomos-atlas-package-drop-'));
  try {
    const kept = [
      'docs/decisions/ADR-005-control-liveness.md',
      'packages/shared/src/index.ts',
    ];
    const dbPath = join(root, 'atlas.db');
    writeFixtureAtlas(dbPath, kept);
    const evidence = collectAtlasCoverageEvidence(root, {
      mainRoot: root,
      dbPath,
      trackedFiles: [...kept, ...POLICY_PACKAGE_FILES],
      ignorePatterns: ['.git/', '.devteam/'],
      workspaceGlobs: ['packages/*'],
    });
    const error = checkAtlasCoverage(evidence);
    assert.ok(error, 'dropping packages/policy from the index must fail coverage');
    assert.match(error, /whole workspace package packages\/policy/);
    assert.match(error, /package dropout, not scan lag/);
    assert.match(error, new RegExp(`missing ${POLICY_PACKAGE_FILES.length} tracked indexable file`));
    for (const path of POLICY_PACKAGE_FILES) {
      assert.match(error, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.equal(livenessExitCode(runLivenessChecks(root, { ...baseline(), atlas: evidence })), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ATLAS coverage fails a 4-file package dropout at zero baseline inside the lag window', () => {
  assert.equal(
    AGENT_PROVIDERS_PACKAGE_FILES.length,
    ATLAS_COVERAGE_TOLERANCE,
    'this is the residual: package size equals the lag window',
  );
  const root = mkdtempSync(join(tmpdir(), 'oikonomos-atlas-zero-baseline-drop-'));
  try {
    const kept = [
      'docs/decisions/ADR-005-control-liveness.md',
      'packages/shared/src/index.ts',
    ];
    const dbPath = join(root, 'atlas.db');
    writeFixtureAtlas(dbPath, kept);
    const evidence = collectAtlasCoverageEvidence(root, {
      mainRoot: root,
      dbPath,
      trackedFiles: [...kept, ...AGENT_PROVIDERS_PACKAGE_FILES],
      ignorePatterns: ['.git/', '.devteam/'],
      workspaceGlobs: ['packages/*'],
    });
    assert.equal(evidence.missing.length, AGENT_PROVIDERS_PACKAGE_FILES.length);
    assert.equal(evidence.missing.length, evidence.tolerance);
    assert.ok(
      evidence.missing.length <= evidence.tolerance,
      'numeric lag check alone still would pass when missing equals the tolerance',
    );
    assert.match(
      checkAtlasCoverage({ ...evidence, droppedPackages: [], workspaceGlobs: [] }),
      /workspace package discovery is unobservable/i,
      'empty discovery must fail closed, not disable the structural assertion',
    );
    const error = checkAtlasCoverage(evidence);
    assert.ok(error, 'packages/agent-providers must fail structurally at zero baseline');
    assert.match(error, /whole workspace package packages\/agent-providers/);
    assert.match(error, /package dropout, not scan lag/);
    assert.doesNotMatch(error, /missing 4 tracked indexable file/);
    for (const path of AGENT_PROVIDERS_PACKAGE_FILES) {
      assert.match(error, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.equal(livenessExitCode(runLivenessChecks(root, { ...baseline(), atlas: evidence })), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ATLAS coverage discovers packages from the workspace file, not a hardcoded list', () => {
  const parsed = parsePnpmWorkspacePackageGlobs('packages:\n  - "packages/*"\n  - "services/*"\nonlyBuiltDependencies:\n  - esbuild\n');
  assert.deepEqual(parsed, ['packages/*', 'services/*']);
  assert.deepEqual(
    parsePnpmWorkspacePackageGlobs('packages: ["packages/*", "services/*"]\nonlyBuiltDependencies:\n  - esbuild\n'),
    ['packages/*', 'services/*'],
    'flow-style packages: [...] is legal YAML and must not parse to []',
  );
  const root = mkdtempSync(join(tmpdir(), 'oikonomos-atlas-new-pkg-'));
  try {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n  - "services/*"\n');
    const kept = ['docs/a.md', 'packages/shared/src/index.ts'];
    const newbie = [
      'packages/brand-new/package.json',
      'packages/brand-new/src/index.ts',
      'packages/brand-new/tsconfig.json',
    ];
    const dbPath = join(root, 'atlas.db');
    writeFixtureAtlas(dbPath, kept);
    const evidence = collectAtlasCoverageEvidence(root, {
      mainRoot: root,
      dbPath,
      trackedFiles: [...kept, ...newbie],
      ignorePatterns: ['.git/', '.devteam/'],
    });
    assert.deepEqual(evidence.workspaceGlobs, ['packages/*', 'services/*']);
    assert.equal(evidence.missing.length, newbie.length);
    assert.ok(evidence.missing.length <= ATLAS_COVERAGE_TOLERANCE);
    const error = checkAtlasCoverage(evidence);
    assert.ok(error, 'a new workspace package must be covered without a hardcoded name');
    assert.match(error, /whole workspace package packages\/brand-new/);
    assert.match(error, /package dropout, not scan lag/);
    for (const path of newbie) {
      assert.match(error, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: ["packages/*", "services/*"]\n');
    const flow = collectAtlasCoverageEvidence(root, {
      mainRoot: root,
      dbPath,
      trackedFiles: [...kept, ...newbie],
      ignorePatterns: ['.git/', '.devteam/'],
    });
    assert.deepEqual(flow.workspaceGlobs, ['packages/*', 'services/*']);
    assert.match(checkAtlasCoverage(flow), /whole workspace package packages\/brand-new/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ATLAS coverage fails closed when workspace package discovery returns nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'oikonomos-atlas-no-globs-'));
  try {
    const kept = ['docs/a.md', 'packages/shared/src/index.ts'];
    const dbPath = join(root, 'atlas.db');
    writeFixtureAtlas(dbPath, kept);

    const missingYaml = collectAtlasCoverageEvidence(root, {
      mainRoot: root,
      dbPath,
      trackedFiles: kept,
      ignorePatterns: ['.git/', '.devteam/'],
    });
    assert.match(checkAtlasCoverage(missingYaml), /pnpm-workspace\.yaml missing/i);
    assert.match(checkAtlasCoverage(missingYaml), /unobservable/i);
    assert.doesNotMatch(checkAtlasCoverage(missingYaml), /package dropout, not scan lag/);

    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\nonlyBuiltDependencies:\n  - esbuild\n');
    const emptyList = collectAtlasCoverageEvidence(root, {
      mainRoot: root,
      dbPath,
      trackedFiles: kept,
      ignorePatterns: ['.git/', '.devteam/'],
    });
    assert.match(checkAtlasCoverage(emptyList), /declared no package globs/i);
    assert.match(checkAtlasCoverage(emptyList), /unobservable/i);

    const loadedEmpty = loadWorkspacePackageGlobs(root);
    assert.deepEqual(loadedEmpty.globs, []);
    assert.match(loadedEmpty.error, /declared no package globs/i);

    assert.match(
      workspaceDiscoveryError({ workspaceGlobs: [], indexable: kept, mainRoot: root }),
      /no package globs loaded/i,
    );
    assert.match(
      checkAtlasCoverage({
        error: null,
        indexed: kept,
        indexable: kept,
        missing: [],
        tolerance: ATLAS_COVERAGE_TOLERANCE,
        workspaceGlobs: [],
        droppedPackages: [],
        mainRoot: root,
      }),
      /workspace package discovery is unobservable/i,
    );

    const unmapped = collectAtlasCoverageEvidence(root, {
      mainRoot: root,
      dbPath,
      trackedFiles: kept,
      ignorePatterns: ['.git/', '.devteam/'],
      workspaceGlobs: ['apps/*'],
    });
    assert.match(checkAtlasCoverage(unmapped), /no workspace package was mapped/i);
    assert.match(checkAtlasCoverage(unmapped), /unobservable/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ATLAS coverage diagnoses an unreadable workspace file instead of throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'oikonomos-atlas-ws-unreadable-'));
  try {
    const kept = ['docs/a.md', 'packages/shared/src/index.ts'];
    const dbPath = join(root, 'atlas.db');
    writeFixtureAtlas(dbPath, kept);
    mkdirSync(join(root, 'pnpm-workspace.yaml'));
    const loaded = loadWorkspacePackageGlobs(root);
    assert.match(loaded.error, /unreadable/i);
    assert.deepEqual(loaded.globs, []);
    const evidence = collectAtlasCoverageEvidence(root, {
      mainRoot: root,
      dbPath,
      trackedFiles: kept,
      ignorePatterns: ['.git/', '.devteam/'],
    });
    assert.match(checkAtlasCoverage(evidence), /unreadable/i);
    assert.match(checkAtlasCoverage(evidence), /pnpm-workspace\.yaml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ATLAS coverage still treats four misses inside a larger package as lag', () => {
  const root = mkdtempSync(join(tmpdir(), 'oikonomos-atlas-lag-not-drop-'));
  try {
    const shared = [
      'packages/shared/package.json',
      'packages/shared/src/index.ts',
      'packages/shared/src/canonicalJson.ts',
      'packages/shared/src/actionDigest.ts',
      'packages/shared/test/prng.ts',
      'packages/shared/tsconfig.json',
      'packages/shared/vitest.config.ts',
    ];
    const lag = shared.slice(0, 4);
    const indexed = ['docs/a.md', ...shared.slice(4)];
    const dbPath = join(root, 'atlas.db');
    writeFixtureAtlas(dbPath, indexed);
    const evidence = collectAtlasCoverageEvidence(root, {
      mainRoot: root,
      dbPath,
      trackedFiles: ['docs/a.md', ...shared],
      ignorePatterns: ['.git/', '.devteam/'],
      workspaceGlobs: ['packages/*'],
    });
    assert.deepEqual(evidence.missing, lag);
    assert.deepEqual(evidence.droppedPackages, []);
    assert.equal(checkAtlasCoverage(evidence), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ATLAS coverage fails when pointed at an index missing tracked files', () => {
  const root = mkdtempSync(join(tmpdir(), 'oikonomos-atlas-coverage-'));
  try {
    const dbPath = join(root, 'atlas.db');
    writeFixtureAtlas(dbPath, ['docs/kept.md']);
    const evidence = collectAtlasCoverageEvidence(root, {
      mainRoot: root,
      dbPath,
      trackedFiles: [
        'docs/kept.md',
        'packages/policy/src/index.ts',
        'packages/broker/src/index.ts',
      ],
      ignorePatterns: ['.git/', '.devteam/'],
      workspaceGlobs: ['packages/*'],
      tolerance: 0,
    });
    const error = checkAtlasCoverage(evidence);
    assert.ok(error, 'missing tracked files must fail the coverage check');
    assert.match(error, /packages\/policy\/src\/index\.ts/);
    assert.match(error, /packages\/broker\/src\/index\.ts/);
    assert.match(error, /missing 2 tracked indexable file/);
    assert.equal(livenessExitCode(runLivenessChecks(root, { ...baseline(), atlas: evidence })), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ATLAS coverage fails closed on an absent or unreadable main-checkout index', () => {
  const missing = collectAtlasCoverageEvidence('/fixture', {
    mainRoot: '/fixture',
    dbPath: join(tmpdir(), 'oikonomos-no-such-atlas.db'),
    trackedFiles: ['packages/policy/src/index.ts'],
  });
  assert.match(checkAtlasCoverage(missing), /ATLAS index missing|unobservable/i);

  const root = mkdtempSync(join(tmpdir(), 'oikonomos-atlas-garbage-'));
  try {
    const dbPath = join(root, 'atlas.db');
    writeFileSync(dbPath, 'not a sqlite database');
    const garbage = collectAtlasCoverageEvidence(root, {
      mainRoot: root,
      dbPath,
      trackedFiles: ['packages/policy/src/index.ts'],
    });
    assert.match(checkAtlasCoverage(garbage), /unreadable/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ATLAS coverage fails closed when git ls-files returns no tracked files', () => {
  const evidence = collectAtlasCoverageEvidence('/fixture', {
    mainRoot: '/fixture',
    dbPath: join(tmpdir(), 'oikonomos-empty-tracked-atlas.db'),
    indexedPaths: [],
    trackedFiles: [],
  });
  assert.match(checkAtlasCoverage(evidence), /no tracked files/i);
  assert.match(checkAtlasCoverage(evidence), /unobservable/i);
});

test('ATLAS coverage names a missing Python interpreter instead of a corrupt index', () => {
  const emptyPath = mkdtempSync(join(tmpdir(), 'oikonomos-atlas-nopy-'));
  try {
    const env = { ...process.env, PATH: emptyPath, Path: emptyPath };
    assert.equal(resolvePythonInterpreter(env), null);
    const dbPath = join(emptyPath, 'atlas.db');
    writeFileSync(dbPath, 'placeholder-not-read-without-python');
    const evidence = collectAtlasCoverageEvidence('/fixture', {
      mainRoot: '/fixture',
      dbPath,
      trackedFiles: ['packages/policy/src/index.ts'],
      env,
    });
    const error = checkAtlasCoverage(evidence);
    assert.match(error, /Python interpreter missing/i);
    assert.match(error, /python, python3, py/);
    assert.doesNotMatch(error, /unreadable ATLAS index/i);
  } finally {
    rmSync(emptyPath, { recursive: true, force: true });
  }
});

test('ATLAS coverage fails closed when the main checkout cannot be resolved', () => {
  const root = mkdtempSync(join(tmpdir(), 'oikonomos-atlas-nogit-'));
  try {
    const evidence = collectAtlasCoverageEvidence(root, {
      env: {
        ...process.env,
        GIT_DIR: join(root, 'missing.git'),
        GIT_WORK_TREE: root,
      },
    });
    assert.match(checkAtlasCoverage(evidence), /cannot resolve the main checkout/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
