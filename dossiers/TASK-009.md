# TASK-009 — Workspace dependency integration (E3 manifests + lockfile)

**Brief:** Single-owner integration task for `pnpm-lock.yaml`, the one file every E3 implementation task would otherwise contend for. Adds all workspace dependencies the wave needs in one pass so the implementation tasks own only `src/**` and `test/**`. No implementation code.

**Spec pointers:** Build Handover §3 (package boundaries — which package may depend on which). WBS §5 E3. The lockfile-contention reasoning is in the task Description; the protocol basis is COORDINATION_PROTOCOL §4 ("shared/cross-cutting files get dedicated integration tasks owned by exactly one unit").

**Intended approach:** Add `workspace:*` deps — approvals → shared + db; audit → shared + db; broker → shared + policy + approvals + audit. Run `pnpm install`, commit the lockfile, verify `-r typecheck/build/test` and `lint` all still exit 0. Resist adding anything external: the broker is a library here, not an HTTP server (Fastify is OIK-084/E9).

## Work Log

- [2026-08-15T10:00:00Z] [CX] Preflight completed before implementation:
  ```text
  [preflight] TASK-009 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-codex-oikonomos
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   packages/approvals/package.json  -> exists, 28 line(s), 560 bytes
    FILE   packages/audit/package.json  -> exists, 28 line(s), 556 bytes
    FILE   packages/broker/package.json  -> exists, 28 line(s), 557 bytes
    FILE   pnpm-lock.yaml  -> exists, 2357 line(s), 76001 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
  Created `task/TASK-009-cx` from the dispatcher-provided integration commit. Confirmed package boundaries in Build Handover §3; adding only the required `workspace:*` dependencies and regenerating the lockfile.

- [2026-08-15T10:05:00Z] [CX] Completed dependency wiring and validation. `pnpm install --frozen-lockfile`, recursive typecheck, build, test, and root lint all exit 0. The recursive test suite reports all active tests passing; the existing database integration suite cleanly skips its two tests because no `DATABASE_URL` is configured. Pending final post-commit diff-boundary verification against `master`.

- [2026-08-15T10:06:00Z] [CX] Handoff complete on commit `3a3ec2d` (`chore(deps): wire E3 workspace package dependencies [TASK-009]`). `git diff --stat master...HEAD` contains only `packages/approvals/package.json`, `packages/audit/package.json`, `packages/broker/package.json`, `pnpm-lock.yaml`, and this dossier. Working tree is clean.
