# OIKONOMOS Chat Surface v1.0 — spec entry point for the Chat wave

Written 2026-09-02 (ORCH) after the user reviewed the E9.1 dashboard against
the real Grok Bot desktop UI and redirected priority: **the product is a
chat-first surface where the user creates and talks to their own bots**,
not an ops/audit console. This document is UI-first. It draws on:

- `docs/architecture/OIKONOMOS_WBS_Addendum_A_v1.0.md` §Epic E14 (the closest
  existing spec — free-text intake, thread model, agent-to-agent messaging)
- `docs/STUDY-grok-bot-018.md` (Grok Bot's actual UI/messaging primitives,
  source-verified against the reconstructed codebase)
- The user-supplied Grok Bot screenshot: sidebar of bot conversations with
  avatars, center chat pane with compose box + mic, right-hand Members /
  Routines / Plugins panels, styled desktop chrome.

This spec governs **Wave "Chat-1"** only — one polished, working
single-bot-at-a-time chat surface. Multi-bot rooms, agent-to-agent visible
exchange, and Telegram thread continuity are Wave "Chat-2" (§8, not
decomposed yet).

Precedence: this document sits alongside the Master WBS/Addenda per
CLAUDE.md's document-precedence rule — it does not override any ADR. Where
it needs a security-relevant decision (e.g. approval rendering) it defers to
existing packages/broker, packages/approvals, packages/policy behaviour
unchanged; it only asks for those to be *surfaced* differently.

## 1. Product shape (non-negotiable acceptance bar)

A user who has never seen PLAN.md, a UUID, or the word "governance" can:

1. Open the app and see a left sidebar listing their bots (name, avatar,
   last-message preview) — Grok Bot's own layout, not a nav menu of pages.
2. Click a bot and see a real conversation: their messages and the bot's
   replies, in order, styled as chat bubbles, with timestamps.
3. Type a message in a compose box at the bottom and send it. The bot
   replies in the same pane, without the user visiting any other screen.
4. Click "Create bot" (or similar), name a bot, and immediately be able to
   talk to it — no manifest authoring, no role YAML, no dashboard form full
   of dropdowns (OIK-129 "no manifest, role definition, or routine authored
   by the user first").
5. When the bot's action needs approval (T2+), see an **inline card in the
   conversation** — not a separate "Approvals" page — with Approve / Edit /
   Reject, rendered from the same `packages/approvals` nonce-bound decision
   already built. Governance did not go away; it moved into the chat.

Anything that requires the user to understand "runs", "tasks", "audit
events", or "evidence" as first-class UI concepts fails this bar. Those
remain real, inspectable, and correct underneath — just not the product
surface.

## 2. Visual bar

"Looks like Grok Bot" is graded, not vibes:

- Real design system: Tailwind CSS (already an allowed dependency
  footprint; no new backend risk) + a component layer (shadcn/ui-style —
  MIT, no server calls, ships as source you own, not a hosted service).
  No browser-default form controls, no unstyled `<table>`.
- Dark, chrome-like desktop aesthetic matching the reference screenshot:
  persistent left sidebar, center pane fills remaining width, right panel
  collapsible. Avatars (generated initials-on-color is enough for v1; no
  image upload required yet). Message bubbles distinguish user vs. bot.
  Loading/typing state while a run is in flight.
- Responsive down to a single-column mobile layout is **not** required for
  Chat-1 (E9.2 mobile is still deferred) — desktop browser width only.
- Acceptance is partly visual and reviewed by ORCH reading rendered output
  (Playwright screenshot or manual `pnpm --filter dashboard dev` walk),
  not solely by unit tests passing. A task can be functionally complete
  and still get a rework verdict on this axis alone — say so explicitly in
  the review, per CLAUDE.md's control-liveness spirit: a "styled" claim
  needs the reviewer to actually look at it rendered, not read the CSS.

## 3. Data model (new)

Two new tables, additive, no change to existing `runs`/`tasks`/`roles`/
`approvals` schemas (OIK-156 "threads persist independently of the surface
they originated on" — but the surface is web-only for Chat-1, so the
independence requirement is satisfied by *not coupling* the schema to
`apps/dashboard`, not by building multi-surface sync now).

```sql
-- threads: one per (user, bot) conversation for v1 (group threads = Chat-2)
-- role_id is TEXT, matching the live schema: migration 004 defines
-- roles.role_id TEXT PRIMARY KEY (no roles.id/UUID column exists).
-- Corrected 2026-09-02 after TASK-105 (CX) blocked on this exact mismatch
-- in the first draft of this spec — good catch, not a builder error.
CREATE TABLE threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id text NOT NULL REFERENCES roles(role_id),   -- the bot
  title TEXT,                                    -- nullable, derived from first message if unset
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- messages: append-only; a message either IS the transcript or POINTS AT
-- a run (OIK-156's own guidance: "Memory is not the transcript... changing
-- facts belong in their source system" — same principle: audit/evidence
-- stays in runs/audit_events; messages is a UI-facing view, not a new
-- source of governance truth).
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES threads(id),
  role TEXT NOT NULL CHECK (role IN ('user','bot','system')),
  body TEXT NOT NULL,
  run_id UUID REFERENCES runs(id),   -- set when this message is a bot reply produced by a run
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread_id_created_at_idx ON messages(thread_id, created_at);
```

No new capability/tier semantics — creating a thread and posting a user
message are T0 (observation-tier, per existing broker classification);
whatever the bot's *reply* does (tool calls) still goes through the
unchanged broker/policy/approvals path at whatever tier that action needs.

## 4. API additions (`services/control-api`)

All under existing auth (`control_api_session` cookie), existing
`packages/db` connection discipline, existing OpenAPI doc generation.

Corrected 2026-09-02 (TASK-106 blocked on this in the first draft — CX's
finding was correct): this service has **no `routes/` directory**. Every
route is registered inline in `buildApp()` in `services/control-api/src/
app.ts`, and every route handler calls only through the `ControlApiDeps`
port in `services/control-api/src/ports.ts` (OIK-084 "not the DB" — no
route may import `pg`, hold a `Pool`, or embed SQL; `test/no-raw-sql.
test.ts` is the liveness check enforcing this). The 6 new endpoints below
go into `app.ts` following the existing route style exactly, backed by new
port functions in `ports.ts` that wrap `packages/db`'s `threads.ts`/
`messages.ts`/role functions — do not add a `routes/` directory.

- `GET /roles` — list bots the user can talk to (id, name, description,
  avatar seed). Read from existing `roles` table; no schema change needed
  here beyond what TASK-Chat-1b adds (see below).
- `POST /roles` — create a bot: `{name, description}` → inserts a `roles`
  row with the existing default-general-role conservative ceiling
  (OIK-131: T1_draft cap, matches CLAUDE.md's fail-closed default). No
  free-text tier escalation from this endpoint.
- `GET /threads` — list threads for the current user (id, role_id, bot
  name, last message preview, updated_at), sorted by `updated_at desc` —
  this is the sidebar's data source.
- `POST /threads` — `{role_id}` → creates a thread (or returns the existing
  one for that role — v1 is one thread per bot, matching the screenshot's
  one-conversation-per-bot sidebar).
- `GET /threads/:id/messages` — full transcript, ascending by `created_at`.
- `POST /threads/:id/messages` — `{body}`. Inserts the user message, then
  creates a task (`createTask`, existing function) targeted at the
  thread's `role_id`, with the message body as the task's free-text
  intake (OIK-129 shape: no manifest required). **Corrected 2026-09-03**:
  there is no existing task→run→execution pipeline in this codebase —
  `executeTaskRun` (services/worker) has only ever been called from tests.
  TASK-111 builds that first production driver (real `BrokerDependencies`,
  real provider call through `packages/agent-providers`, real broker
  decision) and wires it in fire-and-forget after task creation. Returns
  the created message immediately; the bot's reply arrives asynchronously
  once TASK-111's driver picks up the task.
- Reply delivery for v1: **polling**, not websockets — `GET
  /threads/:id/messages?after=<message_id>` the dashboard polls every
  ~2s while a run is in flight, matching the existing control-api
  request/response style and avoiding a new transport layer this wave.
  (Note for Chat-2: this is the seam where Grok Bot's `SendToAgent`
  delivery-ack pattern and a real push channel would go — not required now.)
- When the run reaches a terminal state, the worker (or a control-api
  listener on run completion — implementer's choice, single-owner task)
  writes one `messages` row with `role='bot'`, `run_id` set, and `body`
  derived from the run's final output.
- When the run produces a pending approval, control-api's existing
  `/approvals` data is surfaced **inline**: `GET
  /threads/:id/messages` includes, for a bot message that is awaiting
  approval, the associated approval's `{nonce, action_render, status}`
  (reuse ADR-004's render-provenance approval data already built for
  gateway-telegram — same `actionRender`, same nonce discipline, do not
  re-derive it). The existing `POST /approvals/:nonce/decide` endpoint is
  called unchanged from the chat card.

No new tables for approvals; no change to `packages/broker`,
`packages/policy`, `packages/approvals` internals. This wave adds a
read/compose surface over existing governance primitives — it does not
touch protected-path enforcement logic itself. (If an implementer finds
they need to touch `packages/approvals/**` to satisfy this, stop and flag
it to ORCH — that would make the task protected-path and change the
review requirement.)

## 5. Frontend (`apps/dashboard`, or a fresh `apps/chat` — see task split)

Decision: **extend `apps/dashboard`**, do not fork a new app. Reasoning:
same control-api client, same auth, same build/deploy story already
proven in TASK-101/102. The existing `/runs /approvals /evidence` routes
stay (ops utility, useful for ORCH/Alister debugging) but move behind a
`/ops` prefix and out of primary navigation; `/` becomes the chat surface.
This is a routing change, not a rewrite — TASK-102/103/104's API client
(`lib/api.ts`) and auth flow are reused as-is.

Component shape (mirrors the screenshot):
- `<ChatShell>` — three-column layout: sidebar / conversation / right panel.
- `<BotSidebar>` — thread list from `GET /threads`, "+ New bot" action.
- `<ConversationPane>` — message list (`<MessageBubble role="user|bot">`),
  auto-scroll, typing/in-flight indicator while a run is running.
- `<ComposeBox>` — textarea + send button, disabled while a message is
  in flight, Enter-to-send/Shift+Enter-newline.
- `<ApprovalCard>` — renders `action_render` verbatim (never re-interpret
  as Markdown/HTML — same rule TASK-082 enforced for Telegram) with
  Approve/Edit/Reject, calling the existing decide endpoint.
- `<RightPanel>` — tabs: Members (bots + a way to create one), Routines
  (read-only list from `role_routines` for v1 — creating routines from
  chat is Chat-2/OIK-135 "routine promotion from ad-hoc run").

## 6. Task split (Wave Chat-1, disjoint Owned_Paths)

| Task | Owner | Owned_Paths | Depends_On |
|---|---|---|---|
| Chat-1a: `threads`/`messages` schema + migration + reply-writer wiring | CX | `infra/postgres/migrations/**`, `packages/db/src/threads.ts`, `packages/db/src/messages.ts` | — |
| Chat-1b: control-api thread/message/role endpoints | CX | `services/control-api/src/**` (additive routes only) | Chat-1a |
| Chat-1c: design system + `<ChatShell>` primitives (Tailwind/shadcn setup, sidebar, bubbles, compose box) — styled against static fixture data, no live API yet | S5 | `apps/dashboard/src/components/chat/**`, `apps/dashboard/tailwind.config.*`, `apps/dashboard/src/index.css` | — |
| Chat-1d: wire `<ChatShell>` to live API (threads/messages/polling), routing (`/` → chat, existing pages → `/ops/*`) | S5 | `apps/dashboard/src/{App.tsx,pages/**,lib/**}` (excluding `components/chat/**`, already Chat-1c's) | Chat-1b, Chat-1c |
| Chat-1e: inline `<ApprovalCard>` wired to real approvals | S5 | `apps/dashboard/src/components/chat/ApprovalCard.tsx` and its wiring point in ConversationPane | Chat-1d |
| Chat-1f: "Create bot" flow (`POST /roles` UI) | S5 or CX (whichever is idle) | `apps/dashboard/src/components/chat/CreateBot*.tsx` + reuses Chat-1b's `POST /roles` | Chat-1b, Chat-1d |

Territory check: Chat-1c and Chat-1d both touch `apps/dashboard/src/**`
but on disjoint subpaths (`components/chat/**` vs. everything else) —
sequence them (1c before 1d starts, not parallel) rather than trust path
globbing alone, since CSS/Tailwind config is genuinely shared surface.

## 7. Non-negotiables carried forward unchanged

Everything in CLAUDE.md §Non-negotiables still applies. Specifically for
this wave: no credentials in fixtures (mock bot replies in tests, never a
real provider call in unit tests); ACL filter before vector similarity is
untouched (this wave adds no memory-retrieval code); approvals stay
nonce-bound and single-use — the chat card is a new *renderer* of an
existing decision, never a new decision path. Liveness assertion required
per task per ADR-005 (§ suggestions per task, not exhaustive here —
implementer proposes, ORCH reviews): Chat-1b needs a test that a message
without a valid session is rejected (not just "the route exists"); Chat-1e
needs the same mutation-proof shape TASK-058/082 used for Telegram
(deleting the approval-status check must redden a test, not just look
present).

## 8. Deferred to Chat-2 (not decomposed yet — reference only)

- Multi-bot group threads, visible agent-to-agent exchange (OIK-149/150).
- Routine creation/editing from chat (OIK-135).
- Telegram/mobile thread continuity (OIK-156/157, E9.2/E9.3 still deferred
  by explicit user instruction).
- Real-time push (websocket/SSE) replacing polling.
- Bot avatar image upload, custom theming.
- **Agent-initiated action visible in the thread list preview** (added
  2026-09-02, from the real Grok Bot Android app: a sidebar row can read
  "New Bot independently opened Google on their sc…" — a bot's unprompted
  action surfaced as the list preview text, not only inside the open
  conversation). Our policy side for this already exists on paper
  (Addendum A E14.2, `initiative` axis: reactive/suggest/act_draft/
  act_governed) but has no UI attachment point yet. Chat-2 needs a preview
  string derived from the *latest event* in a thread, not only the latest
  chat message — an initiative-policy event must be able to win that slot.
- **Bot-to-bot thread visible in the user's own list** (added 2026-09-02,
  same source: a `"New Bot and TREVOR"` row, and a `"New Bot"` row whose
  preview reads `"↗ Messaged TREVOR: Shared-browser probe res…"` — outbound
  attribution, not just inbound). Confirms OIK-150 (multi-agent thread with
  human visibility) needs its own list entry, distinct from a 1:1 user↔bot
  thread, with a directional icon/prefix showing who messaged whom.

## 9. Definition of done for the wave

`pnpm -r test`, `pnpm -r build`, `pnpm lint`, `pnpm canaries` green (per
CLAUDE.md's amended review standard — full recursive suite, not just the
task's package). Plus the product-shape bar in §1, checked by ORCH
actually using the running app, not reading code.
