# Workflow — Connectors-2, Fast-Follows, OIK-113/114

**Date:** 2026-09-04 · **Builders:** CX, CX9 (Codex), S5 (Claude Sonnet 5)

## Before sequencing: what's already there

**Connectors-2 (Calendar + Drive):** both manifests exist (`packages/connectors/manifests/google-calendar.yaml`, `google-drive.yaml`), both already onboarded with real docs (`docs/connectors/google-calendar.md`, `google-drive.md`, both dated 2026-09-02, G-CONN status CLOSED on Tier-3 as designed). Same shape as Gmail before Connectors-1 — real, tiered tools, high-risk ones `enabled: false` until governance clears them. The OAuth mechanism (`createOAuthTokenProvider`) is already generic, not Gmail-specific — Gmail's own wrapper (`createGmailOAuthTokenProvider`) is a thin shim over it, so Calendar/Drive minters are close to copy-paste from TASK-127's pattern.

**One real architectural gap found while scoping this:** `chatRunDriver.ts`'s connector merging (`combineConnectorContexts`) is pairwise — built for exactly two connectors (Gmail + the internal workspace bridge). Adding Calendar and Drive as two *more* connectors needs this generalized to N, not just two more special-cased resolver functions bolted on.

**OIK-112 (kill-switch drill):** its own WBS dependency, OIK-030 (`packages/broker`: capability kill switch, `capabilities.enabled=false` denies immediately), already exists — every manifest already uses `enabled: false` as a real, working gate (Gmail send, Calendar/Drive's T3 mutations). This task is much smaller than it sounds: prove the *platform-wide* "stop everything now" case end to end and write the runbook, not build a new mechanism.

**OIK-103/104 (E10 two-role handoff demo + Fable review):** all the real machinery already exists and is tested — `packages/memory`'s ACL/versioning, `roleMessages.ts`'s typed handoffs, and now TASK-131's real invokable `send_to_role` broker tool. This is a real end-to-end proof task, not new production code, matching TASK-135's shape.

**Major finding, changes the picture for OIK-113/114:** OpenSandbox (the E5 isolation runtime, ADR-006 Addendum B) is **already deployed and live** — a real server on `clawsrv`, reachable over Tailscale, running since 2026-08-16 (`infra/sandbox/README.md` has the full reproducible deployment record). This is NOT greenfield infrastructure. But **zero application code in this repo references OpenSandbox or Steel Browser at all** — the deployment exists, nothing calls it. Steel Browser (ADR-006: "unchanged as the browser/live-viewer layer but now runs inside an OpenSandbox sandbox") has no code presence whatsoever. The README also documents no `secret://` ref for the OpenSandbox API key yet — a real open question for whoever builds the first client. OIK-113 (browser trace → routine spec) is genuinely a multi-wave epic on its own (sandbox client → Steel deployment inside it → trace capture → codegen → human review → OIK-114's non-engineer usability proof) — this workflow schedules only its first real slice, investigation-first, not the whole thing.

## Protected-path / model routing

Unchanged from the last program: CX/CX9 (Codex) are valid protected-path authors given I (ORCH) am Claude; S5 is not, for anything touching `packages/broker`/`policy`/`approvals`/`harness-factory`. Grant-derived tool-mounting work in `chatRunDriver.ts` is security-sensitive by the same policy ADR-012 §2 item 6 already established for the OME ACL work — routed to CX/CX9.

## Wave 1 — dispatched now, no shared files across tracks

| Track | Task | Builder | Notes |
|---|---|---|---|
| Connectors-2 | TASK-137 — Google Calendar session minter | S5 | Mirrors TASK-127 exactly; `packages/connectors/src/**` unprotected |
| Connectors-2 | TASK-138 — Google Drive session minter | CX9 | Mirrors TASK-127 exactly |
| Fast-follow | TASK-140 — OIK-112 kill-switch drill | CX | Smaller/faster; frees CX soonest for Wave 2's security-sensitive work |

## Wave 2 (once Wave 1 lands)

| Track | Task | Builder | Notes |
|---|---|---|---|
| Connectors-2 | TASK-139 — generalize connector merging to N + wire Calendar/Drive grant-derived mounting | CX or CX9 | Depends on TASK-137, TASK-138; touches `chatRunDriver.ts` — protected-adjacent, CX/CX9 only |
| Fast-follow | TASK-141 — OIK-103/104 real two-role handoff demo | whichever of CX/CX9 is free | Depends on nothing new (TASK-131 already merged); real Postgres proof, then I run the Fable review myself once it lands |

## Wave 3 — investigation-first (scoped once Wave 2 clarifies capacity)

| Track | Task | Notes |
|---|---|---|
| Fast-follow | OIK-110/111 — per-routine budgets + spend ceiling | Genuinely under-specified; needs a real design pass (where spend gets recorded, what enforces the ceiling) before implementation, same discipline as TASK-135/136 |
| Fast-follow | Continue-after-approval | The deepest, most architecturally uncertain item this whole program — resuming a *live* Agent SDK session after a parked approval is granted, distinct from the DB-only resume TASK-133/136 built. Investigate first; may decompose further once the real shape is understood |
| OIK-113/114 | OpenSandbox client wrapper + connectivity proof | First real slice only — confirm the deployed server is reachable from wherever the worker runs, resolve/document the missing `secret://` ref for its API key, launch+teardown a real sandbox. Steel Browser deployment inside it, trace capture, and codegen are explicitly NOT in this first slice — separate, later tasks once this foundation is proven |

## What I'm doing now

Decomposing and dispatching Wave 1 (TASK-137/138/140) immediately — all three tracks are independent, no territory overlap. Wave 2/3 get decomposed once their dependencies land or investigation clarifies scope, same reasoning as every prior wave this session.
