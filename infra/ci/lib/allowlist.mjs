import { readFileSync } from 'node:fs';

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

export function isAllowlisted(relPath, entries) {
  const norm = relPath.replace(/\\/g, '/');
  for (const entry of entries) {
    if (entry.endsWith('/**')) {
      const prefix = entry.slice(0, -3);
      if (norm === prefix || norm.startsWith(`${prefix}/`)) return true;
      continue;
    }
    if (norm === entry) return true;
  }
  return false;
}
