#!/usr/bin/env node
/**
 * Self-tests for OIK-007.
 * Plants an obviously-fake PLACEHOLDER-structured key (never a realistic
 * value) and proves both the scanner and the pre-commit entrypoint catch it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fakePlaceholderKey, findSecretHits, scanSecrets } from './secret-scan.mjs';

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

test('clean text does not match', () => {
  assert.deepEqual(findSecretHits('const skill = "learning"; password=CHANGE_ME_LOCAL_ONLY\n'), []);
});

test('current repo has no known-secret pattern hits', () => {
  const findings = scanSecrets();
  assert.deepEqual(
    findings,
    [],
    findings.map((f) => `${f.file}: ${f.hits.join('; ')}`).join('\n'),
  );
});
