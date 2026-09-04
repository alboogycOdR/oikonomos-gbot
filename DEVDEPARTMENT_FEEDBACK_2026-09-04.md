# DEVDEPARTMENT Pack — Feedback from a Week of Live Use (Oikonomos)

**Date:** 2026-09-04 · **Source project:** oikonomos (this repo) · **Pack repo:** `E:/DELL-PROJECTS/DEVDEPARTMENT` (self-hosted, its own PLAN.md/REVIEW.md)

Everything below is grounded in something that actually happened this week running Oikonomos on the pack — not speculation. Where a fix already exists in Oikonomos, the reference implementation is named so it can be ported rather than rebuilt from this description.

---

## High confidence — concrete code fixes, already proven working

### 1. `auth.mode: "config_dir"` was hardcoded to Claude, despite the registry being designed to be CLI-agnostic

**What happened:** `docs/BUILDER_REGISTRY.md`'s entry schema documents `cli` as the field that "picks the CLI-quirk row in dispatch," and the pack already ships S5B (a second Claude login) using `auth.mode: "config_dir"` with `CLAUDE_CONFIG_DIR`. But `scripts/dispatch.ps1`'s actual implementation of `config_dir` mode never generalized past that one CLI — the env var name was a literal string, not derived from the unit's `cli` field, at all 5 call sites that touch it. The moment a second Codex login (CX9) was needed this week, every one of those 5 sites was wrong.

**Fix (already live in Oikonomos, `scripts/dispatch.ps1`):** a per-CLI lookup table —
```powershell
$AuthEnvVarByCli = @{ "claude" = "CLAUDE_CONFIG_DIR"; "codex" = "CODEX_HOME" }
```
— resolved once, used consistently at all 5 sites (the initial resolve/log line, the two `$RunnerLines` injections, and the direct-launch save/set/restore block, which needed `Set-Item -Path "Env:$AuthEnvVar"` / `[Environment]::GetEnvironmentVariable($AuthEnvVar)` instead of the old `$env:CLAUDE_CONFIG_DIR` literal syntax, since PowerShell doesn't support a variable in that position). An unrecognized CLI family requesting `config_dir` mode now fails closed with a clear error instead of silently reusing the Claude var.

**Recommendation:** port this into the pack's own `scripts/dispatch.ps1`/`.sh`, and add the matching "Activating a second login" doc section pattern (Oikonomos's `docs/BUILDER_REGISTRY.md` now has one for CX9, mirroring the existing S5B one almost exactly — could become a generic template: "Activating a second login for CLI family X" instead of two hand-written copies).

### 2. A worktree left on a stale, already-merged branch can silently confuse the next dispatch

**What happened, twice this week:** `scripts/dispatch.ps1`'s worktree-refresh logic is deliberately conservative — it only auto-refreshes a worktree that is **detached**, never one sitting on a real branch, specifically to avoid destroying in-flight work (this is correct and shouldn't change). But when ORCH merges a task's branch from the *main* worktree, the *builder's own* worktree is never told — it stays checked out on that now-merged branch until its *next* dispatch, at which point the refresh logic (correctly) leaves it alone because it's "on a branch," not detached.

The practical failure mode: a builder dispatched for a **new, different** task, in a worktree still sitting on its **previous, already-merged** task's branch, can end up re-examining/re-verifying the old task instead of following the new prompt's explicit instruction to create a new branch. This happened live with a Claude-family builder (S5) this week — its dispatch prompt unambiguously said "Your task is TASK-129 ... create branch task/TASK-129-s5," but the session instead re-verified old, already-merged TASK-127 work on the stale branch, and its emitted control block even named the wrong task ID. The prompt was fine; the environment handed the builder a stale starting point and it didn't correct for it.

**Fix applied ad hoc this week (not yet in the pack):** ORCH manually detached the worktree to base-branch tip before redispatching (`git checkout --detach master --quiet` in the worktree), and the very next dispatch's refresh logic then worked as designed ("Refreshed worktree to master tip").

**Recommendation:** close the window automatically — when ORCH merges a task's branch (`git merge --no-ff task/TASK-NNN-xx`), have the merge helper (or a small wrapper around it) immediately detach *that builder's* worktree to the base branch tip, rather than waiting for the next dispatch's conditional refresh. This removes an entire class of stale-context confusion, and it's a small, mechanical change (one `git -C <worktree> checkout --detach <base>` call right after a successful merge).

---

## Medium confidence — real, repeated patterns, worth generalizing

### 3. Barrel-file / `package.json` / lockfile Owned_Paths gaps recur predictably

Hit this legitimately **four times** in one week (each a real, correctly-self-diagnosed `OWNERSHIP_CONFLICT`, never a builder mistake): a task needs to export something new through an existing package's barrel `index.ts`, or add a new npm dependency, and that file wasn't pre-granted in `Owned_Paths` because the decompose pass didn't anticipate it. Each one cost a full blocked → ORCH-triage → resume round trip.

**Recommendation:** add an explicit decompose-time checklist item to `/devteam-decompose` (or wherever task authoring guidance lives in the pack): *"Does this task add a new export from an existing package's barrel file? Does it add a new npm dependency? If either is yes, pre-grant that barrel file / `package.json` / the lockfile in `Owned_Paths` up front."* This is a cheap question to ask at decompose time that would have prevented all four occurrences.

### 4. Same-model reviewer/builder collision isn't fully specified for a second login of ORCH's own model

`docs/BUILDER_REGISTRY.md`'s S5B section documents *how* to set up a second login of ORCH's own CLI family (Claude), but doesn't explicitly say *whether* that second unit is a valid author for protected-path work when ORCH is also that model. Working this out live this week: a second unit on a **different** model family from ORCH (e.g. a second Codex login, when ORCH is Claude) is a valid protected-path author — different model, satisfies the adversarial-review requirement by construction. A second unit on **ORCH's own** model family (S5B, when ORCH is also Claude Sonnet 5) is **not** — the reviewer and one possible author would share every blind spot.

**Recommendation:** state this explicitly as a named rule in `docs/MODEL_DISCIPLINE.md` (or wherever the reviewer-parity rule already lives): *"A second-login unit is a valid protected-path author only if its CLI/model family differs from ORCH's own — never assume validity just because it's a distinct unit ID."*

---

## Already known — local CLAUDE.md amendments worth pushing into the pack itself

Both of these are already hand-amended into Oikonomos's own CLAUDE.md (in the project-specific "DEVDEPARTMENT amendments" section, specifically because the pack's machine-managed section gets overwritten on sync and can't hold project-durable fixes). Since both are pack-level defects rather than project-specific quirks, pushing them into the pack means every project gets them by default instead of every project having to rediscover and hand-amend them separately.

5. **Review standard should default to the full recursive test suite (`pnpm -r test`), not the task's own package.** Discovered when a filtered review missed a real cross-package regression that survived two separate review passes before being caught. `/devteam-review`'s own step 3 should say "always full suite" rather than leaving package scope to the reviewer's judgment.

6. **Two different "Protected paths" concepts exist and both bind, but nothing in the pack's own generated section makes that explicit.** A project's own CLAUDE.md protected-paths list (requiring adversarial review) and the pack-generated section's builder territory firewall (paths builders may never touch at all) are genuinely different lists serving different purposes, but the shared name "protected paths" invites a project author to assume one supersedes the other. Recommend renaming the pack's own concept to something unambiguous (e.g. "builder territory firewall," already used informally) so the two never collide on terminology again.

---

## Minor — onboarding friction, not a bug

7. PowerShell's console mangles multi-line pasted command blocks that end a line with a pipe (`|`) — a paste can silently split at the pipe and misfire the next line as a new command. Any pack onboarding doc that asks a user to paste multi-line PowerShell (the S5B/CX9 login steps are the current example) should say "run one line at a time" and avoid trailing-pipe line breaks where a `-Path`/`-Value` flag form works just as well.

---

## How to use this

Items 1–2 have working reference implementations in this repo right now (`scripts/dispatch.ps1`, `docs/BUILDER_REGISTRY.md`'s CX9 section) — porting them is close to copy-paste. Items 3–4 are guidance/doc additions, no code. Items 5–6 are already-written CLAUDE.md prose in this repo that could move into the pack's own template almost verbatim. Item 7 is a one-line doc caveat.
