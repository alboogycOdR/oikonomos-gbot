# TASK-202 — Trustworthy per-denial egress audit for sandboxed roles

## Work Log

- [2026-09-07T02:35:00Z] [S5] Session start. Read AGENTS.md, briefings/S5_BUILD_BRIEFING.md
  (control.mode=strict section), PLAN.md's TASK-202 block (Review_Findings empty —
  fresh dispatch, not a rework). No prior dossier existed. Created branch
  `task/TASK-202-s5` from the dispatched HEAD (repo was in detached HEAD state
  at `7a9abdc`).

  Preflight (`python scripts/preflight_paths.py TASK-202`):
  ```
  [preflight] TASK-202 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
  [preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   infra/sandbox/README.md  -> exists, 195 line(s), 16399 bytes
    FILE   packages/audit/src/index.ts  -> exists, 265 line(s), 9402 bytes
    FILE   packages/audit/test/audit-writer.integration.test.ts  -> exists, 133 line(s), 5373 bytes
  ```

  Confirmed live SSH access to `clawsrv` (`~/.ssh/config` host `clawsrv`) and
  the real `OIK_SECRET_OPENSANDBOX_API_KEY`/`OIK_SECRET_OPENSANDBOX_EXECD_ACCESS_TOKEN`
  env vars were present in this dispatched session, so did the investigation the
  task's own Description calls for live against the real deployment rather than
  guessing, exactly as TASK-185/CX9 did for the original 501 finding.

- [2026-09-07T02:55:00Z] [S5] Investigated (a) newer pinned versions and (b) an
  independent sidecar log path, entirely against either the real production
  server (read-only probes + one disposable throwaway sandbox, destroyed) or a
  fully separate temporary `opensandbox-server` test container on an unused
  port/port-range (never touching production's own container, config, or
  running sandboxes). Full evidence trail written to `infra/sandbox/README.md`
  §9. Summary of findings:
  - `v0.2.2` (pinned): stable Diagnostics API still `501` on every scope, confirmed live again.
  - `v0.2.3`: stable API now implemented, but only `scope=container|all` (logs) /
    `runtime|all` (events) exist — `scope=network` is `400 DIAGNOSTICS_SCOPE_UNSUPPORTED`.
    No route to the sidecar in ANY version's stable API.
  - `v1.0.1`: diagnostics API removed entirely — a regression, not a fix.
  - The deprecated logs endpoint's `container=` query param is dead code against
    this Docker backend — every value tested returns the identical workload-container
    log, never the sidecar's.
  - The egress sidecar (`sandbox-egress-<id>`) IS a genuinely separate,
    workload-untamperable container (confirmed via `docker inspect` — no shared
    socket/privilege), so the trust-boundary half of AC1 is real — but its own
    logs never record a per-host denial in either available enforcement mode
    (`dns`, current production config; `dns+nft`, the only other schema-valid
    value — `"proxy"` is rejected outright by the pinned server's own pydantic
    validation). Verified by a live denied `wget` (hostname + raw IP) against a
    real `allowlist_only`-shaped sandbox in both modes, then reading the
    sidecar's own `docker logs` and its live `nft list ruleset` (no per-rule
    `log` statement anywhere in the `egress` chain — not even the kernel's own
    `dmesg` carries per-host attribution).
  - The `system.py` mitmproxy addon that WOULD give full per-request logging is
    present in the `opensandbox/egress:v1.1.7` image but unreachable — no `mode`
    value in the pinned server's config schema ever invokes it.

  Cleanup performed and verified: temporary `opensandbox-server-test202`
  container removed, its volumes removed by its own destroy/cleanup calls
  (confirmed no `opensandbox-runtime-*` volumes left over), temp config
  directory `~/opensandbox-test-202` deleted, temporary `v0.2.3`/`v1.0.1`
  server images removed (`docker rmi`). Production `opensandbox-server`
  confirmed never restarted (same image digest `sha256:8f87…`, continuous
  uptime spanning the whole session).

  **No code change to `packages/audit/src/index.ts` or the integration test** —
  per the task's own Description ("Do not ship a per-denial audit mechanism
  whose trust boundary can't be verified"), and no trustworthy per-host source
  exists to wire in. `infra/sandbox/README.md` §9 records the full evidence and
  a recommendation for what upstream/engineering work would actually close the
  gap, so this doesn't need re-investigating from scratch next time.

## Outcome

Reporting `blocked` (not `needs_review`) — see the `devteam-control` block.
This is a **SPEC_AMBIGUITY**, not a `MISSING_DEPENDENCY` in the sense of "I
need a file I don't own": the task's own Description explicitly anticipates a
negative finding ("Investigate first, don't assume a fix exists... Do not ship
a per-denial audit mechanism whose trust boundary can't be verified") but its
Acceptance_Criteria are written as unconditional musts (a real `audit_events`
row must exist). Both can't be simultaneously true given what was actually
found. This mirrors exactly the fork TASK-185 hit and escalated to
human-confirmation before proceeding (see PLAN.md's TASK-185
`[2026-09-06T22:10:00Z, reply to 2nd blocked report, human-confirmed both
decisions]` note) — it is ORCH's/the human's call whether to accept this
investigation as closing TASK-202 with AC2 permanently descoped (recommended,
per the README's own "Net conclusion"), or to open a materially larger
follow-up task for a custom log-forwarding sidecar or an upstream fix.
