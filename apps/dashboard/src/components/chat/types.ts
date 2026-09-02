// TASK-107 (Chat-1c): shared types for the chat component set. These
// mirror the spec §3/§4 shapes closely enough for static-fixture styling;
// TASK-108 (Chat-1d) wires these to the real GET /threads, GET
// /threads/:id/messages responses without needing to reshape props here.

export interface BotSummary {
  id: string;
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
