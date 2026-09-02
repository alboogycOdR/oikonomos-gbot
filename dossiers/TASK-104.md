# TASK-104 — apps/dashboard: evidence/audit browser + PWA packaging (E9.1c)

## Work Log

- [2026-09-02T17:20:00Z] [S5] Resumed on existing branch `task/TASK-104-s5` (dispatcher had
  already claimed/rebased; control.mode=strict, no PLAN.md writes from S5). Read
  AGENTS.md, briefing, PLAN.md TASK-104 block, and existing dashboard code
  (App.tsx, api.ts, RunDetailPage + its test) to match conventions. Checked
  specs/ for OIK-090/OIK-091 text — not found verbatim in any WBS addendum;
  treated PLAN.md's Description (which already quotes the OIK-090 bar and
  spells out the PWA/offline requirement precisely) as the operative spec
  text for this task, since it's self-contained and unambiguous. No
  SPEC_AMBIGUITY block needed.

  Implemented:
  - `src/pages/EvidenceBrowserPage.tsx` — standalone evidence/audit browser.
    Distinct from TASK-102's `RunDetailPage` (which only reaches the trail by
    clicking through the run list): this page takes a run_id typed directly
    into a form, or a `/evidence/:runId` deep link, and reconstructs the full
    decision trail via `GET /runs/:id/evidence` (already implemented in
    `lib/api.ts` from TASK-102) — event type, verdict/reason (read from
    `payload`, since those aren't top-level `AuditEvent` fields), capability,
    tier, timestamp. No direct DB access anywhere in this package (never has
    been — the whole package is fetch-only against control-api).
  - `App.tsx` — added `/evidence` and `/evidence/:runId` routes, plus a
    minimal `TopNav` (Runs · Approvals · Evidence browser) so the new page is
    discoverable, not just deep-linkable.
  - PWA packaging (OIK-091):
    - `public/manifest.json` — name/short_name/start_url/display:standalone,
      192x192 + 512x512 icons (both `any` and `maskable` purpose).
    - `public/icons/icon-{192,512}.png` — generated via
      `scripts/gen-icons.cjs` (raw PNG chunk + Node's built-in zlib deflate,
      no image-library dependency added). Solid Basileia-slate square;
      re-runnable if the brand color changes.
    - `public/sw.js` — service worker, app-shell caching ONLY. Explicitly
      bypasses (never intercepts, never caches) any request under `/runs`,
      `/approvals`, `/auth` — the exact prefixes `lib/api.ts` calls — before
      any cache read/write happens in the fetch handler, so approval/run
      state can never be served stale offline (per this task's Description,
      called out as actively dangerous for an approval surface).
    - `src/lib/registerServiceWorker.ts` — registers `/sw.js` on window
      `load`, guarded by feature-detection; wired into `main.tsx`.
    - `index.html` — `<link rel="manifest">`, theme-color, icon links.

  Tests added: `EvidenceBrowserPage.test.tsx` (form lookup, deep link,
  not-found path), `registerServiceWorker.test.ts` (registers iff
  supported), `pwa.test.ts` (static sanity: manifest installability fields,
  sw.js never caches API paths — asserts the bypass check is ordered before
  the first `caches.match` call in the fetch handler so it can't regress
  into dead code, index.html links the manifest).

  Test evidence:
  - `pnpm test` (apps/dashboard): 6 files, 16 tests passed.
  - `pnpm typecheck` / `pnpm build` (apps/dashboard): clean; `dist/` contains
    manifest.json, sw.js, icons/ (vite copies `public/` verbatim) alongside
    the built app shell.
  - `pnpm -r test` (repo root): all packages green EXCEPT a pre-existing,
    unrelated failure in `services/workspace/src/mailbox.test.ts`
    ("exports the closed handoff-kind set…", TASK-099 territory). Verified
    this is not caused by my changes: `git stash`-ed all TASK-104 work,
    re-ran `pnpm test` inside `services/workspace` on the unmodified branch
    tip (commit `6961522`) — same failure, same assertion. `services/workspace`
    is outside `apps/dashboard/**` (my Owned_Paths); not touched, not fixable
    by me. Flagging for ORCH rather than touching someone else's territory.
  - `pnpm -r build` (repo root): all 17 buildable packages/apps exit 0,
    including `apps/dashboard`.
  - `pnpm lint` (repo root, eslint .): clean, exit 0.
  - `pnpm canaries` (repo root): 11 files, 15 passed | 2 skipped, exit 0.

  Net: TASK-104's own AC and its own package are fully green. The task's
  third AC line item ("`pnpm -r test` ... all exit 0") is blocked by a
  cross-package failure outside my territory that predates this branch —
  reporting via progress_note/artifacts rather than blocking my own task on
  someone else's package.

  Status → needs_review.
