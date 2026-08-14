import { readFileSync } from 'node:fs';

/**
 * ADR-002 Amendment A enforcement surfaces. Scanned with no exceptions:
 * a carve-out entry cannot override these (a token here is a live grant).
 */
export const ENFORCEMENT_SURFACES = Object.freeze([
  'packages/**',
  'apps/**',
  'services/**',
  'infra/**',
  'evals/**',
  '.github/**',
  '.claude/settings*.json',
  '.claude/agents/**',
]);

export function loadAllowlist(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const entries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    entries.push(line.replace(/\\/g, '/'));
  }
  return entries;
}

function escapeRegex(text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a repo-relative posix path against an allowlist/enforcement pattern.
 * `foo/**` is a directory prefix. `*` matches a single path segment only
 * (`*.md` = root markdown; `.claude/settings*.json` does not match nested dirs).
 */
export function matchPath(relPath, pattern) {
  const norm = relPath.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');

  if (pat.endsWith('/**')) {
    const prefix = pat.slice(0, -3);
    return norm === prefix || norm.startsWith(`${prefix}/`);
  }

  if (pat.includes('*')) {
    const escaped = pat
      .split('/')
      .map((seg) => seg.split('*').map(escapeRegex).join('[^/]*'))
      .join('/');
    return new RegExp(`^${escaped}$`).test(norm);
  }

  return norm === pat;
}

export function isEnforcementSurface(relPath) {
  return ENFORCEMENT_SURFACES.some((pattern) => matchPath(relPath, pattern));
}

export function isAllowlisted(relPath, entries) {
  if (isEnforcementSurface(relPath)) return false;
  return entries.some((entry) => matchPath(relPath, entry));
}
