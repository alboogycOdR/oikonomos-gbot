// TASK-107 (Chat-1c): static fixture data for styling the chat surface
// against — no API calls (that's Chat-1d, TASK-108). No credentials or
// real account data appear here (CLAUDE.md §4).
import type {
  BotSummary,
  ChatMessage,
  MemberSummary,
  RoutineSummary,
} from "./types";

export const fixtureBots: BotSummary[] = [
  {
    id: "bot-research",
    name: "Research Assistant",
    description: "Summarizes docs and drafts findings",
    avatarSeed: "Research Assistant",
    lastMessagePreview: "Here's the summary you asked for.",
    updatedAt: "2026-09-02T18:40:00Z",
  },
  {
    id: "bot-ops",
    name: "Ops Bot",
    description: "Watches deploys and files reports",
    avatarSeed: "Ops Bot",
    lastMessagePreview: "Deploy finished, all checks green.",
    updatedAt: "2026-09-02T17:05:00Z",
  },
  {
    id: "bot-scheduler",
    name: "Scheduler",
    description: "Books meetings and reminders",
    avatarSeed: "Scheduler",
    lastMessagePreview: "Booked for Thursday 10am.",
    updatedAt: "2026-09-01T09:12:00Z",
  },
];

export const fixtureMessages: ChatMessage[] = [
  {
    id: "msg-1",
    threadId: "bot-research",
    role: "user",
    body: "Can you pull together a summary of the Q3 vendor spend?",
    createdAt: "2026-09-02T18:31:00Z",
  },
  {
    id: "msg-2",
    threadId: "bot-research",
    role: "bot",
    body: "On it — pulling the vendor ledger and last quarter's report now.",
    createdAt: "2026-09-02T18:31:40Z",
  },
  {
    id: "msg-3",
    threadId: "bot-research",
    role: "bot",
    body: "Here's the summary you asked for: spend is up 6% quarter over quarter, driven mostly by the hosting line item.",
    createdAt: "2026-09-02T18:39:10Z",
  },
  {
    id: "msg-4",
    threadId: "bot-research",
    role: "user",
    body: "Nice. Can you send the full breakdown to finance?",
    createdAt: "2026-09-02T18:39:40Z",
  },
  {
    id: "msg-5",
    threadId: "bot-research",
    role: "bot",
    body: "This needs your approval before I send anything external.",
    createdAt: "2026-09-02T18:40:00Z",
    approval: {
      nonce: "fixture-nonce-not-real",
      actionRender:
        "Send email to finance@basileia.example\nSubject: Q3 vendor spend breakdown\nAttachment: q3-vendor-spend.csv",
      status: "pending",
    },
  },
];

export const fixtureMembers: MemberSummary[] = [
  { id: "member-owner", name: "You", role: "owner" },
  { id: "bot-research", name: "Research Assistant", role: "bot" },
  { id: "bot-ops", name: "Ops Bot", role: "bot" },
  { id: "bot-scheduler", name: "Scheduler", role: "bot" },
];

export const fixtureRoutines: RoutineSummary[] = [
  {
    id: "routine-weekly-summary",
    name: "Weekly vendor summary",
    description: "Every Monday, summarize last week's vendor spend",
  },
  {
    id: "routine-deploy-watch",
    name: "Deploy watch",
    description: "Report on every production deploy",
  },
];
