# TASK-004 — OIK-002/004/007 CI skeleton + banned-mode grep + secret scan ⚑ protected

**Brief:** The CI pipeline skeleton, the N2 banned-mode grep implemented per ADR-002 §4, and secret scanning. Protected path (infra/ci): author GB, reviewer ORCH on opus-4-8 — different-model rule holds. Repo has no remote yet, so local runnability of every job is the demonstrable acceptance.

**Spec pointers:** WBS OIK-002/004/007. ADR-002 §4 (grep patterns: bypassPermissions, acceptEdits, --dangerously-skip-permissions; allowlist = ADR-002 §2 paths + docs/decisions/**, cited beside the grep). ADR-001 CAN-03 (what this job will grow into). N4 (fixture keys must be obviously fake — the DEVDEPARTMENT secret-scan hook mechanically blocks realistic-looking ones).

**Intended approach:** .github/workflows/ci.yml with lint/typecheck/test/build jobs calling pnpm scripts; infra/ci/banned-modes.(sh|mjs) + infra/ci/banned-modes-allowlist.txt citing ADR-002; self-test fixture proving catch + current-repo pass. Secret scan: gitleaks (or script) in CI + pre-commit hook config; planted fixture uses PLACEHOLDER-structured fake.

## Work Log
