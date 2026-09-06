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
