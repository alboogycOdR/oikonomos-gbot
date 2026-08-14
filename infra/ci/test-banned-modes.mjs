#!/usr/bin/env node
/**
 * Self-tests for OIK-004 / CAN-03.
 * Proves: allowlist is ADR-002 Amendment A; enforcement surfaces catch;
 * prose surfaces do not; a packages/ fixture fails; the current repo passes.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bannedTokens, scanBannedModes } from './banned-modes.mjs';
import {
  ENFORCEMENT_SURFACES,
  isAllowlisted,
  isEnforcementSurface,
  loadAllowlist,
  matchPath,
} from './lib/allowlist.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const allowlistPath = join(here, 'banned-modes-allowlist.txt');

const EXPECTED_ALLOWLIST = [
  'docs/**',
  'specs/**',
  'dossiers/**',
  'briefings/**',
  '.claude/commands/**',
  'PLAN.md',
  'REVIEW.md',
  'AUTOPILOT_LOG.md',
  'INSTINCTS.md',
  '*.md',
  'autopilot.json',
  'scripts/**',
];

const EXPECTED_ENFORCEMENT = [
  'packages/**',
  'apps/**',
  'services/**',
  'infra/**',
  'evals/**',
  '.github/**',
  '.claude/settings*.json',
  '.claude/agents/**',
];

test('allowlist cites ADR-002 Amendment A and is the prose + §2(2) set', () => {
  const raw = readFileSync(allowlistPath, 'utf8');
  assert.match(raw, /ADR-002/);
  assert.match(raw, /Amendment A/);
  assert.match(raw, /docs\/decisions\/ADR-002-permission-bypass-ban-scope\.md/);
  assert.deepEqual(loadAllowlist(allowlistPath), EXPECTED_ALLOWLIST);
  assert.deepEqual([...ENFORCEMENT_SURFACES], EXPECTED_ENFORCEMENT);
});

test('path globs: root *.md and settings*.json do not leak into nested dirs', () => {
  assert.equal(matchPath('PLAN.md', '*.md'), true);
  assert.equal(matchPath('DEVDEPARTMENT_HANDOVER_PROMPT.md', '*.md'), true);
  assert.equal(matchPath('docs/architecture/note.md', '*.md'), false);
  assert.equal(matchPath('.claude/settings.json', '.claude/settings*.json'), true);
  assert.equal(matchPath('.claude/settings.local.json', '.claude/settings*.json'), true);
  assert.equal(matchPath('.claude/agents/settings.json', '.claude/settings*.json'), false);
  assert.equal(isEnforcementSurface('packages/broker/src/index.ts'), true);
  assert.equal(isEnforcementSurface('.claude/settings.json'), true);
  assert.equal(isEnforcementSurface('.claude/commands/devteam-review.md'), false);
  assert.equal(isAllowlisted('specs/foo.md', EXPECTED_ALLOWLIST), true);
  assert.equal(isAllowlisted('packages/broker/src/index.ts', EXPECTED_ALLOWLIST), false);
});

test('each banned token in a temp packages/ path fails the scan', () => {
  const tokens = bannedTokens();
  assert.equal(tokens.length, 3);

  const root = mkdtempSync(join(tmpdir(), 'oik-banned-'));
  try {
    const pkgDir = join(root, 'packages', 'policy', 'src');
    mkdirSync(pkgDir, { recursive: true });
    const planted = join(pkgDir, 'violation.ts');

    for (const token of tokens) {
      writeFileSync(planted, `export const mode = ${JSON.stringify(token)};\n`, 'utf8');
      const { violations } = scanBannedModes({ root, allowlistPath });
      assert.ok(
        violations.some((v) => v.token === token && v.file === 'packages/policy/src/violation.ts'),
        `expected to catch ${token} under packages/`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enforcement surfaces catch even when someone lists them as carve-outs', () => {
  const token = bannedTokens()[0];
  const root = mkdtempSync(join(tmpdir(), 'oik-banned-enf-'));
  const override = join(root, 'override-allowlist.txt');
  try {
    writeFileSync(
      override,
      ['packages/**', 'apps/**', '.github/**', '.claude/agents/**', 'infra/**'].join('\n'),
      'utf8',
    );

    const planted = [
      ['packages/broker/src/bad.ts', 'packages/broker/src/bad.ts'],
      ['apps/dashboard/src/bad.ts', 'apps/dashboard/src/bad.ts'],
      ['.github/workflows/bad.yml', '.github/workflows/bad.yml'],
      ['.claude/settings.json', '.claude/settings.json'],
      ['.claude/settings.local.json', '.claude/settings.local.json'],
      ['.claude/agents/rogue.md', '.claude/agents/rogue.md'],
      ['infra/ci/bad.mjs', 'infra/ci/bad.mjs'],
      ['services/worker/src/bad.ts', 'services/worker/src/bad.ts'],
      ['evals/canary/bad.ts', 'evals/canary/bad.ts'],
    ];

    for (const [rel] of planted) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), `mentions ${token}\n`, 'utf8');
    }

    const { violations } = scanBannedModes({ root, allowlistPath: override });
    for (const [, expected] of planted) {
      assert.ok(
        violations.some((v) => v.file === expected && v.token === token),
        `expected enforcement catch at ${expected}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Amendment A prose and §2(2) surfaces are not violations', () => {
  const token = bannedTokens()[0];
  const root = mkdtempSync(join(tmpdir(), 'oik-banned-prose-'));
  try {
    const prose = [
      'docs/decisions/note.md',
      'specs/directive.md',
      'dossiers/TASK-004.md',
      'briefings/GROK_BUILD_BRIEFING.md',
      '.claude/commands/devteam-review.md',
      'PLAN.md',
      'REVIEW.md',
      'AUTOPILOT_LOG.md',
      'INSTINCTS.md',
      'CLAUDE.md',
      'DEVDEPARTMENT_HANDOVER_PROMPT.md',
      'autopilot.json',
      'scripts/dispatch.sh',
    ];
    mkdirSync(join(root, 'packages', 'broker', 'src'), { recursive: true });
    for (const rel of prose) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), `mentions ${token}\n`, 'utf8');
    }
    writeFileSync(join(root, 'packages', 'broker', 'src', 'ok.ts'), 'export const x = 1;\n', 'utf8');

    const { violations } = scanBannedModes({ root, allowlistPath });
    assert.deepEqual(violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('current repo has no hits outside the ADR-002 Amendment A allowlist', () => {
  const { violations } = scanBannedModes({ allowlistPath });
  assert.deepEqual(
    violations,
    [],
    violations.map((v) => `${v.file}:${v.line}:${v.token}`).join('\n'),
  );
});
