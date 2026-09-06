# TASK-185 — G-08 — Per-sandbox egress allowlist + close the sandbox port band at the host (protected path)

## Brief

Two layers, both required (Directive §2a R15). (1) packages/policy: a pure `resolveEgressPolicy(role, manifests) → {mode: allow_all|defaults_plus_allowlist|allowlist_only, hosts[]}` deriving allowed hosts from the role's granted connector manifests plus an explicit per-role list; zero I/O (lint-enforced). (2) Enforcement at sandbox creation: packages/sandbox-client translates the policy into whatever the pinned OpenSandbox v0.2.2 supports (check upstream `docs/components/egress.md` for the pinned version; if the pinned server lacks per-sandbox network policy, implement it as an in-sandbox proxy + nftables applied by the entrypoint and record that choice in infra/sandbox/README.md) — a deny is logged as an audit event with the host. (3) Host: apply the DOCKER-USER iptables rule from README §7.1 (persisted across reboot), verify by observed refusal from an external path, and record the evidence in the README; this retires TASK-027. Liveness: the broker refuses to run any command in a sandbox whose egress policy was not applied (evidence = a policy-applied marker the entrypoint writes, not config presence).

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-08 (AC anchors: observed refusal from inside allowlist_only; liveness — sandbox with policy absent is refused before any command); report §10.3 four modes, §12.5(a) egress deny; OIK-045b (Addendum B §2, pulled forward); infra/sandbox/README.md §7.1 remedy and trigger (fires with TASK-170); TASK-027 (absorbed — its DOCKER-USER rule is applied here); ADR-005 liveness. PROTECTED PATH packages/policy/** — author CX, reviewer ORCH opus-4-8.

## Territory

packages/policy/src/egress.ts, packages/policy/src/egress.test.ts, packages/policy/src/index.ts, packages/sandbox-client/src/egress.ts, packages/sandbox-client/src/egress.test.ts, infra/sandbox/README.md, infra/sandbox/egress/**, infra/sandbox/scripts/**

Depends_On: TASK-170

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log

- [2026-09-06T19:23:41Z] [CX] Resumed on `task/TASK-185-cx`; task has no `Review_Findings`. Preflight (verbatim):
  ```text
  [preflight] TASK-185 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE
  [preflight] 8 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    packages/policy/src/egress.ts  -> does not exist; parent packages/policy/src/ exists
    NEW    packages/policy/src/egress.test.ts  -> does not exist; parent packages/policy/src/ exists
    FILE   packages/policy/src/index.ts  -> exists, 152 line(s), 4442 bytes
    NEW    packages/sandbox-client/src/egress.ts  -> does not exist; parent packages/sandbox-client/src/ exists
    NEW    packages/sandbox-client/src/egress.test.ts  -> does not exist; parent packages/sandbox-client/src/ exists
    FILE   infra/sandbox/README.md  -> exists, 187 line(s), 15901 bytes
    GLOB   infra/sandbox/egress/**  -> matches nothing yet (new territory)
    GLOB   infra/sandbox/scripts/**  -> matches nothing yet (new territory)
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-09-06T19:23:41Z] [CX] Blocked before implementation: the pinned upstream `server/v0.2.2` natively supports `networkPolicy` plus the egress sidecar, so no proxy fallback is needed. But this repository's actual creation/command path is `services/worker/src/chatRunDriver.ts`: it calls `client.createSandbox()` without `networkPolicy`, then calls `client.runCommand()` without a policy-applied marker assertion. Supporting the upstream field also requires `packages/sandbox-client/src/types.ts` and `packages/sandbox-client/src/client.ts`, neither listed in TASK-185 `Owned_Paths`. Adding only the new egress modules would leave the policy unenforced and the liveness AC false. Required territory expansion: `services/worker/src/chatRunDriver.ts`, `packages/sandbox-client/src/client.ts`, and `packages/sandbox-client/src/types.ts` (plus their relevant tests, if any).
- [2026-09-06T21:55:00Z] [CX] Resumed after ORCH widened territory (PLAN.md 2026-09-06T21:40:00Z): confirmed `CreateSandboxRequest.networkPolicy` can now be typed and passed at creation, but stopped before writing an unsafe/fictional implementation. The authoritative report defines four source modes (`No policy`, explicit `Allow all`, `Defaults + team allowlist`, `Team allowlist only`); TASK-185 condenses the first two to `allow_all` but requires the remaining three output modes. The live `Role` persistence model has no egress-mode or explicit-host-list field; the only available candidate is manifest `role_grants.constraints.domains`, which cannot distinguish `defaults_plus_allowlist` from `allowlist_only`, nor identify the mandatory default destinations. Separately, OpenSandbox's create response/client exposes no policy-denial event stream, and the sandbox receives no trusted audit credential: recording a worker audit row merely because a command failed would not prove an egress deny or identify its host. Need ORCH to specify (a) the persisted/configuration source and exact default-host set for the three-mode resolver, and (b) the trusted sidecar-to-audit integration/protocol (or a granted host-side collector path) that makes the required denied-host audit row real. The marker liveness mechanism can then be implemented against that resolved policy.
- [2026-09-06T22:45:00Z] [CX] Resumed after the human-confirmed resolver rule and explicit denial-audit descope (PLAN.md 2026-09-06T22:10:00Z). Preflight re-run against the widened territory: all nine existing files and two new globs are present/available; the two policy and sandbox egress modules remain new territory. A further ownership blocker remains: `services/worker/src/chatRunDriver.ts` must import and call the canonical `@oikonomos/policy` resolver so the policy module is actually the single pure policy decision point. `services/worker/package.json` does not declare that workspace dependency and `services/worker/node_modules/@oikonomos/policy` is absent; independently verified with `pnpm --filter @oikonomos/worker exec node --input-type=module -e "import('@oikonomos/policy')..."`, which exited 1 with `ERR_MODULE_NOT_FOUND`. Adding `@oikonomos/policy: workspace:*` to `services/worker/package.json` (and updating `pnpm-lock.yaml` if required by the package manager) is outside TASK-185 Owned_Paths. Duplicating resolver logic in the worker/sandbox client would violate the task's required pure policy-module architecture and create policy drift, so no code was written. Required territory expansion: `services/worker/package.json` (and `pnpm-lock.yaml` only if package-manager generated). The earlier gaps are now resolved by PLAN.md: resolver input is `role_grants.constraints.domains` plus `strictEgress`; per-host denial audit is explicitly descoped as untrustworthy on the pinned deployment.
- [2026-09-06T20:01:47Z] [CX9] Resumed on `task/TASK-185-cx9`; no `Review_Findings` rework was present. Preflight re-run (verbatim):
  ```text
  [preflight] TASK-185 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 16 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    packages/policy/src/egress.ts  -> does not exist; parent packages/policy/src/ exists
    NEW    packages/policy/src/egress.test.ts  -> does not exist; parent packages/policy/src/ exists
    FILE   packages/policy/src/index.ts  -> exists, 152 line(s), 4442 bytes
    NEW    packages/sandbox-client/src/egress.ts  -> does not exist; parent packages/sandbox-client/src/ exists
    NEW    packages/sandbox-client/src/egress.test.ts  -> does not exist; parent packages/sandbox-client/src/ exists
    FILE   packages/sandbox-client/src/client.ts  -> exists, 407 line(s), 17829 bytes
    FILE   packages/sandbox-client/src/types.ts  -> exists, 96 line(s), 3320 bytes
    FILE   packages/sandbox-client/test/sandboxClient.test.ts  -> exists, 343 line(s), 14278 bytes
    FILE   packages/sandbox-client/test/sandboxClient.integration.test.ts  -> exists, 63 line(s), 2734 bytes
    FILE   services/worker/src/chatRunDriver.ts  -> exists, 545 line(s), 28702 bytes
    FILE   services/worker/src/chatRunDriver.test.ts  -> exists, 1058 line(s), 57389 bytes
    FILE   services/worker/package.json  -> exists, 44 line(s), 1228 bytes
    FILE   pnpm-lock.yaml  -> exists, 5126 line(s), 170638 bytes
    FILE   infra/sandbox/README.md  -> exists, 187 line(s), 15901 bytes
    GLOB   infra/sandbox/egress/**  -> matches nothing yet (new territory)
    GLOB   infra/sandbox/scripts/**  -> matches nothing yet (new territory)
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-09-06T20:01:47Z] [CX9] BLOCKED — `SPEC_AMBIGUITY`: no sanctioned manifest-derived host source exists. `ConnectorManifest.mcp_server.url_ref` is required by `packages/connectors/src/manifest/schema.ts` to be a `secret://` reference; `urlRef.ts` and its schema tests explicitly reject literal `http(s)` URLs. The actual manifests contain only refs such as `secret://mcp/gmail/url`, which disclose no host, and the cited OIK-045b source only says the network allowlist is set from `role_grants.constraints.domains`. Therefore the task's required `defaults_plus_allowlist` mode cannot derive the required manifest hosts purely and deterministically without either resolving secrets (violates zero-I/O) or inventing connector-to-host mappings (not specified). Please provide an authoritative pure host field/mapping and its ownership.
- [2026-09-06T20:01:47Z] [CX9] Independent liveness ownership blocker: `resolveRoleSandbox` creates the persistent office with `entrypoint: ["tail", "-f", "/dev/null"]`. The only actual office image definition, `infra/sandbox/images/office-base/Dockerfile`, is outside TASK-185 Owned_Paths and ends with the same `CMD ["tail", "-f", "/dev/null"]`; it contains no egress-policy verification or marker writer. A worker-issued marker command would be forgeable by the sandbox workload and therefore cannot prove policy application. The required marker must be installed into the trusted image entrypoint (or an equally trusted server-side mechanism must be specified), so implementation cannot satisfy the liveness AC within current territory. No product code was changed and no tests were run because both required security semantics remain undefined/unwritable.
