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
