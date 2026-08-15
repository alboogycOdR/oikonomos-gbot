# OIKONOMOS — Work Breakdown Addendum B

**Version:** 1.0 · **Date:** 2026-08-13
**Extends:** OIKONOMOS_Master_Work_Breakdown_v1.0.md, supersedes E5 in full
**Trigger:** opensandbox-group/OpenSandbox (Apache 2.0) — a general-purpose sandbox runtime for AI agents, released with native Claude Code, Playwright, and OpenClaw integration examples.

---

## 1. Decision

**Adopt OpenSandbox as the E5 isolation runtime.** This replaces the "build per-agent Docker isolation yourself, evaluate Daytona/E2B later" plan with "run OpenSandbox's Docker backend now, scale to its Kubernetes backend later — same tool, same API, no migration."

This is a stronger fit than either evaluation candidate named in the original Gap Closure Plan (§4, "Hibernating-workspace evaluation spike"):

| Capability | Original plan | OpenSandbox |
|---|---|---|
| Isolation backend | Custom Docker (Phase 1) → Daytona or E2B evaluated at a fleet gate | Docker locally now; Kubernetes at scale — **one tool, no gate, no migration** |
| Isolation strength | Docker only, initially | Selectable gVisor / Kata / Firecracker per workload |
| Credential handling into sandboxes | Built by hand (OpenBao, Phase 3) | **Credential Vault ships built in** — secrets injected into outbound requests, never exposed to the workload |
| Egress control per agent | Built by hand (OIK-077) | **Per-sandbox egress policy ships built in** |
| Claude Code inside a sandbox | Not designed | **Reference example in the repo** |
| Playwright inside a sandbox | Design work (E8) | **Reference example in the repo** |
| OpenClaw inside a sandbox | Not designed | **Reference example in the repo — names your own fleet component** |
| License | Daytona = AGPL flagged risk; E2B = Apache but Nomad/Consul-heavy | Apache 2.0, Docker-first, lighter to operate solo |

**Consequence:** OIK-046 (the evaluation spike) is retired — no longer needed, the decision is made. E5's tickets are rewritten below to integrate OpenSandbox rather than hand-build isolation. E8 gains a materially cheaper path for the Playwright/browser lane. Credential handling (previously deferred to Phase 3 / OIK-121 OpenBao) can be pulled forward because OpenSandbox's vault covers the sandbox-facing half of that problem immediately.

---

## 2. Revised E5 — Agent isolation (supersedes original E5 in full)

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-042 | OpenSandbox server deployment (Docker backend), Tailscale-bound | M | OIK-001 | `opensandbox-server` running on clawsrv; reachable only over Tailscale; `osb` CLI functional against it |
| OIK-043 | Sandbox lifecycle wired into `harness-factory` | L | OIK-042, OIK-033 | Every harness invocation runs inside a sandbox created via the OpenSandbox SDK, not on the bare host; sandbox created per run, destroyed or hibernated on completion |
| OIK-044 | Isolation chaos test (CI) | M | OIK-043 | Agent A disk-fill, crash, and runaway loop each provably cannot affect Agent B's sandbox (unchanged acceptance bar from original E5) |
| OIK-045 | Sandbox lifecycle policy: create, pause, destroy, reap | M | OIK-043 | Orphaned sandboxes reaped; no volume leak over 100 cycles |
| OIK-045a | **NEW** — Credential Vault integration | L | OIK-042, OIK-120 (age/systemd secrets) | Connector credentials injected into sandbox outbound requests via OpenSandbox's vault; **no credential ever readable from inside the sandbox filesystem or process env** — verified by a probe test run from inside a sandbox |
| OIK-045b | **NEW** — Egress policy per role/routine | L | OIK-042, OIK-020 (role constraints) | Per-sandbox egress allowlist set from `role_grants.constraints.domains`; off-allowlist request blocked at the OpenSandbox network layer, not just application-layer; SSRF negative test (RFC1918, metadata endpoints) passes **at the sandbox boundary**, strengthening OIK-077 rather than duplicating it |
| OIK-045c | **NEW** — Isolation-strength selection per capability tier | M | OIK-019, OIK-045 | Tier 0–1 sandboxes may use the lighter backend (gVisor default); Tier 3–4 capability execution mandates the strongest configured backend (Kata or Firecracker); selection is policy-driven, not agent-chosen |
| OIK-046 | ~~Hibernating-workspace evaluation spike~~ **RETIRED** | — | — | Superseded by §1 decision. Do not schedule. |

**Net effect on the WBS:** E5 shrinks from "build isolation, then evaluate a hibernation product later" to "deploy and integrate one product, twice — Docker now, Kubernetes at scale." Three new tickets (045a–c) exist because OpenSandbox exposes capability the original plan had to build from scratch (vault, egress, tiered isolation strength) — net ticket count is roughly flat, but two Phase-3/gate-deferred capabilities (credential leasing, egress allowlisting) land in the foundation instead.

---

## 3. Changes to E8 — Browser workspace

| Ticket | Change |
|---|---|
| OIK-074 (Steel Browser deployment) | **Unchanged in tool choice** — Steel remains the browser-session/live-viewer layer. **Deployment target changes**: Steel now runs *inside* an OpenSandbox sandbox rather than a hand-built container, using the repo's own `chrome` and `playwright` examples as the deployment reference. |
| OIK-076 (browser capabilities registered with broker) | Depends on OIK-045a, OIK-045b now — egress and credential controls are inherited from the sandbox layer rather than built separately for the browser lane. |
| OIK-077 (egress allowlist, SSRF negative test) | **Narrowed, not removed.** OIK-045b now provides sandbox-network-layer egress control. OIK-077 retains the application-layer allowlist check inside Steel's own session config as defence in depth — two layers, cheaper than one hand-built layer. |
| OIK-083 (computer-use lane) | Runs inside the same OpenSandbox sandbox as the browser lane; no separate isolation work required. |

---

## 4. Changes to component sourcing (delta to Synthesis Spec §3 / Gap Closure §4)

| Component | Prior status | Revised status |
|---|---|---|
| Per-agent isolation | BUILD (Docker, hand-rolled) | **ADOPT** — OpenSandbox, Apache 2.0 |
| Hibernating workspace (fleet gate) | EVALUATE at gate (Daytona vs E2B) | **ADOPT now** — OpenSandbox Kubernetes backend is the same tool at scale; no gate, no migration decision needed later |
| Credential leasing into agent workspace | DEFER to Phase 3 (OpenBao) | **ADOPT now** — OpenSandbox Credential Vault covers the sandbox-facing case immediately. OpenBao (OIK-121) is narrowed to browser-session OAuth leases specifically (Steel/E8), not general credential injection. |
| Per-sandbox egress control | BUILD (OIK-077) | **ADOPT** — OpenSandbox network policy, with OIK-077 retained as a thinner defence-in-depth layer |
| Isolation strength (gVisor/Kata/Firecracker) | Not designed | **ADOPT** — selectable per capability tier (OIK-045c) |

---

## 5. Risk register additions

| ID | Risk | Control | Ticket |
|---|---|---|---|
| R14 | OpenSandbox is a young, fast-moving project (67 open issues, 58 open PRs at review time) — API or config surface may shift | Pin a specific release; the monthly SDK-drift watch pattern (OIK-010) extended to cover OpenSandbox release notes, not just the Agent SDK | OIK-042 |
| R15 | Sandbox-layer egress/credential controls create a false sense of complete coverage if the application-layer checks are dropped | OIK-045b and OIK-077 are both required — defence in depth is explicit in acceptance criteria, not optional | OIK-045b, OIK-077 |
| R16 | Kubernetes backend (fleet-scale path) is materially more operational surface than Docker | Do not adopt the Kubernetes backend until a real multi-tenant or high-concurrency trigger exists — Docker backend is sufficient at solo/current scale | OIK-042 |

---

## 6. Scheduling note for DEVDepartment

- E5 (revised) still depends only on OIK-001 and gates nothing outside itself except that E3/E4 protected-path work should run *inside* an OpenSandbox sandbox once OIK-043 lands — sequence OIK-042/043 early, in parallel with E2, so E4's harness work lands directly on the isolated runtime rather than being retrofitted.
- OIK-045a (Credential Vault) pulls forward capability the Handover Package assumed wasn't available until Phase 3 (OpenBao, §v0.1 O4). Treat OIK-121 as narrowed, not removed — OAuth session leasing for the browser lane (Steel) is still its job.
- OIK-046 is retired. Remove it from any board before scheduling; do not carry it as a stale entry.
