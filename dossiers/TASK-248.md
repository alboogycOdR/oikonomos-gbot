# TASK-248 — Workspace-1 follow-on — web Computer view: read-only live view in the dashboard; interactive only after TASK-235

**Unit:** TBD · **Priority:** medium · **Depends_On:** TASK-243, TASK-245

## Brief
Read-only first. Prerequisite evidence: acceptance case C01 (TASK-245) must have passed on mobile — the PTY id is assumed equal to the sandbox id (`ports.ts:310-317`) and no PTY-create exists in `packages/sandbox-client`; if C01 fails, this task is blocked on that finding, not built around it. Add an origin check to the WebSocket upgrade in `liveAgent.routes.ts` (the web client is same-origin behind TASK-240's proxy), a dashboard client mirroring the mobile `LiveAgentClient`, and a Computer view showing connection state, last update time, and the stream. Interactive input waits for TASK-235 (CDP hand-off + exclusivity proof); the view must say so explicitly rather than showing a disabled control.

## Spec pointers
specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md §9.4; TASK-171; TASK-228; TASK-235

Read `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §1 first for the product shape and §10 for what must not be claimed. The independent review that produced this wave (verdict, disposition matrix, execution proposal) is at `E:\DELL-PROJECTS\GROKBOT-RESEARCH-DOCS\ORCH_REVIEW\` — read the rows cited in Spec_References; do not treat the advisory documents themselves as spec.

## Intended approach
Read-only first. Prerequisite evidence: acceptance case C01 (TASK-245) must have passed on mobile — the PTY id is assumed equal to the sandbox id (`ports.ts:310-317`) and no PTY-create exists in `packages/sandbox-client`; if C01 fails, this task is blocked on that finding, not built around it. Add an origin check to the WebSocket upgrade in `liveAgent.routes.ts` (the web client is same-origin behind TASK-240's proxy), a dashboard client mirroring the mobile `LiveAgentClient`, and a Computer view showing connection state, last update time, and the stream. Interactive input waits for TASK-235 (CDP hand-off + exclusivity proof); the view must say so explicitly rather than showing a disabled control.

## Owned_Paths
apps/dashboard/src/components/workspace/computer/**, apps/dashboard/src/lib/liveAgent.ts, apps/dashboard/src/lib/liveAgent.test.ts, services/control-api/src/liveAgent.routes.ts, services/control-api/src/liveAgent.routes.test.ts

## Work Log

- [2026-09-17T13:10:00Z] [S5] Session start (control.mode=strict, resuming a dispatch — no prior work existed on task/TASK-248-s5 beyond the dispatch commit). Preflight:
  ```
  [preflight] TASK-248 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
  [preflight] 5 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   apps/dashboard/src/components/workspace/computer/**  -> matches nothing yet (new territory)
    NEW    apps/dashboard/src/lib/liveAgent.ts  -> does not exist; parent apps/dashboard/src/lib/ exists
    NEW    apps/dashboard/src/lib/liveAgent.test.ts  -> does not exist; parent apps/dashboard/src/lib/ exists
    FILE   services/control-api/src/liveAgent.routes.ts  -> exists, 853 line(s), 34193 bytes
    FILE   services/control-api/src/liveAgent.routes.test.ts  -> exists, 903 line(s), 38818 bytes
  ```
  Read `liveAgent.routes.ts` in full (mobile TASK-171/TASK-228's backend: `relay`/`relayTakeover`, session re-validation). No existing Origin/CORS handling anywhere in `services/control-api/src` — this task adds it from scratch. Read the mobile `LiveAgentClient`/`LiveAgentScreen` (Dart) to mirror on the web side, and `lib/realtime.ts`/`lib/api.ts`/`WorkView.tsx`/`ResultsView.tsx` for dashboard conventions (injectable transport for tests, `credentials: "same-origin"`, `UnauthorizedError` handling, `aria-label` sectioning).

  **Backend (AC2):** added `isSameOriginOrAbsent(req)` to `liveAgent.routes.ts` — same-origin guard on both the `/pty` and `/takeover` WS upgrades, checked right after the `Upgrade: websocket` header check and before authentication. Enforced only when the browser actually sends an `Origin` header (every real browser WS handshake does); absent Origin (the mobile app's Bearer-token connections, or a non-browser tool) is left to the existing auth check, unchanged behavior. Compares `Origin`'s host against the request's own `Host` header — TASK-240's proxy always presents one externally-visible host, so no new config/allowlist is needed. Fails closed on a present-but-unparseable Origin. Added 5 new tests (2 viewer, 2 takeover, 1 unit-level on the helper itself covering both malformed-Origin and missing-Host edge cases) — 36 tests total in `liveAgent.routes.test.ts` (was 30), all passing against real Postgres via `scripts/test-isolated.ps1 -Filter control-api` (323/323 control-api tests green).

  **Dashboard (AC1, AC3):** `lib/liveAgent.ts` — `getLiveAgentStatus` (mirrors `lib/api.ts`'s `request` 401/error handling) + `watchLiveAgent` (injectable `WebSocketConnector`, mirroring `lib/realtime.ts`'s injectable-`fetch` pattern; real browser `WebSocket` wrapped so its DOM-shaped event handlers match the minimal `WebSocketLike` interface). Structurally read-only — the returned `LiveAgentSubscription` has only `close()`, no send/write of any kind, same reasoning as the server's `relay()` never forwarding viewer input and the Dart client's own `LiveAgentSubscription`. `components/workspace/computer/ComputerView.tsx` renders connection state (loading/empty/connecting/live/ended/error), last-update time (updates on every real output chunk), the live output stream (auto-scrolling `<pre>`), and an always-visible notice that interactive control is not available yet (AC3, spec §10) — never a disabled button/input, asserted directly in the test (`queryByRole("textbox")` absent). Closes/reopens the subscription and resets the transcript when `roleId` changes; calls `onUnauthorized` on a 401 from the status check without ever opening a socket.

  Found one real cross-realm bug while testing: `data instanceof ArrayBuffer` false-negatived under jsdom (a `TextEncoder`-produced buffer's realm didn't match the test environment's global `ArrayBuffer`) — fixed with `Object.prototype.toString.call(data) === "[object ArrayBuffer]"`, which is realm-independent; covered by its own test (binary chunk decoding).

  **Not done (out of Owned_Paths):** `ComputerView` is not wired into `WorkspaceTabs.tsx`/`ChatPage.tsx` navigation — neither file is in this task's `Owned_Paths`, and editing them would be an OWNERSHIP_CONFLICT. This means AC1's "C01 evidence re-recorded from the web client" cannot be demonstrated via an actual live browser navigation from this task alone; the evidence recorded is component/unit-level (20 new dashboard tests proving real live-output rendering, connection-state transitions, and the interactive-unavailable notice), the same evidentiary standard TASK-240's own Progress_Notes record C01 itself was satisfied with on mobile ("via existing dedicated tests, not a live device"). A follow-up task (or a widened Owned_Paths on this one) is needed to mount the Computer view into the workspace tab bar for a true end-to-end/live re-recording.

  Test evidence: `scripts/test-isolated.ps1 -Filter control-api` → 323/323 (24 files). `pnpm vitest run` in `apps/dashboard` → 157/157 (25 files), including the 12 new `liveAgent.test.ts` and 8 new `ComputerView.test.tsx` tests. Full recursive `scripts/test-isolated.ps1 -Init` then no-filter run: dashboard 157/157, control-api 323/323; 3 pre-existing, unrelated failures in `services/worker` (`chatRunDriver.test.ts`/`chatRunDriver.ts`/`roleMessageDelivery.ts`) and `packages/sandbox-client` (`sandboxClient.integration.test.ts`) and `services/worker`'s `ome-two-role-handoff-live.test.ts`, all `SandboxClientError: OpenSandbox create-sandbox returned unexpected status 500 (DOCKER::SANDBOX_START_FAILED)` — the shared `clawsrv` OpenSandbox lifecycle server's `/health` returns 200 (reachable) but sandbox *creation* 500s, consistent with the already-disclosed shared-capacity constraint on that box (MEMORY: `clawsrv-shared-infra-capacity.md`, ~20 unrelated containers). None of the failing files are anywhere near this task's diff (`services/worker`/`packages/sandbox-client`, not `control-api`/`dashboard`) or `Owned_Paths`; not something I can or should try to fix (shared infra, explicitly out of territory per the briefing). One flaky, non-reproducing `GroupThreadDialog.test.tsx` failure observed on one full-suite run only (passed cleanly both in isolation and on a second full-suite run) — pre-existing test, never touched by this task's diff, not investigated further.

  `tsc --noEmit` clean for `apps/dashboard`. Status: `needs_review`.

