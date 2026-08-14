# ADR-002 — Scope of the permission-bypass ban: product runtime vs. development tooling

**Status:** ACCEPTED (Amendment A, 2026-08-14 — see below) · **Date:** 2026-08-14 · **Amends:** ADR-001 L4 / CAN-03; CLAUDE.md non-negotiable #2
**Decision owner:** Alister Witbooi · **Trigger:** DEVDEPARTMENT v4.5 onboarding (2026-08-14)

---

## Context

ADR-001 L4 bans `bypassPermissions` and `acceptEdits` platform-wide, and CAN-03 makes CI grep the repo for those strings. The ban exists to protect **P1** — every tool invocation by an OIKONOMOS *product* agent is intercepted by the capability broker.

The DEVDEPARTMENT multi-agent development tooling, onboarded 2026-08-14, ships a headless review invocation that uses the CLI equivalent of the banned mode:

- `autopilot.json` → `review_cmd`: `claude -p "…" --model claude-opus-4-8 --dangerously-skip-permissions`
- CLAUDE.md, appended section "ORCH model discipline": documents the same invocation form.

Without this flag the unattended reviewer hangs on its first permission prompt, so the autopilot's review path cannot run. A literal CAN-03 implementation (or a broadened one that also matches `--dangerously-skip-permissions`, which a faithful implementation should) fails the build on these files — and, taken literally, on ADR-001 and CLAUDE.md themselves, which contain the banned strings as prohibitions.

Two governing documents therefore disagree; per document precedence this requires an ADR.

## Decision

**The ban is scoped to the OIKONOMOS product runtime. The DEVDEPARTMENT development-tooling layer receives a narrow, enumerated carve-out.**

1. **Product runtime (ban applies, unchanged):** any harness invocation constructed by `packages/harness-factory`, any settings file or subagent definition shipped or loaded by the OIKONOMOS platform, anything under `packages/**`, `apps/**`, `services/**`, `infra/**`, `evals/**`. Zero occurrences of `bypassPermissions`, `acceptEdits`, or `--dangerously-skip-permissions` in these paths. No exceptions without a further ADR amendment.
2. **Development tooling (carve-out):** `--dangerously-skip-permissions` is permitted **only** in headless ORCH orchestration invocations of the DEVDEPARTMENT layer, i.e. in these files exactly:
   - `autopilot.json` (`review_cmd` and future orchestration commands)
   - `CLAUDE.md` DEVDEPARTMENT appendix, `AGENTS.md`, `docs/**`, `.claude/commands/**`, `briefings/**` (documentation of the same)
   - `scripts/**` (dispatch/supervisor code that constructs those invocations)
3. **Compensating control:** the carve-out is acceptable because dev-repo sessions are themselves governed by `PreToolUse` hooks (`hooks/territory-firewall.js`, `hooks/secret-scan.js`, wired in `.claude/settings.json`) — and per the SDK pipeline verified in ADR-001, **a PreToolUse deny holds even under a permission-bypass mode**. The dev tooling thus relies on the same enforcement point the product does.
4. **CAN-03 implementation rule:** the CI grep matches `bypassPermissions`, `acceptEdits`, and `--dangerously-skip-permissions` across the repo, with an explicit allowlist for the paths in (2) plus `docs/decisions/**` (prohibition text is not a violation). The allowlist lives in the CI config next to the grep and cites this ADR. Any new occurrence outside the allowlist fails the build.
5. **Builder sessions are not covered by the carve-out:** DEVDEPARTMENT *builder* dispatches (GB/CX/S5) must not run with permission bypass in any invocation that touches product paths, except where the territory firewall is active for that unit (`DEVTEAM_UNIT` set), which mechanically confines writes to the task's `Owned_Paths`.

## Consequences

- **Positive:** CAN-03 becomes implementable without failing on the repo's own governance text; the autopilot review path stays functional; the product-side ban is now *more* precise (it names the flag form too, which ADR-001 did not).
- **Cost:** the CI allowlist is a new protected artifact (`infra/ci/**` is already a protected path); reviewers must check that carve-out growth is rejected.
- **Risk retained:** an ORCH orchestration session with bypass enabled has wide dev-repo write access. Mitigated by hooks (3), by the DEVDEPARTMENT protected-path list, and by the fact that these sessions never hold product credentials (non-negotiable #4).

## Amendment A — prose surfaces vs. enforcement surfaces (2026-08-14, ACCEPTED)

**Raised by:** GB during OIK-004 implementation (TASK-004), as a `SPEC_AMBIGUITY` block. A correct block — §4 as originally written is not implementable.

**The gap.** §4 carved out `docs/decisions/**` on the principle that *prohibition text is not a violation*, but stopped there. In practice the banned tokens propagate into every surface that quotes the rules: `PLAN.md` (task descriptions), `specs/**` (the build directive restates the non-negotiables), `dossiers/**` (builder briefs), and root-level handover prose. A faithful closed allowlist therefore fails on the repo's own governance text, while widening it ad hoc violates the "current repo passes" criterion. The principle was right; its scope was too narrow.

**Decision.** Deny-by-default is retained. The allowlist is restated in terms of what a token can actually *do* in a given file:

- **Enforcement surfaces — scanned, no exceptions.** Anything executable or configuration-bearing: `packages/**`, `apps/**`, `services/**`, `infra/**`, `evals/**`, `.github/**`, `.claude/settings*.json`, `.claude/agents/**`, and any other settings or subagent definition. A token here is a live permission grant, which is precisely what N2 exists to prevent.
- **Prose surfaces — carved out, because a token here is a quotation.** `docs/**` (including `docs/decisions/**`), `specs/**`, `dossiers/**`, `briefings/**`, `.claude/commands/**`, `PLAN.md`, `REVIEW.md`, `AUTOPILOT_LOG.md`, `INSTINCTS.md`, and root-level `*.md`. These files are read by humans and agents as instructions; none is loaded as configuration by any runtime.
- **Dev-tooling configuration — carved out per §2(2), unchanged.** `autopilot.json`, `scripts/**`.

The carve-outs are glob-shaped rather than file-enumerated on purpose: dossiers and specs are created continuously, and an allowlist that needs editing every time a builder writes a brief would be abandoned within a week.

**Secret scanning (OIK-007), same amendment.** `hooks/run-tests.js` is exempted from the secret scan. It contains deliberately realistic-looking key fixtures that are the DEVDEPARTMENT pack's own test corpus for `hooks/secret-scan.js`; rewriting them to placeholders would break the pack's ability to test its own detector, and the file ships from upstream. The exemption is one named file, not a glob — any *other* file tripping the scanner is a real finding.

**Residual risk, stated plainly.** A prose surface could carry a token that a future tool one day reads as configuration (e.g. if `PLAN.md` ever became machine-executable). Accepted as low: the platform runtime reads none of these paths, and any change that made it do so would itself be a protected-path change requiring review.

## References

- ADR-001 — Broker enforcement point (L4, CAN-03; PreToolUse-deny-holds-under-bypass finding)
- `docs/MODEL_DISCIPLINE.md`, `docs/AUTOPILOT.md` — why the reviewer runs headless
- CLAUDE.md — non-negotiable #2 (product scope confirmed by this ADR)
