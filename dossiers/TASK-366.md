# TASK-366 dossier

**Brief:** Browser lane and human takeover end-to-end scenario tests (verifies G-06 and G-07).

Write deterministic scenarios with a FIXTURE Steel MCP server (the worker tests already have fixture HTTP MCP servers; reuse the pattern): (a) a granted bot navigates to an allowed page, snapshots it, and acts on an element ref (TASK-340); (b) navigation to a private-network, loopback, metadata or credentialed URL is refused by the navigation guard before any Steel call and audited with a category; (c) a page that presents a CAPTCHA or MFA challenge PARKS the run with a takeover request and never attempts to solve or bypass it; (d) after a simulated human takeover completes, the run resumes from the parked state and finishes; (e) an ungranted bot cannot mount the browser tools. G-08 (Docker egress allowlist) needs a real container, so it is out of scope: say so in the dossier. Same rule as TASK-365 for defects: keep a failing assertion as `it.fails`, record the evidence, and block with the source file named.

**Assigned:** CX9. **Depends on:** —.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_REMAINING_WORK_2026-09-16.md ("Not covered by this pass": G-06 browser lane and G-07 human takeover are wired but unverified); TASK-336 (navigation guard); TASK-225 (Steel takeover parking); CLAUDE.md non-negotiable 6 (challenges trigger human takeover, never circumvention)

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master (`git branch --show-current` should be task/TASK-366-cx9). Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Every review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`).

## Work Log
