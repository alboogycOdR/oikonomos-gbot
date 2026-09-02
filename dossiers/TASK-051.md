# TASK-051 — OIK-164 Composio Connect evaluation spike

## Brief
Written recommendation ONLY (adoption needs an ADR — Addendum D). Can Composio Connect supply connectors for G1 without violating the N5 scope boundary? Draft the recommendation below in this dossier; ORCH relocates it to docs/ at review.

## Must answer (Addendum D §2 OIK-164, §3 R19)
1. Hosted third-party gateway vs N5 / data sovereignty — connector traffic through external SaaS.
2. Per-tool tier-mapping feasibility against the OIK-047 manifest schema.
3. Cost vs the R30,000/month ceiling.

## Work Log

- [2026-09-02T10:55:00Z] [CX] Resumed on `task/TASK-051-cx`; no prior implementation was recorded. Read Addendum D §2/§3 R19, the live OIK-047 schema, ADR-008, the N5 rule, and current official Composio documentation/pricing.
- [2026-09-02T11:05:00Z] [CX] Recommendation complete and committed as `72cfbea`. Verified dossier-only diff with `git diff --check`; no product code, dependency, configuration, or adoption change was made.
- [2026-09-02T11:15:00Z] [ORCH] APPROVED, first-pass — all three required topics (N5/R19 data sovereignty, OIK-047 tier-mapping feasibility, cost vs. R30k/month) addressed explicitly and well-sourced (Composio's own current docs/pricing, checked live 2026-09-02). Recommendation: do not adopt for G1. Relocated the full recommendation to `docs/research/OIK-164-composio-connect-evaluation-2026-09-02.md` per this task's own instruction; this dossier reverts to its brief for historical reference.
