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
_(pending)_

## Batch 3 — autonomy boundary
_(pending)_

## Batch 4 — connector/session sharing
_(pending)_
