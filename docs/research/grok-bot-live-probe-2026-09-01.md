# Grok Bot live-instance probe — 2026-09-01

Answers from a live Grok Bot session on the owner's account, gathered to ground ADR-010's design
(persistent-office-computer pivot). Recorded verbatim-in-substance; ORCH synthesis deferred until all
four batches are in. Grok Bot's own caveat: Update/Reset were NOT executed live — durability tiers below
are from live `ls`/`findmnt`, Cursor's public recovery docs, and the in-box runbook
(`/home/box/reference/debugging-the-box.md`).

---

## Batch 1 — the persistent environment

**Headline:** one cloud Linux box per **user account**, not per Bot. Every Bot shares the same overlay
filesystem, `/workspace`, Chrome profile, and CLI creds. Each Bot only gets its own desktop/screen.
Isolation is between users, not Bots.

### Q1 — Reset vs Update vs Recover durability

| | **Update** | **Recover** | **Reset** |
|---|---|---|---|
| What it is | Rebuild on a fresh image, keep durable state | Replace an unreachable instance, same durable-state contract as Update | Restore the last synced durable snapshot |
| `/workspace` | Intended to survive (whole tree). This box has no extra mounts — `/workspace` is just a dir on the same overlay as `/` | Same | Survives **only if already synced**; unsynced writes since last snapshot are gone |
| Browser cookies / logins | Survive ("files, browser state, supported sign-ins") | Same | Snapshot-only; sessions created after last sync can vanish |
| Installed packages (apt/npm/pip, CLIs, docker images) | **Do not survive** (in-box runbook explicit; public docs call them replaceable) | Same | Not a guaranteed durable tier |
| CLI credentials (`/home/box/cli-config`) | Documented as surviving with "logins" / "command-line credentials" | Same | Snapshot-only |
| Bot memory / routines / conversations | **Not on the box as source of truth.** Conversations live outside the computer. Memory + routines live under `/home/box/sand-data/agents/<bot-id>/` (symlink `agent-data`) and survive even `rm -rf` inside the box and even a Reset — unless you delete the Bot | Same | Same; Reset does not wipe Bot identity |

Notes:
- Recover ≠ Reset. Recover = unreachable-pod replacement. Reset = last-resort snapshot restore. App update
  (Settings → Updates) is a fourth thing and does not rebuild the computer.
- There is a **server-side durable copy**; reopen/rehydrate pulls it. Repeated Reset/force-quit can drop
  an unsynced thread. Docs never publish a path-by-path sync list — treat only "synced sandbox files +
  browser/logins called out as durable" as guaranteed.

### Q2 — filesystem layout as actually seen

`/` is a Docker overlay (`/.dockerenv` present). No separate volume for `/workspace` on this instance.

- **`/workspace`** — shared scratch; currently empty. Official convention: durable project files go
  here in named folders. Shared across all Bots.
- **`/home/box`** (the user):
  - `agent-data` → `/home/box/sand-data` — account-wide agent store
    - `agents/<uuid>/` **per Bot**: `profile.json`, `settings.json`, `memory/`, `automations/`
      (routines), `store.db`, conversation blob DBs
    - `workflows/` — shared user skills
    - `managed-skills/`, `plugin-skills/` — shared
    - `agent-transcripts/` — per-Bot transcripts
  - `chrome-profile/` — shared browser (listing showed only `machine-id`; cookies live in the Chrome
    user-data the browser actually uses)
  - `cli-config/` — shared CLI creds (empty at probe time)
  - `reference/` — in-box docs (`app-ui.md`, `debugging-the-box.md`)
  - `sand-host/` — host runtime, not project storage
  - `.config`, `.cursor`, `.cache`, `.local` — normal home; not an advertised durability tier

Convention: per-Bot state = `sand-data/agents/<id>/`. Shared work = `/workspace`. Shared identity on
the machine = Chrome + `cli-config` + rest of home. Do not use Bots as a security boundary.

### Q3 — routines mid-run

- **App / laptop closed:** does not stop cloud work. Routines are scheduled off-box; a mid-run turn is
  expected to finish.
- **Computer Update (or Recover):** docs say wait for active work to finish first. There is **no
  checkpoint/resume API**. Practical model:
  - in-flight box tools die with the instance
  - the routine **definition** survives (`automations/` + Cursor's scheduler)
  - the interrupted run does **not** resume mid-prompt; next fire is a fresh wake
  - if the computer is down at fire time, that run fails/misses until the box is back
- Grok Bot's own recommended model: **cancel in-flight execution, keep the schedule, next tick starts
  from scratch.** Do not model snapshot/restore as "resume a half-finished routine."

Sources cited by the instance: docs.x.ai/grok-bot/computer-and-apps, cursor.com/docs/grok-bot/work,
cursor.com/help/grok-bot/computer-recovery, docs.x.ai/grok-bot/troubleshooting, plus live listing.

---

## Batch 2 — roles and memory

### Q4 — memory model

Three **scopes**, three **tiers**.

Scopes:
- **agent (per-Bot):** `/home/box/sand-data/agents/<id>/memory/` — kept across chats, even after a
  clear. Probe instance had `profile.md` + `log/2026-09.md`.
- **user (shared across every Bot on the account):** `/home/box/agent-data/user-memory/` — empty on
  this account. Intended for name, timezone, prefs every Bot should know.
- **project:** only if the Bot joins a project; none joined.

Tiers (within each scope): `profile` (injected every turn, foundational) · `log` (dated history) ·
`note` (fades fast). Conflict order: **agent memory > project > user**.

Conversation transcript is separate from memory. Memory = stable prefs/facts/summaries, not a full
replay; changing facts belong in the source system.

What it stores: writes when a fact is durable and useful (who you are, standing job, recurring prefs)
via `update_state`. Does not dump the chat. Routine/skill/profile changes live in other stores
(`automations/`, `workflows/`, `profile.json`).

Visibility/editing: no memory browser in Settings (per-Bot pane = profile + routines + computer).
Edit path is conversational — tell the Bot, it `write`s / `forget`s (forget needs the exact recorded
sentence). Files are ordinary markdown on disk, so inspectable. Deleting the Bot removes its memory;
hiding does not.

Per-Bot vs shared: Bot memory is per-Bot **in the prompt** — but a Bot can `ls` another Bot's memory
shard on the shared filesystem (filesystem sharing ≠ prompt injection). Skills in `workflows/` are
global. Plugins/connectors are account-wide. Conversations not shared unless via group chat or a
message.

### Q5 — handoff between Bots (empirically tested)

Mechanism: async `SendToAgent` by id. Sender gets "sent"; no reply in the same turn. Recipient wakes
on a hidden `[agent]` cue carrying sender name + id + the **verbatim text**, plus a wrapper
(instructions to reply via SendToAgent, don't treat it as the user typing). Images attach on 1:1;
groups are text-only.

Confirmed by the receiving Bot:
1. Received the hidden `[agent]` wake + verbatim text. **No file bytes** in the message — only the
   path the sender wrote.
2. **Shared disk works:** it read `/workspace/trevor-handoff-probe.txt` and quoted it exactly.
3. **No context carry-over:** no sender chat, memory, or system prompt. Only name/id + shared group.
4. **Receiver's memory unchanged** — it did not auto-write the ping. Memory is opt-in on each side.

Net: a handoff = async text (+ optional images 1:1) + whatever is on the shared box.

### Q6 — job description vs behavior

`profile.json` fields: `name`, `description`, `title`. Docs treat description as **standing rules**,
messages as **this task**. On first run a non-empty description is treated as the assignment (skip
onboarding, start work).

It is **advisory in the strong sense**: biases defaults and first-run, but is **not** a hard
capability sandbox. The probe Bot did out-of-lane research on request despite a research-and-writing
memory — it won't silently ignore its job, but won't refuse explicitly assigned out-of-lane work.
Safety/policy still overrides the description. Duplicate-Bot copies profile/routines/skills, not
learned memory.

## Batch 3 — autonomy boundary
_(pending)_

## Batch 4 — connector/session sharing
_(pending)_
