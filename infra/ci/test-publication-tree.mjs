#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyPublicationTree } from './publication-tree.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function fixtureRepository({ executableFile = false, ignoredTrackedFile = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oik-publication-fixture-'));
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'ci@example.invalid']);
  git(root, ['config', 'user.name', 'CI']);
  writeFileSync(join(root, '.gitignore'), 'ignored-source.txt\n', 'utf8');
  writeFileSync(join(root, 'published.txt'), 'published\n', 'utf8');
  if (executableFile) writeFileSync(join(root, 'executable.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
  if (ignoredTrackedFile) writeFileSync(join(root, 'ignored-source.txt'), 'must remain published\n', 'utf8');
  git(root, ['add', '.gitignore', 'published.txt', ...(executableFile ? ['executable.sh'] : [])]);
  if (executableFile) git(root, ['update-index', '--chmod=+x', 'executable.sh']);
  if (ignoredTrackedFile) git(root, ['add', '-f', 'ignored-source.txt']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
}

test('publication tree reproduces a clean repository', () => {
  const root = fixtureRepository({ executableFile: true });
  try {
    const result = verifyPublicationTree({ root });
    assert.equal(result.matches, true, JSON.stringify(result));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracked file swallowed by .gitignore fails the publication proof', () => {
  const root = fixtureRepository({ ignoredTrackedFile: true });
  try {
    const result = verifyPublicationTree({ root });
    assert.equal(result.matches, false);
    assert.deepEqual(result.omitted, ['ignored-source.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
