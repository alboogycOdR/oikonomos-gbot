/**
 * Layering (ADR-001 / TASK-054 / TASK-066 / TASK-068).
 *
 * This cache sits in front of TASK-054's live `listTools` adapter and
 * feeds **enumeration / reporting only**. L2 `allowedToolsFor` derivation
 * and the broker's call-time re-check (`recheckAgainstManifest`) consume
 * the **manifest map**, never a cached live listing. An empty or failed
 * live listing is not an allowlist and must not fail-open.
 *
 * `feedsAllowlist` / `feedsBrokerRecheck` are load-bearing false constants:
 * flipping either to true turns the layering test red.
 */
export const DISCOVERY_CACHE_LAYER = Object.freeze({
  feedsEnumerationReporting: true,
  feedsAllowlist: false,
  feedsBrokerRecheck: false,
});

/** Snapshots are reporting artifacts, never L2 allowlists. */
export type DiscoveryPurpose = "enumeration-reporting";

/** Default TTL matching Grok Bot `MCP_TOOLS_CACHE_TTL_MS`. */
export const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Compatible with TASK-054 `ToolEnumerator`. Declared here so this module
 * does not reach into `enumeration/` for a runtime import.
 */
export interface ToolLister {
  listTools(): Promise<readonly string[]>;
}

export interface DiscoveryCacheDeps {
  /**
   * Current mounted server names. `undefined` means the set is not yet
   * known (cold start). Changing the returned set is a distinct cache key.
   */
  peekServerNames(): readonly string[] | undefined;
  /**
   * Per-server live `listTools` (TASK-054 HTTP adapter or a test fake).
   * One server's rejection degrades that server only.
   */
  listTools(serverName: string): Promise<readonly string[]>;
  /** Injected clock (`Date.now` semantics). Tests supply a fake. */
  now?: () => number;
  /** Positive finite TTL in ms. */
  ttlMs?: number;
  /**
   * Schedule a background task (cold-start warm, SWR re-fetch).
   * Tests push onto a queue and flush; production uses `queueMicrotask`.
   */
  schedule?: (task: () => void) => void;
}

export interface ServerDiscoveryResult {
  readonly serverName: string;
  readonly ok: boolean;
  readonly tools: readonly string[];
  readonly error?: string;
}

/**
 * Cached live listing for reporting. There is no `allowedTools` field
 * on purpose — callers must keep using `allowedToolsFor(manifest, report)`.
 */
export interface DiscoverySnapshot {
  readonly purpose: DiscoveryPurpose;
  readonly requestedKey: string;
  readonly resolvedKey: string | undefined;
  readonly tools: readonly string[];
  readonly servers: readonly ServerDiscoveryResult[];
  readonly degraded: readonly string[];
  readonly servedStale: boolean;
  readonly kickedRefresh: boolean;
}

export interface DiscoveryCache {
  /**
   * Never waits on `listTools`. Cold start returns empty tools and kicks
   * a background refresh. TTL-expired entries are served stale while a
   * revalidation is started.
   */
  getToolsForTurnStart(): Promise<DiscoverySnapshot>;
  /**
   * Blocking read for enumeration/reporting. Sole-source (or all-source)
   * failure throws {@link DiscoveryError} when there is no stale entry to
   * serve — it is not an empty success.
   */
  getTools(): Promise<DiscoverySnapshot>;
  /** Drop the in-memory entry. In-flight resolutions are abandoned. */
  invalidate(): void;
}
