import { DiscoveryError } from "./errors.js";
import { SERVER_SET_SEPARATOR, serverSetKey } from "./key.js";
import {
  DISCOVERY_CACHE_TTL_MS,
  type DiscoveryCache,
  type DiscoveryCacheDeps,
  type DiscoverySnapshot,
  type ServerDiscoveryResult,
  type ToolLister,
} from "./types.js";

interface CacheResolution {
  readonly tools: readonly string[];
  readonly resolvedKey: string;
  readonly servers: readonly ServerDiscoveryResult[];
  readonly degraded: readonly string[];
}

interface FulfilledEntry extends CacheResolution {
  readonly atMs: number;
}

interface CacheEntry {
  readonly requestedKey: string;
  readonly promise: Promise<CacheResolution>;
  fulfilled?: FulfilledEntry;
  staleTools?: readonly string[];
  staleServers?: readonly ServerDiscoveryResult[];
  staleDegraded?: readonly string[];
}

const PURPOSE = "enumeration-reporting" as const;

function defaultSchedule(task: () => void): void {
  queueMicrotask(task);
}

function opaqueListError(reason: unknown): string {
  if (reason instanceof Error && reason.message.startsWith("listTools failed")) {
    return reason.message;
  }
  return "listTools failed: transport error";
}

function freezeSnapshot(snapshot: DiscoverySnapshot): DiscoverySnapshot {
  return Object.freeze({
    purpose: PURPOSE,
    requestedKey: snapshot.requestedKey,
    resolvedKey: snapshot.resolvedKey,
    tools: Object.freeze([...snapshot.tools]),
    servers: Object.freeze(snapshot.servers.map((server) => Object.freeze({ ...server }))),
    degraded: Object.freeze([...snapshot.degraded]),
    servedStale: snapshot.servedStale,
    kickedRefresh: snapshot.kickedRefresh,
  });
}

function emptySnapshot(
  requestedKey: string,
  kickedRefresh: boolean,
): DiscoverySnapshot {
  return freezeSnapshot({
    purpose: PURPOSE,
    requestedKey,
    resolvedKey: requestedKey === "" ? requestedKey : undefined,
    tools: [],
    servers: [],
    degraded: [],
    servedStale: false,
    kickedRefresh,
  });
}

/**
 * Bind a record of TASK-054-compatible enumerators as the current
 * mounted set. Replacing keys on the returned mutable record is a
 * distinct cache key on the next peek.
 */
export function enumeratorsFrom(
  record: Readonly<Record<string, ToolLister>>,
): Pick<DiscoveryCacheDeps, "peekServerNames" | "listTools"> {
  const mounted: Record<string, ToolLister> = { ...record };
  return {
    peekServerNames: () => Object.keys(mounted),
    listTools: (serverName) => {
      const enumerator = mounted[serverName];
      if (enumerator === undefined) {
        return Promise.reject(new Error("listTools failed: unknown server"));
      }
      return enumerator.listTools();
    },
  };
}

/**
 * Server-set-keyed MCP tools cache with stale-while-revalidate.
 *
 * Reference: Grok Bot `source/shared/node/mcp/tools-discovery.ts`
 * (study §Tier 2). Built in front of TASK-054's live `listTools` adapter;
 * this module never derives an allowlist.
 */
export function createDiscoveryCache(deps: DiscoveryCacheDeps): DiscoveryCache {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? DISCOVERY_CACHE_TTL_MS;
  const schedule = deps.schedule ?? defaultSchedule;

  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("ttlMs must be a positive finite number");
  }

  let entry: CacheEntry | null = null;
  let coldWarmScheduled = false;

  function currentForKey(key: string): {
    tools: readonly string[];
    servers: readonly ServerDiscoveryResult[];
    degraded: readonly string[];
    resolvedKey: string | undefined;
    servedStale: boolean;
  } | undefined {
    if (entry === null) {
      return undefined;
    }
    if (entry.fulfilled?.resolvedKey === key) {
      const stale = now() - entry.fulfilled.atMs >= ttlMs;
      return {
        tools: entry.fulfilled.tools,
        servers: entry.fulfilled.servers,
        degraded: entry.fulfilled.degraded,
        resolvedKey: entry.fulfilled.resolvedKey,
        servedStale: stale || entry.fulfilled.atMs === 0,
      };
    }
    if (entry.requestedKey === key && entry.staleTools !== undefined) {
      return {
        tools: entry.staleTools,
        servers: entry.staleServers ?? [],
        degraded: entry.staleDegraded ?? [],
        resolvedKey: entry.requestedKey,
        servedStale: true,
      };
    }
    return undefined;
  }

  function entryUsable(key: string): boolean {
    if (entry === null) {
      return false;
    }
    if (entry.fulfilled === undefined) {
      return entry.requestedKey === key;
    }
    return (
      entry.fulfilled.resolvedKey === key && now() - entry.fulfilled.atMs < ttlMs
    );
  }

  function dropSettledForEmptySet(): void {
    if (entry?.fulfilled !== undefined) {
      entry = null;
    }
  }

  async function fetchResolution(): Promise<CacheResolution> {
    const peeked = deps.peekServerNames();
    const names = peeked === undefined ? [] : [...peeked];
    const resolvedKey = serverSetKey(names);
    if (resolvedKey === "") {
      return {
        tools: [],
        resolvedKey,
        servers: [],
        degraded: [],
      };
    }

    const unique = resolvedKey.split(SERVER_SET_SEPARATOR);
    const settled = await Promise.allSettled(
      unique.map(async (serverName) => {
        const tools = await deps.listTools(serverName);
        if (!Array.isArray(tools)) {
          throw new Error("listTools failed: malformed response");
        }
        return Object.freeze([...tools]) as readonly string[];
      }),
    );

    const servers: ServerDiscoveryResult[] = [];
    const tools: string[] = [];
    const degraded: string[] = [];

    for (let i = 0; i < unique.length; i += 1) {
      const serverName = unique[i];
      if (serverName === undefined) {
        continue;
      }
      const result = settled[i];
      if (result === undefined) {
        continue;
      }
      if (result.status === "fulfilled") {
        servers.push(
          Object.freeze({
            serverName,
            ok: true,
            tools: result.value,
          }),
        );
        for (const name of result.value) {
          tools.push(name);
        }
      } else {
        degraded.push(serverName);
        servers.push(
          Object.freeze({
            serverName,
            ok: false,
            tools: Object.freeze([]) as readonly string[],
            error: opaqueListError(result.reason),
          }),
        );
      }
    }

    if (degraded.length === unique.length) {
      const code = unique.length === 1 ? "SOLE_SOURCE_FAILED" : "ALL_SOURCES_FAILED";
      throw new DiscoveryError(
        unique.length === 1
          ? `sole source failed: ${unique[0]}`
          : "all sources failed",
        code,
        unique,
      );
    }

    return {
      tools: Object.freeze(tools),
      resolvedKey,
      servers: Object.freeze(servers),
      degraded: Object.freeze(degraded),
    };
  }

  function startResolution(
    requestedKey: string,
    carryStale: boolean,
    retryOnFailure: boolean,
  ): CacheEntry {
    if (entry !== null && entry.fulfilled === undefined && entry.requestedKey === requestedKey) {
      return entry;
    }

    const stale = carryStale ? currentForKey(requestedKey) : undefined;
    const next: CacheEntry = {
      requestedKey,
      promise: fetchResolution(),
    };
    if (stale !== undefined) {
      next.staleTools = stale.tools;
      next.staleServers = stale.servers;
      next.staleDegraded = stale.degraded;
    }
    entry = next;

    void next.promise.then(
      (resolution) => {
        if (entry !== next) {
          return;
        }
        next.fulfilled = { ...resolution, atMs: now() };
      },
      () => {
        if (entry !== next) {
          return;
        }
        if (next.staleTools === undefined) {
          entry = null;
          return;
        }
        // SWR: serve stale; atMs=0 so the entry is immediately TTL-expired
        // and the next consumer call revalidates. Also schedule one retry.
        next.fulfilled = {
          tools: next.staleTools,
          resolvedKey: next.requestedKey,
          servers: next.staleServers ?? [],
          degraded: next.staleDegraded ?? [],
          atMs: 0,
        };
        if (retryOnFailure) {
          schedule(() => {
            if (entry === next) {
              startResolution(requestedKey, true, false);
            }
          });
        }
      },
    );
    return next;
  }

  function scheduleColdWarm(): void {
    if (coldWarmScheduled) {
      return;
    }
    coldWarmScheduled = true;
    schedule(() => {
      coldWarmScheduled = false;
      const names = deps.peekServerNames();
      if (names === undefined) {
        return;
      }
      const key = serverSetKey(names);
      if (key === "") {
        dropSettledForEmptySet();
        return;
      }
      if (!entryUsable(key)) {
        startResolution(key, false, true);
      }
    });
  }

  function snapshotFromCurrent(
    key: string,
    kickedRefresh: boolean,
  ): DiscoverySnapshot | undefined {
    const current = currentForKey(key);
    if (current === undefined) {
      return undefined;
    }
    return freezeSnapshot({
      purpose: PURPOSE,
      requestedKey: key,
      resolvedKey: current.resolvedKey,
      tools: current.tools,
      servers: current.servers,
      degraded: current.degraded,
      servedStale: current.servedStale,
      kickedRefresh,
    });
  }

  async function snapshotFromResolution(
    requestedKey: string,
    resolution: CacheResolution,
    servedStale: boolean,
    kickedRefresh: boolean,
  ): Promise<DiscoverySnapshot> {
    return freezeSnapshot({
      purpose: PURPOSE,
      requestedKey,
      resolvedKey: resolution.resolvedKey,
      tools: resolution.tools,
      servers: resolution.servers,
      degraded: resolution.degraded,
      servedStale,
      kickedRefresh,
    });
  }

  return {
    async getToolsForTurnStart() {
      const names = deps.peekServerNames();
      if (names === undefined) {
        scheduleColdWarm();
        return emptySnapshot("", true);
      }
      const key = serverSetKey(names);
      if (key === "") {
        dropSettledForEmptySet();
        return emptySnapshot(key, false);
      }
      let kickedRefresh = false;
      if (!entryUsable(key)) {
        startResolution(key, true, true);
        kickedRefresh = true;
      }
      return (
        snapshotFromCurrent(key, kickedRefresh) ?? emptySnapshot(key, kickedRefresh)
      );
    },

    async getTools() {
      const names = deps.peekServerNames();
      if (names === undefined) {
        throw new DiscoveryError(
          "mounted server set is not yet known",
          "INVALID_SERVER_SET",
          [],
        );
      }
      const key = serverSetKey(names);
      if (key === "") {
        dropSettledForEmptySet();
        return emptySnapshot(key, false);
      }

      if (entryUsable(key) && entry?.fulfilled?.resolvedKey === key) {
        const hit = snapshotFromCurrent(key, false);
        if (hit !== undefined) {
          return hit;
        }
      }

      const started =
        entry !== null && entry.fulfilled === undefined && entry.requestedKey === key
          ? entry
          : startResolution(key, true, true);

      try {
        const resolution = await started.promise;
        return snapshotFromResolution(key, resolution, false, false);
      } catch (error) {
        const stale = currentForKey(key);
        if (stale !== undefined) {
          return freezeSnapshot({
            purpose: PURPOSE,
            requestedKey: key,
            resolvedKey: stale.resolvedKey,
            tools: stale.tools,
            servers: stale.servers,
            degraded: stale.degraded,
            servedStale: true,
            kickedRefresh: true,
          });
        }
        throw error;
      }
    },

    invalidate() {
      entry = null;
    },
  };
}
