/**
 * TASK-085 / Addendum F §3.3 (F6) — three scopes, three tiers.
 *
 * Scopes: `agent` (bound to a single role_id — cross-role reads are
 * impossible through this API, see facts.ts), `project`, `user`.
 * Conflict order when resolving one key across scopes: agent > project >
 * user (see resolve.ts).
 *
 * Tiers: `profile` is the only tier the every-turn prefix-injection reader
 * returns (readProfileTier in facts.ts); `log` is on-demand only; `note`
 * defaults to a 7-day TTL via `expires_at`.
 */
export const memoryScopes = ["agent", "project", "user"] as const;
export type MemoryScope = (typeof memoryScopes)[number];

export const memoryTiers = ["profile", "log", "note"] as const;
export type MemoryTier = (typeof memoryTiers)[number];

/** Default TTL applied to a `note`-tier fact when no explicit TTL is given. */
export const DEFAULT_NOTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MemoryFact {
  factId: string;
  tenantId: string;
  scope: MemoryScope;
  roleId: string | null;
  projectId: string | null;
  key: string;
  value: string;
  source: string;
  confidence: number;
  tier: MemoryTier;
  expiresAt: Date | null;
  /** NULL means tenant-visible; populated lists restrict project/user reads. */
  visibleTo?: string[] | null;
  /** The newer row that replaced this fact, or null when this is current. */
  supersededBy?: string | null;
}

export interface NewMemoryFact {
  tenantId?: string;
  scope: MemoryScope;
  /** Required when scope === 'agent'; forbidden otherwise (DB CHECK enforces this too). */
  roleId?: string;
  /** Used by scope === 'project'; ignored/forbidden for 'agent' and 'user'. */
  projectId?: string;
  key: string;
  value: string;
  source: string;
  confidence?: number;
  tier?: MemoryTier;
  /** Explicit TTL in milliseconds. Only meaningful for tier === 'note'; defaults to DEFAULT_NOTE_TTL_MS there. */
  ttlMs?: number;
  /** Optional role ACL for project/user facts. Agent reads remain owner-only. */
  visibleTo?: readonly string[];
}

/** The read context a resolve()/readProfileTier() call is scoped to. */
export interface MemoryContext {
  tenantId: string;
  /** The requesting role's own identity — never another role's. */
  roleId?: string;
  projectId?: string;
}
