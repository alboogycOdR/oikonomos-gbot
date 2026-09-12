# OIKONOMOS Workspace Wave v1.0 — spec entry point for Wave "Workspace-1"

> **Changelog:** v1.1 (2026-09-12, ORCH) — §6.1 gains the prefix-collision rule found while executing TASK-240: the release proxy mounts API paths by prefix, so a dashboard client route must not share a top-level segment with an API prefix; `GET /workspace/summary` (TASK-237) is mounted at its exact path and `/workspace/:threadId` (TASK-236) stays a client route. No task's Owned_Paths or acceptance criteria change.

Written 2026-09-12 (ORCH, after the independent review of the CX advisory package at
`E:\DELL-PROJECTS\GROKBOT-RESEARCH-DOCS\ORCH_REVIEW\` — verdict, disposition matrix,
execution proposal, owner decisions). The owner accepted the review's recommendations
on 2026-09-12 with one override: **there is no release date. Full scope, maximum
quality.** Work is ordered by dependency and review capacity, never by calendar.

Sources this spec turns into binding requirements (evidence stays where it is):

- `GROKBOT-RESEARCH-DOCS/OIKONOMOS_ARCHITECTURE_AND_PRODUCT_DIRECTION_2026-09-12.md` §3, §5, §6
- `GROKBOT-RESEARCH-DOCS/OIKONOMOS_DELIVERY_PLAN_BEFORE_2026-09-17.md` WP-A…WP-F (labels only)
- `GROKBOT-RESEARCH-DOCS/OIKONOMOS_RELEASE_ACCEPTANCE_2026-09-16.md` A01–A20, C01–C05
- `GROKBOT-RESEARCH-DOCS/ORCH_REVIEW/DISPOSITION_MATRIX.md` (which rows were accepted / adapted)
- `specs/OIKONOMOS_CHAT_SURFACE_v1.0.md` §1 (the shape this extends)

Precedence: sits alongside `OIKONOMOS_CHAT_SURFACE_v1.0.md` and the parity disposition;
overrides no ADR. Every line-number citation below is against `master` `ae122be`.

Owner decisions in force (from `ORCH_REVIEW/OWNER_DECISIONS.md`, accepted 2026-09-12):
D1 tabs = persistent Bot/group workspaces in the web app, Chat first, Results/Work next,
Computer view after take-over is proven · D2 web Google sign-in is sequenced after the
controller and session work, not before · D3 acceptance-test paid inference allowance
**R60**, hard stop, ledger from `spend_records` · D4 global cap of **two** executing runs
with per-role serialisation · D5 workstation hosting for now, uptime limitation
disclosed, migration later · D6 roster CX9 + S5, ORCH executes infra/scripts/acceptance
directly · D7 no date.

---

## 1. Product shape

A signed-in user on one HTTPS origin can open several Bot or group workspaces, switch
between them with the transcript, the live stream subscription, the composer's recipient
and the routines panel always agreeing, leave a distinct unsent draft in each, send work
and keep the draft if the send fails, see each workspace's running / waiting-approval /
blocked state while looking at another, reload without re-logging in, invoke an enabled
skill, approve or deny a parked action, complete a connector read workflow and a
public-browser research workflow, observe a two-Bot handoff in a group, and inspect a
completed run's result, evidence, approvals and cost. Closing a workspace tab closes a
view; stopping work is a separately named runtime action; pausing a routine never cancels
a running run; marking a message read never resolves an approval.

## 2. Workspace controller (dashboard)

2.1 **One owner of selection.** Exactly one component owns the active thread id and passes
it down as a controlled prop; `ChatShell` must not keep its own copy. The SSE
subscription, the routines/permissions lookup, the composer recipient and the rendered
transcript are all derived from that single value. (Defect: `apps/dashboard/src/pages/ChatPage.tsx:116` vs `components/chat/ChatShell.tsx:54-64`; SSE keyed at `ChatPage.tsx:219-253`.)

2.2 **Pending state keyed by thread.** "Bot is responding" and "pending since" are stored
per thread id (and per run id where known). Switching threads neither clears nor
inherits another thread's pending state. (Defect: `ChatPage.tsx:119,125,179-181`.)

2.3 **Drafts keyed by thread, cleared on acknowledgement.** The composer's text is stored
per thread id in memory. It is cleared only after the send request returns success. A
failed send leaves the draft in place and surfaces the error. Drafts are never persisted
to storage and are dropped on logout. (Defect: `components/chat/ComposeBox.tsx:18-25`, `ChatPage.tsx:297`.)

2.4 **Message merge by id.** Streamed and fetched messages merge by message id; a later
history response never replaces messages that arrived by stream after the request began.
Subscriptions close on thread switch, logout and unmount.

2.5 **Page-boundary wiring.** The Members panel shows the server roster for the active
thread (group members, or the single bot). After a bot or group is created from the
sidebar, the thread list is refreshed. (Defect: `ChatPage.tsx:292` `members={[]}`; `BotSidebar.tsx:73-88` fires no page refresh.)

2.6 **Route.** `/workspace/:threadId` selects a thread; a 404 from the server (the
existing 404-never-403 ownership rule) renders a not-found state, never another user's
data. `/` redirects to the most recent thread or the empty state.

2.7 **Proof.** `ChatPage` is mounted with fake HTTP and a fake stream at the network
boundary, with **at least two threads in the fixture**, and the suite exercises a switch.
The existing single-thread fixtures (`ChatPage.test.tsx`) are insufficient.

## 3. Session

3.1 `GET /auth/me` returns the current principal (tenant id, principal kind, expiry)
for a valid session cookie and 401 otherwise. The dashboard calls it on load and treats
a 200 as authenticated; it never assumes authentication from local state.

3.2 `POST /auth/logout` clears the session cookie (`auth.ts:80` already builds the
clearing header). The dashboard drops all in-memory workspace state on logout.

3.3 **Web Google sign-in.** The dashboard authenticates through the Firebase web SDK and
exchanges the ID token at the existing `POST /auth/google` (`app.ts:947-961`), so web and
Android share one principal and one tenant. The shared-token `/auth/login` remains for
operator scripts. Until 3.3 lands, the dashboard is labelled an operator login and
acceptance case A20 is not run.

## 4. Workspace summary

4.1 `GET /workspace/summary` returns, for every thread the principal owns, `{threadId,
latestRun: {runId, status} | null, pendingApprovals: number, lastActivityAt}`. It is
tenant-scoped through the same ownership rule as `GET /threads`, bounded (one row per
thread, no message bodies), and backed by `messages.run_id → runs` and
`approvals.run_id`; **no new association table.** Indexes are added if the plan shows a
sequential scan on `messages(run_id)` or `approvals(run_id, status)`.

4.2 The dashboard polls 4.1 on an interval and on window focus for background
workspaces, and uses the active thread's SSE stream for the foreground one. Never one
stream per workspace.

4.3 **Blocked reason.** A workspace whose latest run is `waiting_approval` or `failed`
shows the deterministic reason (approval pending → link to the card; deny reason string
from the run's terminal audit event, e.g. `capability.disabled`, `budget.platform_exceeded`)
and the one action that applies: approve, retry (re-send), or nothing. No invented text.

## 5. Run concurrency

5.1 At most **two** runs execute at once across the tenant (D4). 5.2 Runs for the same
role are serialised. 5.3 A run submitted beyond the cap is recorded as queued with a
visible reason and starts when a slot frees; it is never dropped. 5.4 **Liveness
assertion:** a test submits three runs and observes the third is queued, not started;
a second test proves the gate is present in the production composition (the gate must
emit evidence when it queues, and the test keys on that evidence). Today no cap or
serialisation exists: runs are `void deps.runChatTask(...)` at `app.ts:1738,1756,2131`.

## 6. Release environment

6.1 **One origin.** A reverse proxy on the workstation serves the built dashboard and
proxies the API and SSE on one HTTPS origin over Tailscale, so the `Secure;
SameSite=Strict` cookie (`auth.ts:75-77`) works without a second origin.
**Prefix rule (v1.1):** the proxy mounts API paths by prefix. A dashboard client
route must never share a top-level segment with an API prefix; where one path does
(`GET /workspace/summary` under the client's `/workspace/:threadId`), the API path
is mounted exactly. New API families whose UI also needs routes (projects,
templates) put their client routes under a distinct segment.
6.2 `GET /health` reports the git SHA of the running build; the dashboard embeds its own.
6.3 A required-configuration check lists every required variable by name and reports
present/absent **without printing values**; it must include `OIKONOMOS_CAPABILITIES_ENABLED`
(the unset kill-switch silently denied all governed calls until 2026-09-12).
6.4 **Isolated test database.** A second local Postgres database exists; a script runs
the full suite with `DATABASE_URL` pointed at it and the live worker stopped for the run
(tests read `process.env.DATABASE_URL` directly; pg-boss queue names are fixed literals,
`services/worker/src/jobs/workerJobQueue.ts:6-7`). No test code change.
6.5 A build/deploy/rollback runbook: previous build retained, additive migrations only,
identity and one safe workflow re-verified after rollback.

## 7. Results and Work

7.1 `GET /runs/:id/receipt` returns the run's final bot message, the audit actions taken
(capability, tier, verdict), approvals used, spend as `actual | unavailable`, and
unresolved approvals. Tenant-scoped via the run's task. 7.2 The dashboard renders 7.1 per
workspace as a receipt panel, distinguishing completed action, prepared draft and proposed
next action. 7.3 A Work view lists the workspace's routines with next fire (labelled UTC —
no time-zone support exists), pause / resume / test-run (existing routes
`app.ts:1134-1148`), and the latest run state from §4. 7.4 The `spend.unrecorded` audit
marker fires on the failure path as well as the success path (`chatRunDriver.ts:431,458`).

## 8. Acceptance and review

8.1 The acceptance cases are the workbook's A01–A20 and C01, with these rewordings:
A12 timezone half not run until §9.3 lands; A15 = "worker killed mid-run → watchdog
restarts → run visible as failed/resumable → no duplicate side effect → parked approval
stays parked" until §9.2 lands; A20 not run until §3.3 lands; C02–C05 not run until §9.4.
Every case records candidate SHA, build ids, principal, provider/model, run ids, expected,
observed, cost or "unknown", cleanup status. Paid runs draw on the R60 allowance (D3).
8.2 REVIEW.md gains entries for TASK-214, 224, 227–235 before any decision sheet cites them.
8.3 Every review runs `pnpm -r test` against the §6.4 database.

## 9. Later increments (in scope, sequenced after §2–§8)

9.1 **Gemini immediate stop.** On `human_takeover_required` the Gemini turn terminates
before any further tool in the same batch or any retry executes; the audit event is
recorded at detection, not in the outer catch. Protected path
(`packages/harness-factory/src/providers/gemini.ts`); author and reviewer must be different
models. Today the signal is checked after `adapter.run()` returns (`chatRunDriver.ts:648-744`).
9.2 **Run-execution queue.** Chat runs are driven from a durable queue so a worker restart
re-drives an interrupted run to a real executor turn; `reconcileInterruptedRuns`
(`runLifecycle.ts:224-250`) today only flips status. Exactly-once for governed side effects
remains the approval nonce; anything else re-run must be idempotent or asked.
9.3 **Routine time zone.** A `timezone` on routines, IANA name, used for cron evaluation
and shown with next fire.
9.4 **Web Computer view.** Read-only live view in the dashboard first (authenticated,
same port as mobile, origin-checked WebSocket upgrade), interactive only after TASK-235
proves CDP hand-off and one-holder exclusivity.
9.5 **Hosting.** Migration of control-api, worker and dashboard off the workstation to an
always-on host with boot-without-logon, after headroom, reachability, credentials and
rollback are verified. Needs its own ADR (changes ADR-010's assumed topology).

## 10. Non-goals and withheld claims

Not in this wave: templates, Project entity, manager bot (separate design brief, specs in
progress), event triggers, teach-by-demo, new connectors, native desktop, local-machine
execution, per-grant `domains`/`rate_per_hour` enforcement (TASK-227), OTel export.

No claim is made until its case in §8.1 passes on a real candidate: interactive take-over,
24/7 hosting, restart resilience, shared web/mobile identity, routine time zones, any
connector count, any comparative security statement.
