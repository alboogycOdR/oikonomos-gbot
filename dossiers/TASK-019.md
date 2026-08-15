# TASK-019 — OIK-042 OpenSandbox server deployment ⛔ HELD

**Brief:** HELD — do not dispatch. Alister instructed that no E5-dependent work is dispatched until he confirms the Addendum B reconciliation. Planned so the sequencing is visible.

**Spec pointers:** Addendum B §2 (OIK-042), §5 (R14 pin a release, R16 Docker backend only), §6 (sequence early so E4 harness work lands on the sandbox rather than being retrofitted). Build directive §2a.

**Intended approach:** When the hold lifts — `opensandbox-server` on clawsrv, Docker backend, Tailscale-only, `osb` CLI working against it, a pinned release recorded. Deployment notes go in `infra/sandbox/README.md`, NOT `docs/runbooks/`: `docs/**` is blocked for builders by the territory firewall and would be rejected mid-session. This is the only Addendum B ticket dependency-eligible today; the rest need OIK-033 (E4), OIK-120 (secrets), or OIK-020 (TASK-010).

## Work Log