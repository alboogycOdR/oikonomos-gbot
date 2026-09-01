/**
 * Server-set cache key (Grok Bot `tools-discovery.ts` / study §Tier 2).
 *
 * The key is the sorted unique server-name set joined on a separator so
 * any change of the mounted set (add/remove/rename) is a distinct key.
 * Order of `peekServerNames()` does not matter.
 */

/** NUL join — server names cannot contain this byte. */
export const SERVER_SET_SEPARATOR = "\0";

/**
 * Build the cache key for a mounted server set.
 * Empty input → empty string (no servers mounted).
 */
export function serverSetKey(serverNames: readonly string[]): string {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const name of serverNames) {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("server set contains an empty name");
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    unique.push(name);
  }
  unique.sort();
  return unique.join(SERVER_SET_SEPARATOR);
}
