# ADR-009 — Cloud-portable orchestration: OS-agnostic dispatch + fresh-clone session model

**Status:** Proposed
**Date:** 2026-08-27
**Author:** ORCH
**Decision owner:** Alister Witbooi
**Related:** `docs/COORDINATION_PROTOCOL.md` §4 (Layer 2 — worktrees + task branches), §10a (resume-first rule); `AGENTS.md` commandment 5; `scripts/dispatch.ps1`/`dispatch.sh`; `scripts/worktree.ps1`; `scripts/control.py`; `scripts/supervisor.py`; ADR-005 (control liveness — same discipline applied here to state durability)
**Supersedes:** nothing yet. Proposes amendments to `COORDINATION_PROTOCOL.md` §4/§10a and `AGENTS.md` commandment 5, to be made only once the mechanism they'd describe actually exists (see §5 Rollout).

---

## 1. Why this needs deciding, not just patching

The motivating question was simple: can OIKONOMOS's DEVDEPARTMENT orchestration run on Claude Code's cloud sessions instead of this one Windows machine? The answer today is no, for reasons that turn out to run deeper than "install PowerShell on Linux." Confirmed against Claude Code's actual cloud-session model: Anthropic-managed cloud sessions run Ubuntu 24.04 with no PowerShell, no persistent state across sessions (every session clones a fresh repo), and no long-lived background process surviving past a session's stopping point.

That third property is the one that matters. This project's coordination protocol is written, in prose, around the opposite assumption. A direct audit of `docs/COORDINATION_PROTOCOL.md` §4 ("Layer 2 — Git worktrees + task branches (physical)") and §10a (the resume-first rule: *"A re-dispatched builder that skips its own `in_progress` task creates a ghost task"*) confirms the persistent-worktree assumption is baked into the protocol text itself, not merely into `dispatch.ps1`'s implementation. `AGENTS.md` commandment 5 repeats it. Per this project's own rule — *"ADR for every decision that conflicts with an existing document"* — a decision that rewrites those two documents' operating assumption belongs here, decided once, in writing, before anyone builds against it.

## 2. Current-state audit (2026-08-27, grounded in a direct file-by-file investigation)

### 2.1 Already portable — no work needed

Every Python script in `scripts/` (`builder_registry.py`, `atlas*.py`, `instincts.py`, `validate_plan.py`, `control.py`, `supervisor.py`, `maintenance.py`, `plan_guard.py`, `budget.py`, `distiller.py`, `retro.py`, `scheduling.py`, `team_stats.py`, `usage_probe.py`, `notify.py`, `board_publisher.py`, `preflight_paths.py`, `tg_commands.py`, `tg_listener.py`) carries no OS branching except two *correct, deliberate* `os.name == "nt"` checks in `supervisor.py` and `maintenance.py` that pick the right per-OS script to invoke — exactly the pattern the rest of this ADR wants everywhere. `atlas_core.py` even normalizes `\\`→`/` explicitly for cross-platform glob matching. `hooks/*.js` are Node-stdlib-only by explicit design (`lib.js`'s own docstring: *"Zero dependencies for maximum portability"*), and the territory firewall's env-var contract (`DEVTEAM_UNIT`) is identical on both platforms. `plan_commit.ps1`/`.sh` and `harness-audit.ps1`/`.sh` are genuinely 1:1 — no drift found in either pair.

### 2.2 Windows-only, no counterpart at all

- **`scripts/worktree.ps1`** — no `.sh` twin, and it's already stale independent of any cloud question: it hardcodes `grok`/`codex` (predates the v4.7 unit registry), has no idea S5/S5B exist, and doesn't call `builder_registry.py` the way both dispatch scripts already do. `devteam-dispatch.md` still points to it as step 1.
- **`scripts/install_git_hooks.ps1`** — no `.sh` twin. The hook body it generates is already portable POSIX `sh`; only the installer that writes it is Windows-only. Its own test fixtures reference the `.ps1` directly, so even the test coverage is Windows-bound.

### 2.3 Drifted pairs — `dispatch.ps1` vs `dispatch.sh`

This is the load-bearing finding. **The two scripts are not 1:1**, despite `dispatch.ps1`'s own docstring claiming they are, and the gap is exactly the property that matters most for reliability:

- **The detached-launch fix built this session exists only in `dispatch.ps1`.** Its strict-mode branch now generates a runner script and launches it via `Start-Process`, fully outside `dispatch.ps1`'s own process tree, so a killed dispatcher can never take a live builder session down with it — the root cause of three consecutive TASK-058 dispatch failures on 2026-08-26/27. `dispatch.sh`'s strict mode (lines 358-366) still runs the builder **blocking**, piped through `tee`, inside its own process. Its docstring defends this by an *assumption* about the calling environment ("bash is invoked from a real terminal or the autopilot, neither of which reaps children mid-run") rather than a structural guarantee — which is precisely the class of reasoning that failed on Windows before the fix.
- Legacy mode has the same asymmetry: `dispatch.ps1` detaches by default (`-InProcess` opts back into blocking); `dispatch.sh` legacy mode is unconditionally blocking, with no detached option at all.
- Several `.ps1`-only sections exist for good reason (a `codex` npm-shim quirk requiring a `cmd /c` wrapper, a PowerShell 5.1 argv-quoting defect, UTF-16LE→UTF-8 log re-encoding) — these are correctly Windows-only fixes for Windows-only problems, not something to port. They're listed here only so a future reader doesn't mistake dispatch.sh's shorter length for equivalence.

### 2.4 Where in-flight state is stranded outside git — the actual crux

`.devteam/` is entirely gitignored, by explicit design (dispatch logs can carry raw prompts). Confirmed via `git ls-files .devteam` — nothing under it is ever tracked. Several things that matter for *resuming* live work exist only there:

| Local-only artifact | What's stranded | Consequence for a fresh clone |
|---|---|---|
| `.devteam/control/*.json` | A builder's just-emitted result, live only between session-end and the next supervisor drain tick | Result vanishes if the machine is lost between those two moments |
| `.devteam/inflight/<unit>.json` | Claim mapping the territory firewall consults | Firewall loses its authorization basis |
| `.devteam/runs/*.log` | Full session transcripts — the only record when no CONTROL block is found | Silent loss of the sole audit trail for an unreported session |
| `.autopilot_state.json` | The supervisor's own loop memory — `stale_resets` ceiling counters, `rework_counts` | **Resets to zero on a fresh clone**, so the autopilot could redispatch a task past its intended retry ceiling without knowing it already tried |
| `.devteam/atlas.db` | 12.9 MB SQLite project-map index | Rebuildable, but not free — multi-minute cold rebuild |

**Demonstrated live, not hypothetical.** At the time of this audit, `git worktree list -v` showed two of four registered worktrees (`wt-grok-oikonomos`, `wt-review-oikonomos`) physically absent from disk, while `PLAN.md`/`CHECKPOINT.md` still referenced one of them as live (`TASK-054`, `Status: blocked`, `Branch: task/TASK-054-gb`). The branch ref itself survived in the main repo — committed work is intact — but nothing in the current protocol detects a worktree directory vanishing, and any uncommitted edit that existed there at the moment of disappearance is gone with zero trace.

**No script pushes `master` to `origin` as a guaranteed step.** `plan_commit.*` deliberately never pushes. The actual `git merge --no-ff` of a reviewed task branch onto `master` has no scripted push step anywhere in the repo — it happens because an ORCH session has, so far, always remembered to. Confirmed live: 13 local task branches exist; only `master` exists on `origin`. Twelve of thirteen are harmless (their content already reached `origin` via the merge, even though the branch ref itself didn't) — but the one non-`done` branch is real unmerged work that a fresh clone of `origin` alone would simply never see.

### 2.5 What does not need to change

`PLAN.md` as the coordination blackboard, `dossiers/TASK-NNN.md` as per-task work logs, the `c8b9872` preflight-check convention, and the territory firewall (already portable, already correct) all already satisfy "recoverable from git alone." The claim/resume state machine's *logic* (`pending → claimed → in_progress → needs_review → done`) doesn't need to change — only its evidence source does: today it partly trusts "does this worktree still exist," which a fresh clone can never answer.

## 3. Decision

Two independent axes. **A** can ship alone and is useful even without cloud ambitions (it fixes an acknowledged live bug). **B** requires A as a prerequisite and is the actual protocol-level rearchitecture — the "biggest lift" the callout named.

### 3.1 Axis A — OS-agnostic dispatch

1. Port the detached-launch mechanism to `dispatch.sh`: a generated runner script, backgrounded (`setsid`/`nohup … & disown`, or an equivalent that survives the parent shell exiting), writing the identical `.devteam/runs/<task>-<ts>.{prompt.txt,run.sh,log,done}` shape so `control.py`'s extraction step is oblivious to which OS produced it. This alone closes the acknowledged kill-safety gap and is worth doing regardless of anything else in this ADR.
2. Resolve `worktree.ps1`: either port it onto the `builder_registry.py`-driven model both dispatch scripts already use, or retire it and repoint `devteam-dispatch.md` at dispatch's own inline worktree-creation logic, which already supersedes it in practice.
3. Port `install_git_hooks.ps1` to a POSIX installer for the (already-portable) hook body it writes.
4. Add a liveness check (per ADR-005's own discipline) asserting `dispatch.sh` and `dispatch.ps1` stay behaviorally equivalent on the one property that matters most — detachment in strict mode — so this can't silently re-drift the way it already has once.

### 3.2 Axis B — fresh-clone-per-session state model

The governing rule: **nothing the next session needs may live only on this machine's local disk.**

1. **Push discipline becomes mechanical, not habitual.** The merge-to-`master` step must itself push, every time — either as a hard step in the review procedure, or enforced by a liveness check that fails when `master` and `origin/master` diverge past some small threshold.
2. **The CONTROL-block relay queue must not survive only in `.devteam/control/`.** Either collapse extraction and PLAN.md application into one atomic step (no window where a result exists only as an untracked file), or make a session-boundary flush mandatory before a session is allowed to end, verified the same way.
3. **`.autopilot_state.json`'s ceiling counters need a durable home** — committed to git in redacted form (counters aren't secret-shaped the way raw prompts are), or folded into `PLAN.md`'s own frontmatter, since `PLAN.md` is already the trusted durable blackboard.
4. **Worktree disappearance must be detected, not silently tolerated.** `dispatch.*`'s existing "refresh a reused worktree" guard should check the directory actually exists before trusting `PLAN.md`'s `Branch` field, and raise a loud finding when it doesn't — a real gap today, independent of cloud work, that this audit just demonstrated live.
5. **Protocol-text amendments, once the mechanism above exists to describe:**
   - `COORDINATION_PROTOCOL.md` §4 gets a fresh-clone-per-session alternative spelled out: a resumed session re-clones `origin`, re-creates its worktree from the task branch ref (which survives on the remote once B.1 is real), and reconstructs its position from `PLAN.md` + `dossiers/TASK-NNN.md` — never from anything under `.devteam/`.
   - §10a's resume-first rule gets restated around *"does the task branch exist on origin"*, not *"does the worktree still exist on this machine"* — only the former survives a fresh clone.
   - `AGENTS.md` commandment 5 gets the same restatement.
6. **State a cold-start policy for ATLAS in a cloud session** — either accept the rebuild as a one-time-per-environment cost (mitigated by cloud environments' own setup-script filesystem caching, which does persist across sessions on the same environment), or keep ATLAS explicitly best-effort/skippable in a fresh-clone context, which its existing fail-open design already leans toward — confirm that stays true rather than newly depending on it.

## 4. Consequences

- **Positive.** Unlocks Claude Code cloud sessions as a real dispatch target — no self-hosted Windows runner image needed, since the whole point of axis B is tolerating exactly the fresh-clone/no-persistent-state model cloud sessions impose.
- **Positive.** Closes a real, already-demonstrated bug (silent worktree disappearance) whether or not cloud dispatch ever ships.
- **Positive.** Forces an explicit answer, per piece of orchestration state, to "is this recorded in git or not" — the same discipline ADR-005 applies to control liveness, applied here to state durability.
- **Cost.** Real work across roughly six files and two protocol documents. Not a quick patch; the callout's "biggest lift" framing holds.
- **Cost.** Fresh-clone-per-session pays a real, repeated cost — clone, dependency install, possible ATLAS rebuild — that a persistent worktree currently avoids entirely. Worth measuring against actual cloud-session latency before committing to axis B in full.
- **Risk.** Axis B's protocol-text changes touch documents every active builder session currently depends on. Sequencing matters — see §5.
- **Not retrospective.** Existing local worktrees, in-flight tasks, and the Windows-only detached-launch fix already shipped this session are not being redone. This ADR governs what changes from here.

## 5. Rollout sequencing (recommendation, not binding on its own)

1. **Axis A in full first.** Lower risk, immediately useful on any self-hosted Linux runner even without touching protocol text, and closes `dispatch.sh`'s kill-safety gap regardless of cloud ambitions.
2. **B.1 (push discipline) and B.4 (worktree-disappearance detection) next.** Net-positive local-machine bug fixes, no protocol-text changes required, cheap relative to the rest.
3. **B.2 and B.3 (state relocation) as one coordinated task** — they touch the same `control.py`/`supervisor.py` code paths and should land together.
4. **B.5 (protocol-text amendments) last**, once the mechanism they describe actually exists and works — never write the ADR consequence into `COORDINATION_PROTOCOL.md`/`AGENTS.md` ahead of the code that makes it true.
5. **A real cloud-session dispatch trial** — one builder, one task, an Anthropic-managed environment — as the acceptance test for this whole ADR, not a design review or a read-through.

## References

- CLAUDE.md, "ADR for every decision that conflicts with an existing document"
- `docs/COORDINATION_PROTOCOL.md` §4, §10a
- `AGENTS.md` commandment 5
- `scripts/dispatch.ps1` (DETACHED-LAUNCH RULE comment, 2026-08-27), `scripts/dispatch.sh`
- ADR-005 — control liveness; same discipline applied here to state durability
- Portability/persistent-worktree audit, 2026-08-27 (this session's direct investigation; findings cited throughout §2)
