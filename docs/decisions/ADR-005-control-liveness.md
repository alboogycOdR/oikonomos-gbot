# ADR-005 — Every mechanical control must assert its own liveness

**Status:** ACCEPTED · **Date:** 2026-08-15 · **Decision owner:** Alister Witbooi
**Relates to:** ADR-001 (broker enforcement), ADR-002 Amendment B (territory hook), CLAUDE.md non-negotiables

---

## Context

Seven controls in this repository were found, in a single day, to be **configured but inert**. Each
was discovered separately, and only after the fact:

| # | Control | State found | Discovered by |
|---|---|---|---|
| 1 | `packages/policy` 100%-branch coverage threshold | correct, fail-closed when invoked — invoked by nothing | TASK-007 review |
| 2 | Protected-path review gate | correct, but PR-only in a repo with no remote | TASK-018 review |
| 3 | Territory firewall (ADR-002 §5) | `DEVTEAM_UNIT` set for every builder; grok and codex never read it | dispatch gate, after 5 merged tasks |
| 4 | `autopilot.json` builder `model` pin | field present and resolved; the grok branch never passed it | a question from Alister |
| 5 | `devteam-control` drain | extraction ran every wave; drain never did, for three consecutive waves | status scan |
| 6 | `action_render` ↔ payload binding | digest binds the payload; nothing binds the render | external evidence (a third-party system) |
| 7 | ATLAS project-map index | packed into every builder prompt; last actual scan 6 hours and 8 merges earlier | a question from Alister |

**The shared property is not "bug". It is that a working control and an inert one present identical
symptoms.** In every case the configuration was present, the command exited 0, and the output looked
plausible. ATLAS is the sharpest illustration: `pack` opens the database on every dispatch, which
updates its mtime, so the index appeared freshly written at the exact second of the dispatch while
its *contents* aged silently for six hours. It passed every casual inspection precisely because it
was doing *something*.

Three of the seven were caught by luck rather than by any mechanism — two from direct questions, one
because an unrelated system volunteered how its own equivalent worked. That is not detection.

**Why existing checks do not cover this.** Tests, lint, `banned-modes`, `secret-scan` and CI jobs all
verify *configuration and behaviour when invoked*. None verifies *invocation*. A threshold nothing
evaluates, a hook no CLI loads, a scan nothing runs, and a queue nothing drains are all invisible to
a green suite — and, worse, a green suite is affirmative evidence that everything is fine.

## Decision

**Every mechanical control ships a liveness assertion: a check that fails when the control is inert,
distinct from the check that it behaves correctly when it runs.**

1. **Liveness is separate from correctness.** "The gate rejects a bad diff" and "the gate ran on this
   commit" are two different assertions and both are required. A control with only the first is
   unfinished.

2. **The assertion must be able to fail.** It must key on evidence the control emits *by doing its
   job* — a recorded scan timestamp, a drained queue, a coverage report, a rejected commit — never on
   the presence of configuration, a file's mtime, or an exit code from a command that may have
   no-opped. Where a control cannot emit such evidence, that is itself the finding.

3. **Liveness checks run where inertness would otherwise persist**, i.e. in `infra/ci/run-local.mjs`
   (the operative CI surrogate while the repo has no remote), not solely in a job that requires a
   pull request.

4. **New controls are not complete without one.** Any task introducing a mechanical control carries
   an acceptance criterion for its liveness assertion. Reviewers reject on its absence, on the same
   footing as a missing test.

5. **Staleness must be loud.** Where a control depends on derived state (an index, a cache, a
   generated artifact), the consumer states that state's age against a reference the reader can judge
   — commits behind, files missing — not a bare timestamp the reader must date-arithmetic themselves.

## Consequences

- **Positive.** The failure mode that produced all seven instances — silent inertness behind
  plausible output — becomes detectable by the same command developers already run.
- **Positive.** It converts "the tool is wired in" from an assertion into a measurement. Instance 7
  had been wired in, running, and producing output for six hours while being wrong.
- **Cost.** Every control gains a second assertion to write and maintain, and liveness checks are
  themselves controls — they can rot the same way. Mitigated by keeping them in one place
  (`run-local.mjs`) where their own absence is conspicuous, and by requiring each to be able to fail.
- **Residual risk, stated plainly.** This does not make a liveness check *correct*, only present. A
  liveness assertion that keys on the wrong evidence — an mtime rather than a recorded scan — would
  reproduce exactly the ATLAS failure one layer up. §2 exists to name that trap, but naming it is not
  preventing it.
- **Not retrospective.** Instances 1–6 are already fixed individually. This ADR governs what happens
  next; it does not re-audit prior work, and a sweep of already-merged controls for missing liveness
  assertions is separate, unscheduled work.

## References

- ADR-002 Amendment B — the §5 exception whose premise was false for two of three units (instance 3)
- TASK-007, TASK-018 review findings — "a gate nothing runs is not a gate" (instances 1, 2)
- TASK-021 — implements the liveness gate for the controls existing at the time of this decision
