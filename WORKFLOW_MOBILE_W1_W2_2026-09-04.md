# Workflow — Mobile Client Waves 1+2 (Flutter) + shift fillers

**Date:** 2026-09-04, ~8-hour evening shift · **Builders:** S5, CX, CX9 · **Decomposed on:** Fable 5 (architecture-tier; the CLAUDE.md model table predates the Claude 5 family — Fable satisfies both the architecture bar and, being a distinct model from the S5 builder, the reviewer-parity rule)

## Locked decisions (user, this session)

- **Flutter/Dart** for the mobile client (`apps/mobile/`, a Dart project outside the pnpm/TS workspace — a deliberate, explicit exception to the strict-TypeScript convention, scoped to this client only).
- **Mobile UI first, real multi-user auth after.** Wave 1/2 authenticate with the existing shared `CONTROL_API_TOKEN` exactly as the web dashboard does; per-user accounts are a later, separate program.
- Reference UX: the Grok Bot mobile screenshots (bot roster, create-bot color/shape picker, auto-review toggle, chat).

## Environment facts that shaped the decompose

- **Flutter SDK was not installed** on this machine — ORCH installed it to `C:\tool\flutter` (same pinned-toolchain convention as Node 22 at `C:\tool\node22`) rather than burning a builder session on a 1GB download. Builders invoke it as `C:\tool\flutter\bin\flutter`.
- **No Android/iOS toolchain is assumed.** Wave 1/2 acceptance gates are `flutter analyze` + `flutter test` (VM/widget tests), NOT an APK/IPA build. Real-device builds are a later infrastructure step, deliberately out of scope.
- A native app is not a browser: no CORS constraint, the Dart client calls control-api directly (base URL configurable; the web dashboard's dev-proxy workaround does not apply).
- Push notifications get their **backend** built now (device-token registry + injected push-transport port + event triggers), with the real FCM adapter env-gated — no Firebase credential is required to build or test any of this shift's work, and per non-negotiable 4 no credential may appear in fixtures/logs when one does arrive.
- **Push targeting is deliberately broadcast-to-all-devices** for now: with no per-user accounts (auth deferred by explicit user decision), there is no "your devices" to target. Same trust model as the shared token itself. Documented limitation, revisited when auth lands — not faked now.
- The screenshots' "Usage 11%" figure **cannot be real** until the frozen TASK-143 budget work is redesigned — the settings screen ships without a usage figure; TASK-150 is the design pass that unfreezes that thread.

## Territory model for one Flutter project

`apps/mobile/` is a single interlocked project (one `pubspec.yaml`, one routing table). Parallelizing three builders inside it invites exactly the shared-file collisions this session has hit seven times in TS packages. So: **apps/mobile/ has exactly one owner at a time, sequentially** — S5 for TASK-144→147, then CX9 for TASK-148, then S5 again for TASK-149, each gated by `Depends_On`. Cross-builder parallelism comes from the two non-mobile tracks instead.

## The shift plan

**Dispatch now (parallel, disjoint):**

| Task | Builder | Scope |
|---|---|---|
| TASK-144 | S5 | Flutter skeleton in `apps/mobile/` + typed Dart API client (REST + SSE w/ Last-Event-ID resume, mirroring `realtime.ts`) + token login (session cookie) |
| TASK-145 | CX | Push backend: `device_tokens` migration + db module, `POST /devices` registration route, injected `PushTransportPort`, triggers on approval-created + chat-run-completed. Broadcast semantics documented. |
| TASK-146 | CX9 | TASK-139's two flagged fast-follows: multi-connector `ConnectorMount` identity (stop reporting only the first manifest) + independently assert the reverse (Drive-granted/Calendar-absent) mutation-proof direction |

**Wave 2 (pending, dependency-gated, same shift as builders free up):**

| Task | Builder | Depends_On | Scope |
|---|---|---|---|
| TASK-147 | S5 | 144 | Bot roster screen, chat screen w/ live SSE updates, create-bot flow (name + color/shape) |
| TASK-148 | CX9 | 147 | Approval cards inline in chat (approve/deny → existing endpoints), read-only Routines tab, settings screen w/ auto-review rules (NO usage %) |
| TASK-149 | S5 | 145, 148 | `firebase_messaging` client integration + device-token registration from the app; real FCM config env-gated, fake-transport tested |
| TASK-150 | CX | — (after 145) | **Design pass, not production code:** how run cost is intercepted on the primary Agent SDK path (the gap that froze TASK-143) — research the SDK result message's cost fields, design a decorator around `AgentSdkQueryFn`, prototype + design doc in dossier. Protected-adjacent (`packages/harness-factory`) → CX/CX9 only. |

**Explicitly deferred (named, not dropped):** group-chat screen on mobile; real FCM credentials + on-device testing; APK/toolchain infra; per-user auth; per-user push targeting; Usage % (blocked on the TASK-143 successor).

## Review routing

TASK-146/150 touch protected/protected-adjacent surfaces — authored by Codex units, reviewed by ORCH (now Fable 5, distinct from every builder model — satisfies adversarial parity for S5-authored work too, but protected paths stay with CX/CX9 authors per standing CLAUDE.md rule). Mobile tasks are unprotected territory; standard review.
