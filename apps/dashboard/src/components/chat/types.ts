// TASK-107 (Chat-1c): shared types for the chat component set. These
// mirror the spec §3/§4 shapes closely enough for static-fixture styling;
// TASK-108 (Chat-1d) wires these to the real GET /threads, GET
// /threads/:id/messages responses without needing to reshape props here.

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
