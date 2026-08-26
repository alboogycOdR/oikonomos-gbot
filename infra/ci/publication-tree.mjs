#!/usr/bin/env node
/**
 * Prove that the repository tree can be reproduced from its published archive.
 *
 * A tracked file that matches .gitignore is present in `git archive`, but is
 * silently omitted by `git add --all` in a clean clone. Comparing the two tree
 * objects makes that publication failure fail closed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function command(commandName, args, { cwd, encoding = 'utf8' } = {}) {
  const result = spawnSync(commandName, args, {
    cwd,
    encoding,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${commandName} ${args.join(' ')} failed: ${result.stderr || result.stdout || 'unknown error'}`);
  }
  return result.stdout;
}

function treeFiles(root, treeish) {
  return new Set(
    command('git', ['ls-tree', '-r', '--name-only', treeish], { cwd: root })
      .split(/\r?\n/)
      .filter(Boolean),
  );
}

function executableFiles(root, treeish) {
  return command('git', ['ls-tree', '-r', treeish], { cwd: root })
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((entry) => {
      const [metadata, file] = entry.split('\t');
      return metadata.startsWith('100755 ') ? [file] : [];
    });
}

function difference(left, right) {
  return [...left].filter((item) => !right.has(item)).sort();
}

export function verifyPublicationTree({ root = process.cwd(), ref = 'HEAD' } = {}) {
  const repository = resolve(root);
  const scratch = mkdtempSync(join(tmpdir(), 'oik-publication-tree-'));
  try {
    const archive = command('git', ['archive', '--format=tar', ref], { cwd: repository, encoding: null });
    const archivePath = join(scratch, 'publication.tar');
    writeFileSync(archivePath, archive);
    command('tar', ['-xf', 'publication.tar'], { cwd: scratch });
    rmSync(archivePath, { force: true });
    command('git', ['init', '--quiet'], { cwd: scratch });
    command('git', ['add', '--all'], { cwd: scratch });

    // Inspect the first scratch tree before restoring modes. A file omitted by
    // .gitignore cannot be passed to update-index, so only restore a mode when
    // that path survived the clean add. This keeps an ignored executable a
    // normal, diagnosable tree mismatch instead of a control-runtime error.
    const initiallyAddedTree = command('git', ['write-tree'], { cwd: scratch }).trim();
    const initiallyAddedFiles = treeFiles(scratch, initiallyAddedTree);

    // Windows tar extraction does not retain POSIX execute bits. Restore the
    // modes declared by the committed tree in the scratch index so write-tree
    // remains an exact comparison on every CI developer platform.
    for (const file of executableFiles(repository, ref)) {
      if (!initiallyAddedFiles.has(file)) continue;
      command('git', ['update-index', '--chmod=+x', '--', file], { cwd: scratch });
    }

    const expectedTree = command('git', ['rev-parse', `${ref}^{tree}`], { cwd: repository }).trim();
    const actualTree = command('git', ['write-tree'], { cwd: scratch }).trim();
    const expectedFiles = treeFiles(repository, ref);
    const actualFiles = treeFiles(scratch, actualTree);

    return {
      matches: expectedTree === actualTree,
      expectedTree,
      actualTree,
      omitted: difference(expectedFiles, actualFiles),
      unexpected: difference(actualFiles, expectedFiles),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { root: process.cwd(), ref: 'HEAD' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = argv[++index];
    else if (argument === '--ref') options.ref = argv[++index];
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write('Usage: node infra/ci/publication-tree.mjs [--root DIR] [--ref REVISION]\n');
      return 0;
    }
    const result = verifyPublicationTree(options);
    if (result.matches) {
      process.stdout.write(`publication-tree: clean (${result.expectedTree})\n`);
      return 0;
    }
    process.stderr.write(`publication-tree: tree mismatch\n  expected: ${result.expectedTree}\n  actual:   ${result.actualTree}\n`);
    if (result.omitted.length > 0) process.stderr.write(`  omitted from clean add: ${result.omitted.join(', ')}\n`);
    if (result.unexpected.length > 0) process.stderr.write(`  unexpected in clean add: ${result.unexpected.join(', ')}\n`);
    return 1;
  } catch (error) {
    process.stderr.write(`publication-tree: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
