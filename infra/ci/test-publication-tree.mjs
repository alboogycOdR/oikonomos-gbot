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

function fixtureRepository({ executableFile = false, ignoredTrackedFile = false, ignoredTrackedExecutable = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oik-publication-fixture-'));
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'ci@example.invalid']);
  git(root, ['config', 'user.name', 'CI']);
  const ignoredFile = ignoredTrackedExecutable ? 'ignored-source.sh' : 'ignored-source.txt';
  writeFileSync(join(root, '.gitignore'), `${ignoredFile}\n`, 'utf8');
  writeFileSync(join(root, 'published.txt'), 'published\n', 'utf8');
  if (executableFile) writeFileSync(join(root, 'executable.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
  if (ignoredTrackedFile) writeFileSync(join(root, ignoredFile), '#!/bin/sh\nexit 0\n', 'utf8');
  git(root, ['add', '.gitignore', 'published.txt', ...(executableFile ? ['executable.sh'] : [])]);
  if (executableFile) git(root, ['update-index', '--chmod=+x', 'executable.sh']);
  if (ignoredTrackedFile) git(root, ['add', '-f', ignoredFile]);
  if (ignoredTrackedExecutable) git(root, ['update-index', '--chmod=+x', ignoredFile]);
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

test('tracked executable swallowed by .gitignore reports an omission', () => {
  const root = fixtureRepository({ executableFile: true, ignoredTrackedFile: true, ignoredTrackedExecutable: true });
  try {
    const result = verifyPublicationTree({ root });
    assert.equal(result.matches, false);
    assert.deepEqual(result.omitted, ['ignored-source.sh']);

    const command = spawnSync('node', [join(process.cwd(), 'infra/ci/publication-tree.mjs'), '--root', root], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(command.status, 1, command.stderr || command.stdout);
    assert.match(command.stderr, /omitted from clean add: ignored-source\.sh/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
