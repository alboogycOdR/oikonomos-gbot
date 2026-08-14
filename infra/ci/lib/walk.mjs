import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

export const SKIP_DIRS = new Set([
  '.git',
  '.turbo',
  '.pnpm-store',
  'node_modules',
  'dist',
  'coverage',
]);

export const SKIP_EXTS = new Set([
  '.7z',
  '.bin',
  '.dll',
  '.eot',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mp4',
  '.pdf',
  '.png',
  '.ttf',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

export function repoRoot(start = process.cwd()) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function relPosix(root, absPath) {
  return relative(root, absPath).split('\\').join('/');
}

export function shouldSkipFile(absPath) {
  const ext = extname(absPath).toLowerCase();
  return SKIP_EXTS.has(ext);
}

export function walkFiles(root) {
  const out = [];

  function visit(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldSkipFile(abs)) continue;
      try {
        if (!statSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      out.push(abs);
    }
  }

  visit(root);
  return out;
}
