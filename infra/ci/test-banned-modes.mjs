#!/usr/bin/env node
/**
 * Self-tests for OIK-004 / CAN-03.
 * Proves: allowlist is the closed ADR-002 set; a planted packages/ violation
 * is caught for each token; an allowlisted hit is ignored.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bannedTokens, scanBannedModes } from './banned-modes.mjs';
import { loadAllowlist } from './lib/allowlist.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const allowlistPath = join(here, 'banned-modes-allowlist.txt');

const EXPECTED_ALLOWLIST = [
  'autopilot.json',
  'CLAUDE.md',
  'AGENTS.md',
  'docs/**',
  'docs/decisions/**',
  '.claude/commands/**',
  'briefings/**',
  'scripts/**',
];

test('allowlist cites ADR-002 and is exactly the §2 + §4 set', () => {
  const raw = readFileSync(allowlistPath, 'utf8');
  assert.match(raw, /ADR-002/);
  assert.match(raw, /docs\/decisions\/ADR-002-permission-bypass-ban-scope\.md/);
  assert.deepEqual(loadAllowlist(allowlistPath), EXPECTED_ALLOWLIST);
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

test('allowlisted documentation hit is not a violation', () => {
  const token = bannedTokens()[0];
  const root = mkdtempSync(join(tmpdir(), 'oik-banned-allow-'));
  try {
    mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
    mkdirSync(join(root, 'packages', 'broker', 'src'), { recursive: true });
    writeFileSync(join(root, 'docs', 'decisions', 'note.md'), `mentions ${token}\n`, 'utf8');
    writeFileSync(join(root, 'CLAUDE.md'), `mentions ${token}\n`, 'utf8');
    writeFileSync(join(root, 'packages', 'broker', 'src', 'ok.ts'), 'export const x = 1;\n', 'utf8');

    const { violations } = scanBannedModes({ root, allowlistPath });
    assert.deepEqual(violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('current repo has no hits outside the ADR-002 allowlist', () => {
  const { violations } = scanBannedModes({ allowlistPath });
  assert.deepEqual(
    violations,
    [],
    violations.map((v) => `${v.file}:${v.line}:${v.token}`).join('\n'),
  );
});
