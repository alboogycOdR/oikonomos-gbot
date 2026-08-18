# OIKONOMOS — Work Breakdown Addendum D

**Version:** 1.0 · **Date:** 2026-08-17
**Extends:** Master WBS + Addenda A–C. Amends E9, E14.4; adds evaluation tickets.
**Source:** milind-soni/OpenMausBot — "Open Source Alternative to Grok Bot with a virtual machine that bots can use." Electron + local harness server (127.0.0.1:8799), bots run on the user's own claude/codex/grok CLIs, per-bot cloud desktop watchable live, Composio Connect for 500+ apps, agent-to-agent delegation via a mounted agents-MCP (`list_bots`/`ask_bot`). v0.1.x, single primary maintainer, ~5 days old at review, macOS-first with Windows installer groundwork in CI. **License: verify before any code reuse — not confirmed during this review.**

---

## 1. Strategic finding

OpenMausBot is the first project reviewed that overlaps OIKONOMOS's *product thesis* rather than one component: BYO-agent-CLIs (the same three as `agent-providers`), bots-as-teammates, own computer per bot, local-first. What it visibly lacks is everything behind gate G-GOV: approvals, risk tiers, audit, credential isolation, egress policy, budgets.

**Position adopted:** the interaction layer is now commodity — built openly by multiple teams within days of Grok Bot's launch. OIKONOMOS's differentiation is the governed control plane, full stop. Consequences:

1. Surface work (E9, E14) should harvest shamelessly and never be treated as moat.
2. Do **not** adopt OpenMausBot as a foundation: 5 days old, one maintainer, Electron/macOS-first vs. your Windows+VPS reality, unverified license, and zero governance seams to graft the broker onto. Harvest patterns; monitor monthly.
3. Watch for convergence: if it matures and gains a plugin seam, "OIKONOMOS governance under an OpenMausBot-class surface" becomes a legitimate future architecture. Not now.

## 2. Tickets

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-163 | Harvest `ask_bot`/`list_bots` agents-MCP pattern as OIK-149 reference | M | OIK-149 design start | Design note comparing their MCP-mounted delegation with OIK-149's governed channel; adopt the MCP mounting mechanism if compatible, retaining the rule that **messages request, never authorize** |
| OIK-164 | Composio Connect evaluation spike (connector supply for G1) | M | OIK-047 | Written recommendation only. Must address: hosted third-party gateway vs. N5 scope boundary and data sovereignty; per-tool tier mapping feasibility; cost. Adoption requires an ADR. |
| OIK-165 | Surface UX reference: roster/per-bot identity/model-picker patterns → E9 apps | S | OIK-088, OIK-092 | UX notes folder in `docs/` informing dashboard + Flutter design; screenshots + interaction inventory |
| OIK-166 | Electron data point folded into Tauri go/no-go (OIK-097) | S | OIK-097 | OIK-097's recommendation must now compare Tauri vs Electron vs PWA with OpenMausBot cited |
| OIK-167 | Monthly watch: OpenMausBot maturity + license + plugin seam | S | — | Added to the existing drift-watch job (OIK-010 pattern); ticket auto-raised on license clarification, 1.0 release, or extension API |

## 3. Risk register

| ID | Risk | Control | Ticket |
|---|---|---|---|
| R18 | Commodity interaction layers erode OIKONOMOS's perceived value before G-GOV ships anything visible | Marketing and parity claims lead with governance ("asks before it acts", audit replay), never with surface features others ship free | Brochure §strip already does this; keep it so |
| R19 | Composio adoption would route connector traffic through a third-party SaaS, potentially conflicting with N5/data sovereignty | Evaluation spike must answer this explicitly before any adoption ADR | OIK-164 |
