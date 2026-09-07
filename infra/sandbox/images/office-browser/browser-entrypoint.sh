#!/bin/sh
set -eu

# A role id comes from the sandbox creator, never from the model.  Validate it
# before turning it into a path, then make its bot-private profile root-only.
role_id="${OIKONOMOS_ROLE_ID:-default}"
case "$role_id" in
  *[!A-Za-z0-9_-]*|"")
    echo "invalid OIKONOMOS_ROLE_ID" >&2
    exit 64
    ;;
esac
profile_dir="/oikonomos/secrets/browser-profiles/$role_id"
mkdir -p "$profile_dir"
chown root:root "$profile_dir"
chmod 0700 "$profile_dir"

# Steel is local-only.  Its API stays on loopback; the unprivileged agent sees
# it only through the MCP stdio server configured by steelSession.ts.
(cd /app && HOST=127.0.0.1 PORT=3000 /app/api/entrypoint.sh --no-nginx) &
steel_pid=$!
trap 'kill "$steel_pid" 2>/dev/null || true; wait "$steel_pid" 2>/dev/null || true' EXIT INT TERM

# TASK-208: `/v1/health`, not `/health` — the pinned steel-browser image
# serves its health route under the versioned prefix and 404s the bare path,
# which `--fail` turns into a never-satisfied loop. Verified live inside a
# real sandbox: /v1/health -> 200, /health -> 404. This wait loop had never
# actually run before TASK-208 made OpenSandbox invoke this script at all,
# so the wrong path never surfaced.
#
# Chromium takes a while to come up on a 500m-CPU sandbox; 30s was tight
# even when the path was right. 90 attempts keeps the same 1s cadence.
attempt=0
until curl --fail --silent --show-error http://127.0.0.1:3000/v1/health >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ]; then
    echo "Steel Browser did not become healthy" >&2
    exit 1
  fi
  sleep 1
done

exec node /opt/oikonomos/egress-entrypoint.mjs "$@"
