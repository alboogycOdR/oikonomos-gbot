# TASK-092 — packages/connectors — durable tenant session pool: create/destroy becomes acquire/release

**Assigned_To:** S5 · **Depends_On:** —

## Brief

Give connector sessions a life longer than one run: a tenant-scoped pool where create/destroy becomes acquire/release, delivering the 'signed in once, available thereafter' property ADR-010 asks for.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §4.2 (F10), §6.2, §9 OIK-208; docs/decisions/ADR-010 §4 (signed in once, available thereafter); docs/research/grok-bot-live-probe-2026-09-01.md Q11

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`packages/connectors/src/sessions/**, packages/connectors/src/index.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

The pool sits UNDERNEATH the working manifest / enumeration / discovery-cache / mcp code from TASK-054 and TASK-083 — none of it is modified, and the review will diff those directories against master. Sessions are scoped by tenant, never by role: roles share sessions by design, which is exactly why a role is not a security boundary. The probe's Q11 contract is the security bar — the model gets an opaque handle, never a token.

## Work Log

### 2026-09-02T01:05Z — implemented, tested, needs_review

Implemented `ConnectorSessionPool` per §6.2:
- `packages/connectors/src/sessions/types.ts` — `ConnectorSessionHandle` (opaque: sessionId/tenantId/connectorId/mcpServers only, no token/url/header beyond what the injected minter already resolved), `ConnectorSessionMinter`, `ConnectorSessionPool` interface (`acquire`/`release`/`size`), `ConnectorSessionPoolError`.
- `packages/connectors/src/sessions/pool.ts` — `createConnectorSessionPool`. Keyed by `${tenantId} ${connectorId}` (never role — roles share sessions by design, F10). `acquire` mints on first use via injected `mint` fn, reuses the live handle on every subsequent call, transparently re-mints once `ttlMs` (default 1h) has elapsed since mint — no observable failure on expiry. `release` decrements a lease count and is a safe no-op for a stale/foreign handle; it never tears the session down (create/destroy → acquire/release is the whole migration).
- `packages/connectors/src/sessions/index.ts` — barrel.
- Wired into `packages/connectors/src/index.ts` (only file outside sessions/ touched, as scoped by Owned_Paths).

Left untouched, as the spec requires: manifest/, enumeration/, discovery-cache/, mcp/, registration/ — the pool sits underneath them, doesn't modify them. No `services/worker` or `packages/harness-factory` change (that's TASK-091/076 territory — `ConnectorMount`/`environment.sessionPool` wiring is out of scope here per Owned_Paths).

Deliberately NOT done (out of scope for this task's territory): persisting the pool itself durably across process restarts. Spec §6.2 describes the pool as "durable across runs" meaning across task runs within a live process/environment, not across container restarts of the pool holder itself; that's the Office/environment durability layer (TASK-089, done) plus TASK-091's `environment` binding, which is what actually keeps a `ConnectorSessionPool` instance alive process-to-process. This task builds the pool contract and in-memory implementation the durable environment will hold.

Test evidence:
- `pnpm vitest run src/sessions` in packages/connectors: 8/8 passed (mint-once reuse, tenant-scoping, release-without-teardown-then-reacquire, transparent re-mint past ttl with a fake clock, safe no-op release for stale/foreign handle, empty-input rejection, mint-failure wrapping, handle field-shape assertion for opacity).
- `pnpm typecheck` in packages/connectors: clean.
- `pnpm -r test` at repo root (full recursive suite per CLAUDE.md amendment): exit 0, all packages green, no cross-package regression introduced.

Diff scope check: `git diff master --stat` shows only `packages/connectors/src/index.ts` (modified) and the new `sessions/` files — plus a stale, already-on-master `AUTOPILOT_LOG.md` divergence from branch lag that I did not touch and did not stage.

Committed on task/TASK-092-s5 (ce6b596). Handing to needs_review.
