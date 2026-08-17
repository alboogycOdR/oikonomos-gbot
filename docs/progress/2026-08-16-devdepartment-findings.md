# DEVDEPARTMENT pack — findings from 24h of live use on OIKONOMOS

**UPDATE 2026-08-16T18:55Z:** items #1, #11 and #12 below were independently fixed upstream and landed in this repo via a live pack resync during this same day — confirmed by reading the actual diff before committing it, not taken on trust. Marked **[RESOLVED UPSTREAM]** below with what shipped. The remaining items (2–10) are still open as of this writing.

**Compiled by ORCH, 2026-08-16.** Scope: defects in the DEVDEPARTMENT pack itself (`scripts/dispatch.ps1`, `scripts/control.py`, `scripts/atlas_core.py`, `scripts/atlas_cards.py`, `scripts/tg_commands.py`, `scripts/supervisor.py`) — not defects in OIKONOMOS. Everything below either shipped a fix in this repo (cited by commit) or is reported as an open finding for the pack team to act on. All were found through real multi-builder dispatch/review cycles, not synthetic testing.

---

## Confirmed this session, source-verified

### 1. [RESOLVED UPSTREAM] `git_commit_and_push()` collapses commit-failure and push-failure into one ambiguous message

**Fixed by the pack team, landed 2026-08-16 as `git_commit_and_push_detailed()` returning `(committed, pushed, note)` instead of one boolean** — verified by reading the diff before committing it in this repo (`8322829`). The fix also closed a second, more serious hazard neither this project nor its own commit message had reported: it now fails closed if the target directory isn't itself a git worktree root — the old code let `git` walk *up* to whatever ancestor repo happened to exist, and the fix's own comment cites an observed incident where a user's `HOME` being a git repo caused stray commits to land there. Genuinely good, went further than what was asked.
**File:** `scripts/tg_commands.py:397-407`. Six call sites: `control.py` (×3), `maintenance.py`, `supervisor.py`.

```python
def git_commit_and_push(repo: Path, message: str) -> bool:
    ...
    r = subprocess.run(["git", "commit", ...])
    if r.returncode != 0:
        return False
    r2 = subprocess.run(["git", "push", ...])
    return r2.returncode == 0
```

Every caller renders the single boolean as **"git commit/push failed"** regardless of which step actually failed. **On any project with no remote configured — which describes this repo for essentially its entire build, until minutes ago — the commit always succeeds and only the push fails.** Every single `control.py drain` this session (dozens of invocations, every builder control-block application) printed the ambiguous message, which reads as "your PLAN.md edit may not have committed." It committed every time; only the push (to nothing) failed. This sent review effort chasing a phantom failure mode more than once before the actual cause was confirmed by inspecting the repo directly.

**Fix:** return/report the two outcomes separately — `committed: bool, pushed: bool` — so "committed locally, no remote configured" is distinguishable from "commit itself failed," which is a materially different and more serious condition.

### 2. `scripts/dispatch.ps1` never refreshed the ATLAS index before packing
Nothing in the dispatch path called `atlas.py scan` before `pack`. The index was stale by however long since the last manual scan — measured at one point ~3 hours stale in a builder's context pack, with zero indication to the builder that what it was reading was out of date.

**Fixed locally:** `27faec6` (exclude node_modules/dist), `c48c5501` (refresh index before pack), `716f7a75` (retry once on sqlite contention — concurrent dispatch across builders hits `.devteam/atlas.db` simultaneously and the first scan attempt can fail under lock contention).

**Recommend upstream:** `atlas.py scan` should run as a matter of course before `pack`, with the retry-on-contention built in, not left to each project to discover and patch.

### 3. `scripts/dispatch.ps1` — PowerShell 5.1 prompt-quoting corruption
Embedded double quotes in the composed builder prompt were not escaped before being passed as a `-p` argument. PS 5.1's argv construction splits on unescaped quotes, so a long prompt (measured: 3,392 chars, 42 embedded quotes) arrived at the builder CLI as multiple truncated arguments instead of one string. Symptom was silent and expensive: the builder session exited in ~2 seconds having received a fragment of its actual instructions, and the failure looked like a crashed builder rather than a malformed prompt — diagnosed only by an argv probe, after ruling out three other hypotheses.

**Fixed locally.** Recommend: write the prompt to a temp file and pass via stdin/`-p @file` rather than inline argv on Windows, or explicitly escape embedded quotes before composing the `-p` value.

### 4. `scripts/dispatch.ps1` — the model registry pin was a dead knob for the grok branch
`autopilot.json`'s per-builder `model` field was read but never threaded into the actual grok CLI invocation — the branch always launched with whatever grok's own default was, silently ignoring the configured pin. Confirmed dead until `f1f87047` added `if ($Model) { $CmdArgs += @("--model", $Model) }`.

**Recommend:** an integration test that asserts the launched command line actually contains the configured model flag, not just that config parsing succeeds — this is exactly the "configured but inert" class of bug this project's own review standard (see below) was built to catch, and it existed in the pack's own dispatcher.

### 5. `scripts/dispatch.ps1` — stderr under `$ErrorActionPreference = Stop` aborted the pipeline on a non-error
Codex CLI prints a version banner to stderr on startup. With EAP=Stop in effect during builder execution, that stderr write was treated as a terminating error and killed the dispatch before the builder did anything. Fixed locally by setting EAP=Continue for the duration of builder execution specifically.

### 6. `scripts/dispatch.ps1` (or the underlying `Tee-Object` step) — encoding mismatch loses codex's control block
`Tee-Object` writes UTF-16 LE by default in Windows PowerShell; codex (via `codex exec`) emits UTF-8. The devteam-control JSON extraction regex was matching against a UTF-16 file with UTF-8 content interleaved with NUL bytes and never matched. Fixed locally by re-encoding via `UTF8Encoding(false)` before extraction. This is a Windows-specific trap that will bite any project running codex builders on PowerShell.

### 7. `scripts/control.py` — hardcoded builder unit list rejects any unit outside `{GB, CX}`
`claim`/`extract` had `choices=["GB", "CX"]` baked into the argparse definition. The moment a third unit (S5, Claude-CLI-based) was added via `autopilot.json`'s `builders` registry, dispatch failed outright: `invalid choice: 'S5'`. The registry-driven unit model (`docs/BUILDER_REGISTRY.md`) is real and documented, but `control.py` wasn't reading from it — it had a second, stale, hardcoded source of truth.

**Fixed locally.** **Recommend upstream:** derive valid units from the registry everywhere a unit is validated, with fail-closed behaviour on an unregistered unit — not a second hardcoded list that silently drifts from the one in `autopilot.json`.

### 8. `scripts/atlas_core.py` — `is_ignored()` prefix-match bug on trailing-slash gitignore entries
A `.gitignore` entry like `node_modules/` was matched only against the top-level path, not recursively — so in a pnpm monorepo where every workspace package has its own `node_modules/`, only the root one was excluded from the index; every nested one was indexed. Workaround applied locally via glob-form excludes in `autopilot.json`'s `atlas.exclude` (fnmatch's `*` spans `/`), but that's a per-project patch for what should be correct trailing-slash gitignore semantics in the core tool.

---

## Found in a live resync, this session

### 11. [RESOLVED UPSTREAM] Pack-repo-only test scaffolding gets vendored into downstream projects and fails there by design
A resync landed with `tests/test_sync_from_pack.py::TestPackTemplateShipsSafeDefaults` (`test_atlas_ships_disabled`, `test_control_mode_ships_legacy`) — both read `REPO_ROOT / "autopilot.json"`, i.e. **the consuming project's own live config**, and assert it equals the pack's generic safe-default template (`atlas.enabled: false`, `control.mode: legacy`). That assertion is correct for the pack's own template file, guarding against a live project's onboarding answers accidentally leaking into what ships to the next adopter. It is **wrong once vendored into a project that has already onboarded**, since the entire point of the pack's own "ask, don't auto-flip" onboarding step (`onboard.md` STEP 4, documented in the pack itself) is to deliberately diverge `autopilot.json` from those defaults. On OIKONOMOS — which correctly onboarded with `atlas.enabled: true` and `control.mode: strict`, both explicit human decisions — this test now fails permanently, on every future sync, for a config that is exactly right.

**Recommend:** either don't ship `TestPackTemplateShipsSafeDefaults` into a consuming project's `tests/` directory at all (it belongs in the pack's own repo, run against the pack's own template), or have `sync_from_pack.py` skip/parameterize it once onboarding has run.

### 12. [RESOLVED UPSTREAM] A test still checks a field its own fix already made non-primary

**Both 11 and 12 fixed by the pack team in the same 2026-08-16 resync** — the two `TestPackTemplateShipsSafeDefaults` tests are now gated behind `_is_pack_repo()`, which checks for `.devteam/sync_state.json` (present only in a project that has synced from the pack, never in the pack's own repo) rather than parsing `CLAUDE.md`'s header text — cleaner than an interim local workaround this project independently arrived at for the same root cause on the same day. Verified with three independent mutations before merging: the marker test still fails on a genuinely broken marker config; the safe-defaults tests still fire on a checkout that looks like the pack template with flipped values; and a compensating test ensures no checkout escapes both branches (i.e. it isn't a disguised permanent skip). One assertion from the local workaround — that the singular `marker` fallback field stays a member of `markers[]` — wasn't in the upstream fix and was ported forward as a small addition.
`TestManifestMarkersMatchRealFiles::test_every_marker_section_marker_exists_in_the_real_pack_file` checks only `sync-manifest.json`'s singular `merge_special.CLAUDE.md.marker` field against the literal string in the target file. But `sync_from_pack.py:465` already reads `spec.get("markers") or [spec["marker"]]` — the **plural** array is preferred, and `sync-manifest.json` already carries both the H1 (no-existing-file) and H2 (append-under-heading) marker forms, with a comment explaining exactly why both are needed (`docs/SYNC.md` "Verifying merge_special markers"). The actual merge mechanism is correct and was verified sound by reading the source. The test just never got updated to check the array it's nominally protecting, so its own failure message — **"This is exactly the bug that shipped once already."** — is a false alarm baked into test code that predates its own fix. Confusing and alarming for anyone hitting it without reading the merge code first, which is exactly what happened this session before the false alarm was traced.

**Recommend:** update the test to iterate `spec.get("markers") or [spec["marker"]]`, matching the code it's meant to guard.

---

## Found in the first live L2 supervisor loop, 2026-08-17

### 13. Dispatch does not refresh a stale worktree's PLAN.md in strict mode → builder can false-block on a task it was just assigned
The first `supervisor.py --loop` run dispatched CX onto a fresh task (TASK-038) while CX's worktree was still checked out on a **previous, merged task branch** (`task/TASK-017-cx`). In strict mode the dispatcher claims the task in the **main** PLAN.md, but it logs `Worktree is on 'task/...' — NOT refreshing (resume path)` and leaves the worktree's own PLAN.md at its stale snapshot. CX's mandatory preflight (`preflight_paths.py TASK-038`) reads the **worktree** copy, does not find the just-claimed task, and correctly fail-safes with a `SYNC_MISMATCH` block. **The failure is non-deterministic:** in the very same tick, GB was dispatched onto TASK-028 from an equally-stale worktree, recognized the staleness, read the main-checkout PLAN instead, and completed the task (88 tests green). So whether a builder proceeds or false-blocks on a correctly-assigned task is a coin flip on builder behaviour, not on task validity.

**Impact:** one false block halted an unattended 4-hour loop on its second tick (see finding #14). **Recommend:** in strict mode, when the dispatcher claims a task for a worktree sitting on a *different, already-merged* task branch, it must reset that worktree to the integration branch (or explicitly refresh its PLAN.md) before launching the builder — the "resume path, don't refresh" shortcut is only safe when the worktree is on *this* task's branch. Alternatively, standardize that preflight always resolves PLAN.md from the main checkout (`git rev-parse --git-common-dir`), the same fix already applied to the ATLAS liveness check (#9).

### 14. `validate_plan.py` rejects `<TOKEN>: detail` Blocked_Reasons that the dispatch prompt explicitly permits
The dispatch/builder prompt tells builders: *"blocked_reason must start with SPEC_AMBIGUITY, MISSING_DEPENDENCY, OWNERSHIP_CONFLICT, SYNC_MISMATCH, TOOLING_FAILURE, or OTHER:"*. CX followed that literally and emitted `SYNC_MISMATCH: <explanation>`. But `validate_plan.py` accepts only a **bare** vocabulary token or `OTHER:<text>` — it rejects `SYNC_MISMATCH: <detail>`, marking PLAN.md protocol-illegal. The supervisor then correctly STOP-THE-LINE-halted on the illegal plan. So a builder that does exactly what the prompt says can render the plan illegal and halt the loop. The two contracts disagree: "must start with" (prompt) vs. "must equal, or be OTHER:" (validator).

**Impact:** this is what actually killed the loop — an internal contract mismatch, not a real defect in anyone's work. Combined with #13, a single stale worktree took down an unattended run via two independent pack defects stacking.

**SMOKING GUN (added 2026-08-17): the pack contradicts ITSELF, not just the prompt.** `scripts/control.py::apply_control_to_plan` WRITES `Blocked_Reason: <TOKEN>: <detail>` into PLAN.md, and the pack's own `tests/test_control.py::test_blocked_sets_status_and_reason` asserts exactly `**Blocked_Reason:** TOOLING_FAILURE: flutter build crashes`. So the control-application layer emits the very shape `validate_plan.py` rejects. It is not builders misreading a prompt — the pack's writer and its validator disagree, and the contradiction only surfaces at runtime when a real block gets applied then validated, which is what halted the L2 loop TWICE on 2026-08-17 (once on SYNC_MISMATCH #13, once on a legitimate TOOLING_FAILURE).

**LOCAL PATCH APPLIED (oikonomos 2026-08-17, pending upstream):** `validate_plan.py` now accepts `<TOKEN>: <detail>` (split on the first `:`, require the head to be a vocabulary token) in addition to a bare token or `OTHER:<text>`, with a regression test in `test_validate_plan.py`. This aligns the validator with `control.py`'s existing output. `validate_plan.py` is `framework_owned`, so this patch will be reverted by the next pack sync — **the real fix must ship upstream.** Recommend upstream do the same validator change (it is the minimal one and matches what control.py already writes), OR, if the bare-token form is truly intended, change BOTH control.py to write the token bare + detail into progress_note AND the dispatch prompt to stop saying "must start with". Whichever — the writer, the validator, and the prompt must agree; today all three disagree.

## Design gap, confirmed by measurement rather than reading

### 9. `.devteam/` is gitignored → ATLAS's index is per-worktree, and nothing documents or handles this
`atlas.db` lives under `.devteam/`, which is (correctly) gitignored — so every git worktree has its **own independent copy**, and only the main checkout's copy is ever refreshed (by whatever calls `atlas.py scan` from the repo root). A builder session running inside its own worktree reads an index that no process maintains and that can be arbitrarily stale — measured once at ~3 hours behind the main checkout's last scan.

This was **not obvious from the code**, and cost real orchestration time: three consecutive attempts to write a liveness/coverage check against the worktree's index failed for what looked like three different reasons (keyed on commits-behind-HEAD, then commits-behind-merge-base, then a wrong path) before the actual root cause — the per-worktree gitignore split — was identified. Once identified, the fix pattern was straightforward (resolve the **main checkout** via `git rev-parse --git-common-dir` and read its index instead), but nothing in ATLAS's own documentation states that the index does not follow a worktree, which is exactly the kind of thing a tool built for multi-worktree dispatch should say about itself.

**Recommend:** document this explicitly in ATLAS's own docs, and consider whether `atlas.py` should offer a first-class "resolve the index of the main checkout from any worktree" helper, since any project doing per-worktree builder dispatch will hit this.

### 10. Layer 1 LLM summary cards (`scripts/atlas_cards.py`) have never been exercised in 24h of real multi-builder use
By design (documented in the module's own header, R4), `atlas.py scan` never triggers card generation — it's a deliberately separate, explicitly-priced action (`cards` subcommand), never implicit. That's a reasonable design choice on its own. But **nothing in `dispatch.ps1` or the review flow ever calls it**, so across a full day of real dispatch/review cycles the card layer sat at `cards: 0` the entire time — every context pack fell back to raw-file reads for every touched file, with none of the intended hash-pinned summary benefit.

This is not necessarily a bug — it may be correctly gated behind a cost decision the project hasn't made — but as shipped, a project adopting DEVDEPARTMENT has no signal that this layer exists and is dormant unless someone goes looking. **Recommend:** either wire an explicit trigger point into the dispatch or review flow (even just "generate cards for files touched by this task's Owned_Paths, gated by a cost flag"), or make the dormancy visible — e.g. `/devteam-status` noting "ATLAS cards: 0 generated, layer unused" — so an adopting team can make the cost decision deliberately rather than discover the feature was never wired at all.

---

## Not pack bugs, but worth relaying as template/protocol guidance

These are project-level customizations we made to `CLAUDE.md` in response to real incidents — not defects in pack code — but the underlying failure mode is generic enough that other DEVDEPARTMENT adopters will likely hit the same thing, so they may be worth folding into the pack's onboarding template rather than left for each project to rediscover:

- **A review scoped to "the task's own package plus lint/typecheck/build" can miss a real cross-package regression.** This project's master went red for ~2 hours because two independent review passes each ran only their own task's package tests; the actual failing assertion was in a third package neither review touched. Fix was a one-line rule: the review standard's test-run step must always include the full recursive suite, not a filtered one. Worth being the pack's default recommendation, not something each project has to get burned by first.
- **A "protected paths" list phrased as "all settings and subagent configs" is under-specified.** It's easy to write a protected-paths rule that covers `.claude/settings*.json` and `.claude/agents/**` but not `.claude/commands/**`, `.claude/skills/**`, or a project's own mechanical-enforcement `hooks/**` — and the last two are exactly where an edit can silently weaken the review procedure itself rather than fail a visible test. Worth the pack's own guidance naming these explicitly rather than leaving "settings and subagent configs" open to a narrow reading.

---

## Summary for forwarding

Eight source-confirmed pack-code defects (items 1–8), two test-scaffolding defects found live in a resync (items 11–12, both traced to source before reporting so neither is a false positive), one confirmed design gap that cost real diagnostic time across three rounds (item 9), one dormant/unwired feature worth surfacing rather than leaving silent (item 10), and two protocol-level lessons worth folding into onboarding guidance. None of these are OIKONOMOS-specific — all are properties of the DEVDEPARTMENT scripts and templates as shipped, reproducible on any project using multi-builder dispatch with worktrees on Windows/PowerShell.
