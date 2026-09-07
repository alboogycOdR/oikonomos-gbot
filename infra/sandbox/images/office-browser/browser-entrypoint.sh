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

attempt=0
until curl --fail --silent --show-error http://127.0.0.1:3000/health >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Steel Browser did not become healthy" >&2
    exit 1
  fi
  sleep 1
done

exec node /opt/oikonomos/egress-entrypoint.mjs "$@"
