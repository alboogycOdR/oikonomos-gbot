# DEVDEPARTMENT pack — findings from 24h of live use on OIKONOMOS

**Compiled by ORCH, 2026-08-16.** Scope: defects in the DEVDEPARTMENT pack itself (`scripts/dispatch.ps1`, `scripts/control.py`, `scripts/atlas_core.py`, `scripts/atlas_cards.py`, `scripts/tg_commands.py`, `scripts/supervisor.py`) — not defects in OIKONOMOS. Everything below either shipped a fix in this repo (cited by commit) or is reported as an open finding for the pack team to act on. All were found through real multi-builder dispatch/review cycles, not synthetic testing.

---

## Confirmed this session, source-verified

### 1. `git_commit_and_push()` collapses commit-failure and push-failure into one ambiguous message
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

Eight source-confirmed pack-code defects (items 1–8), one confirmed design gap that cost real diagnostic time across three rounds (item 9), one dormant/unwired feature worth surfacing rather than leaving silent (item 10), and two protocol-level lessons worth folding into onboarding guidance. None of these are OIKONOMOS-specific — all are properties of the DEVDEPARTMENT scripts and templates as shipped, reproducible on any project using multi-builder dispatch with worktrees on Windows/PowerShell.
