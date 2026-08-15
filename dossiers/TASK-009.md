# TASK-009 — Workspace dependency integration (E3 manifests + lockfile)

**Brief:** Single-owner integration task for `pnpm-lock.yaml`, the one file every E3 implementation task would otherwise contend for. Adds all workspace dependencies the wave needs in one pass so the implementation tasks own only `src/**` and `test/**`. No implementation code.

**Spec pointers:** Build Handover §3 (package boundaries — which package may depend on which). WBS §5 E3. The lockfile-contention reasoning is in the task Description; the protocol basis is COORDINATION_PROTOCOL §4 ("shared/cross-cutting files get dedicated integration tasks owned by exactly one unit").

**Intended approach:** Add `workspace:*` deps — approvals → shared + db; audit → shared + db; broker → shared + policy + approvals + audit. Run `pnpm install`, commit the lockfile, verify `-r typecheck/build/test` and `lint` all still exit 0. Resist adding anything external: the broker is a library here, not an HTTP server (Fastify is OIK-084/E9).

## Work Log