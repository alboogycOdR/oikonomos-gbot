# TASK-090 — services/workspace — shared workspace paths, durability-tier classification, handoff mailbox

**Assigned_To:** S5 · **Depends_On:** TASK-084

## Brief

Grow the `services/workspace` stub into the single place that understands the Office filesystem: path resolution, durability-tier classification, and the role-to-role handoff mailbox.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §4.1 (F9), §2.2 (tier classification), §3.5 (F8 handoff), §9 OIK-206; docs/research/grok-bot-live-probe-2026-09-01.md Q5

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`services/workspace/src/**, services/workspace/test/**, services/workspace/package.json, services/workspace/vitest.config.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

Role directories are a convention, not a boundary — there is a test that asserts role A CAN read role B's directory, because pretending otherwise is how a shared box gets mistaken for isolation. Tier classification is what makes N14 mechanical: a caller writing to D2 gets told the write will not survive a rebuild. The handoff shape comes straight from probe Q5, which tested it empirically: async, verbatim text plus sender identity, workspace paths not file bytes, zero context carry-over, no implicit memory write. A handoff carries no privilege.

## Work Log

### [2026-09-01T23:55Z] [S5] Implemented and tested — needs_review

- Created branch `task/TASK-090-s5` (dispatcher had left HEAD detached at the
  claim commit; branch did not exist yet).
- `services/workspace/src/paths.ts`: `resolveWorkspacePath` (shared workspace
  root or `roleId`-scoped role directory — role directories are convention
  only per F9, no boundary enforced), `classifyTier` (D1/D2/D3 per §2.2),
  `assertContained` (exported post-realpath re-check hook for callers doing
  real disk I/O with symlinks). Traversal guard covers `..`, percent-encoded
  separators, backslash separators, NUL bytes.
- `services/workspace/src/mailbox.ts`: `sendToRole` over TASK-084's
  `sendRoleMessage` (`@oikonomos/db`). Async ack only, verbatim text + sender
  identity + resolved workspace refs (no bytes), zero context carry-over
  (narrow input type), zero memory writes (single persistence call, asserted
  by call-count canary). Dependency-injected `send` so unit tests don't need
  a live DB; a `DATABASE_URL`-gated integration test in `test/` exercises the
  real path.
- `services/workspace/src/index.ts`: barrel exports.
- `package.json`: added `@oikonomos/db` (dependency), `pg`/`@types/pg`
  (devDependency, integration test only) — mirrors `packages/db`/`approvals`
  convention.
- `vitest.config.ts`: same shape as sibling packages.
- Note for ORCH: `pnpm install` after adding these deps modified
  `pnpm-lock.yaml`. That file is outside my Owned_Paths so I did **not**
  stage or commit it (left as an uncommitted working-tree diff, consistent
  with how TASK-085's lockfile sync was handled as a separate `[AUTOPILOT]`
  commit) — it will need the same treatment here before/at merge.
- Deleted `.devteam/CHECKPOINT.md` per its own resume instructions (its
  snapshot referenced TASK-085, already merged; current work is TASK-090).

**Test evidence:**
- `services/workspace`: `npx tsc --noEmit` — clean.
- `services/workspace`: `npx vitest run` — 3 files, 29 tests passed (incl.
  the `DATABASE_URL`-gated integration test, which ran for real against the
  live compose Postgres in this environment, not skipped).
- Root `pnpm lint` — clean.
- Root `pnpm -r test` — all workspace packages green (exit 0), including the
  new `services/workspace` suite alongside everyone else's.
- Root `pnpm canaries` (`@oikonomos/evals-harness`) — 11 files, 17 tests
  passed.

**Acceptance criteria status:** all seven checked against the above; the two
LIVENESS criteria are the dedicated tests named "LIVENESS: ..." in
`paths.ts`/`mailbox.ts` (traversal-guard-removal and D2-non-durable /
no-memory-write canaries respectively).

Status → needs_review.
