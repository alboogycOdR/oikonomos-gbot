#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  isReservedHostname,
  providerEnvironmentNames,
  scanNegativeControls,
} from './negative-controls.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(root, relativePath, content) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

test('reserved fixture hostnames are accepted', () => {
  for (const hostname of ['broker.example.invalid', 'service.test', 'example.com', 'local.dev.localhost']) {
    assert.equal(isReservedHostname(hostname), true, hostname);
  }
});

test('clean fixture is accepted', () => {
  const root = mkdtempSync(join(tmpdir(), 'oik-negative-clean-'));
  try {
    fixture(root, 'test/fixtures/safe.json', '{"url":"https://broker.example.invalid"}\n');
    assert.deepEqual(scanNegativeControls({ root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('planted provider variable name and live hostname are both rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'oik-negative-bad-'));
  const providerName = providerEnvironmentNames().find((name) => name.startsWith('OPENAI'));
  try {
    fixture(root, 'test/fixtures/bad.env', `${providerName}=PLACEHOLDER\nhttps://api.vendor.example.com\n`);
    const findings = scanNegativeControls({ root });
    assert.ok(findings.some((finding) => finding.kind === 'provider-env-name' && finding.value === providerName));
    assert.ok(findings.some((finding) => finding.kind === 'live-hostname' && finding.value === 'api.vendor.example.com'));

    const command = spawnSync('node', [join(here, 'negative-controls.mjs'), '--root', root], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(command.status, 1, command.stderr || command.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
