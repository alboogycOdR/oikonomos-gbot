// TASK-107 (Chat-1c): shared types for the chat component set. These
// mirror the spec §3/§4 shapes closely enough for static-fixture styling;
// TASK-108 (Chat-1d) wires these to the real GET /threads, GET
// /threads/:id/messages responses without needing to reshape props here.

/**
 * TASK-239 (spec §4.2/§4.3) — a background workspace's status, derived from
 * `GET /workspace/summary` (never invented client-side text). `blockedReason`
 * is only ever populated for `"blocked"` (a failed run) and is the
 * deterministic string read off the run's terminal audit event / failure
 * note — see `ChatPage.tsx`'s `computeWorkspaceBadge`/`fetchBlockedReason`.
 */
export type WorkspaceBadgeKind = "working" | "waiting_approval" | "blocked" | "unread";

export interface WorkspaceStatus {
  badge: WorkspaceBadgeKind;
  pendingApprovals: number;
  /** Populated only for `badge === "blocked"`. */
  blockedReason?: string | null;
}

export interface BotSummary {
  id: string;
  /** Role owning this thread; distinct from the thread ID used as `id`. */
  roleId?: string;
  name: string;
  description?: string;
  /** Deterministic seed for the initials-on-color avatar (spec §2). */
  avatarSeed: string;
  lastMessagePreview?: string;
  updatedAt: string;
  /** TASK-239 (spec §4.2) — background-workspace status badge; absent for the active thread and for a thread with nothing to report. */
  status?: WorkspaceStatus;
}

export type MessageRole = "user" | "bot" | "system";

export interface ApprovalRender {
  nonce: string;
  actionRender: string;
  status: "pending" | "approved" | "rejected";
  /** Capability and tier required for the optional standing-grant action. */
  capabilityId?: string;
  maxTier?: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: MessageRole;
  body: string;
  createdAt: string;
  /** Present when this bot message is awaiting or reflects an approval decision (spec §4). */
  approval?: ApprovalRender;
}

export interface RoutineSummary {
  id: string;
  name: string;
  description?: string;
}

export interface MemberSummary {
  id: string;
  name: string;
  role: "owner" | "bot";
}
