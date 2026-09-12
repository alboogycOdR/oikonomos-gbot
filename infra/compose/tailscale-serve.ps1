# TASK-240 — one HTTPS origin for the web workspace, via Tailscale Serve.
#
# Why Tailscale Serve and not Caddy/nginx: neither is installed on the
# workstation, Tailscale already is, it terminates TLS with a tailnet
# certificate for https://studyworkstation.<tailnet>.ts.net, it is tailnet-only
# (never public — that would be `tailscale funnel`, which this script never
# calls), and it preserves sub-paths under a mounted prefix (verified live
# 2026-09-12: /threads/x/messages reached control-api's auth and returned 401,
# exactly as the local request does). SSE and WebSocket upgrades pass through.
#
# The control-api registers no CORS policy and its session cookie is
# `Secure; SameSite=Strict`, so the dashboard MUST be served from the same
# origin as the API. This script mounts:
#   /            -> dashboard-static.mjs on 127.0.0.1:5174 (SPA fallback)
#   /<api prefix> -> control-api on 127.0.0.1:3000 for every public route prefix
# `/internal` is deliberately NOT mounted (operator-only, localhost).
#
# Idempotent: resets the serve config and re-applies it. Run after any new
# top-level API prefix is added (e.g. /workspace from TASK-237, /projects,
# /templates later). Verify with `tailscale serve status`.

$ErrorActionPreference = "Stop"
$ts = "C:\Program Files\Tailscale\tailscale.exe"
if (-not (Test-Path $ts)) { throw "tailscale.exe not found at $ts" }

# Mounts are PREFIX matches. A dashboard client route must never share a
# top-level segment with an API prefix, or the proxy swallows the page
# (found live 2026-09-12: mounting `/workspace` for the summary API made the
# SPA route `/workspace/<threadId>` return the API's 401). Where an API path
# and a client route do share a segment, mount the API path EXACTLY, as with
# `/workspace/summary` below. Future prefixes (/projects, /templates) are
# mounted only when their routes exist, and their client routes must live
# under a different segment (e.g. `/p/<id>`), see OIKONOMOS_WORKSPACE_WAVE §6.1.
$apiPrefixes = @(
  "/auth", "/approvals", "/health", "/openapi", "/roles", "/routines", "/runs",
  "/secret-requests", "/skills", "/tasks", "/threads",
  "/workspace/summary"   # TASK-237 — exact path; `/workspace/<threadId>` is a client route
)

& $ts serve reset | Out-Null
foreach ($p in $apiPrefixes) {
  & $ts serve --bg --set-path $p "http://127.0.0.1:3000$p" | Out-Null
}
& $ts serve --bg --set-path / "http://127.0.0.1:5174" | Out-Null
& $ts serve status
