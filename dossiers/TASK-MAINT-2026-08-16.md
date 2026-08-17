# TASK-MAINT-2026-08-16 dossier

## Brief

Nightly self-audit failure (2026-08-16). Failed steps: `harness_audit`, `pytest`.
Acceptance: all nightly audit steps pass (harness_audit, pytest).
Owned_Paths: `scripts/**`, `hooks/**`, `tests/**`.
Branch: `task/TASK-MAINT-2026-08-16-gb` (claimed by dispatcher; created from master).

## Work Log

- [2026-08-16T16:55:00Z] [GB] Session start. Newly claimed; created `task/TASK-MAINT-2026-08-16-gb` from master. Preflight (c8b9872 filesystem check), verbatim:

```
[preflight] TASK-MAINT-2026-08-16 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   scripts/**  -> 32 file(s):
           scripts/atlas.py
           scripts/atlas_cards.py
           scripts/atlas_core.py
           scripts/atlas_episodes.py
           scripts/atlas_pack.py
           scripts/board_publisher.py
           scripts/budget.py
           scripts/builder_registry.py
           scripts/control.py
           scripts/dispatch.ps1
           scripts/dispatch.sh
           scripts/distiller.py
           ... and 20 more
  GLOB   hooks/**  -> 11 file(s):
           hooks/hooks.json
           hooks/lib.js
           hooks/package.json
           hooks/pre-compact.js
           hooks/run-tests.js
           hooks/secret-scan.js
           hooks/session-end.js
           hooks/session-start.js
           hooks/territory-firewall.js
           hooks/territory-precommit.js
           hooks/test-territory-precommit.js
  GLOB   tests/**  -> 28 file(s):
           tests/test_atlas_cards.py
           tests/test_atlas_cards.py
           tests/test_atlas_core.py
           tests/test_atlas_episodes.py
           tests/test_atlas_pack.py
           tests/test_board_publisher.py
           tests/test_budget.py
           tests/test_builder_registry.py
           tests/test_control.py
           tests/test_dispatch_worktree.py
           tests/test_distiller.py
           tests/test_instincts.py
           tests/test_maintenance.py
           ... and 16 more
  GLOB   tests/**  -> 28 file(s):
           tests/test_atlas_cards.py
           tests/test_atlas_core.py
           tests/test_atlas_episodes.py
           tests/test_atlas_pack.py
           tests/test_board_publisher.py
           tests/test_budget.py
           tests/test_builder_registry.py
           tests/test_control.py
           tests/test_dispatch_worktree.py
           tests/test_distiller.py
           tests/test_instincts.py
           tests/test_maintenance.py
           ... and 16 more
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  PLAN.md description truncated. AgentShield Grade A (95/100) is WARN (exit 1) in harness-audit.ps1, not FAIL. harness-audit FAIL is likely from step 3 pytest (same as independent pytest step). Reproducing `python -m pytest tests/ -q`.

- [2026-08-16T16:57:00Z] [GB] Reproduced: 3 failed / 694 passed in `tests/test_sync_from_pack.py`. Failures are pack-template assertions running against this onboarded checkout: (1) CLAUDE.md H1 is `# CLAUDE.md — OIKONOMOS`, not the pack marker `# CLAUDE.md — Orchestrator Briefing (ORCH)` — H2 `## Multi-Agent Orchestration — DEVDEPARTMENT (ORCH)` is present and is in `markers[]`; (2) `atlas.enabled=true` and (3) `control.mode=strict` are legal onboarding flips (dispatch is strict). Cannot edit `CLAUDE.md` / `autopilot.json` / `sync-manifest.json` (outside Owned_Paths). Fix stays in `tests/test_sync_from_pack.py`.

- [2026-08-16T17:02:00Z] [GB] Tests updated: marker check uses `markers[]` (any match) and requires primary `marker` stay listed; pack-default pins for atlas/control skip unless CLAUDE.md first heading is the pack H1; onboarded checkout asserts legal enums + H2 shape. Evidence: `python -m pytest tests/ -q` → 696 passed, 2 skipped; `node hooks/run-tests.js` → 36/36; `powershell -File scripts\harness-audit.ps1` → HARNESS AUDIT: PASS (AgentShield Grade A, PLAN.md OK, pytest 696+2skip, hooks 36). Ready for review.

## ORCH resolution note (2026-08-16T18:55Z)

GB's diagnosis was correct and the fix was reviewed and confirmed to have real teeth (three independent mutations all bit as expected — see REVIEW.md). **The specific code did not merge, and that is not a rework — it was superseded, mid-review, by the DEVDEPARTMENT pack team's own upstream fix for the identical root cause**, which landed in this working tree as an independent resync (`8322829`) while this review was in progress. Upstream's mechanism is cleaner: `_is_pack_repo()` checks for `.devteam/sync_state.json` (present only in a synced project, never in the pack's own repo) rather than parsing `CLAUDE.md`'s header text, and it also fixed a second, more serious hazard GB's fix didn't touch — `git_commit_and_push` silently committing into an ancestor repository when `repo` isn't itself a worktree root.

One piece of GB's fix was genuinely non-redundant and was ported forward: the assertion that `merge_special.marker` (the singular fallback field) stays a member of `markers[]`, which upstream's version didn't include. That's now in `tests/test_sync_from_pack.py` directly.

Credit stands: GB correctly identified this as a pack-level defect rather than attempting to patch around it locally in product code, which is exactly the right call and is now recorded as items #1, #11, #12 in `docs/progress/2026-08-16-devdepartment-findings.md` — all three confirmed resolved upstream by this same resync.
