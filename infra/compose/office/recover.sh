#!/usr/bin/env sh
# recover: replace an unreachable instance. Identical durable-state contract
# to rebuild (Addendum F §2.3 F3) — forces removal first, since an
# unreachable container may not respond to a graceful recreate.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/../docker-compose.office.yml"
project="${OFFICE_PROJECT:-oikonomos-office-basileia}"
command -v docker >/dev/null

OFFICE_PROJECT="$project" docker compose -p "$project" -f "$compose_file" rm -f -s office-model office-browser
OFFICE_PROJECT="$project" docker compose -p "$project" -f "$compose_file" up -d office-model office-browser

printf 'recover(%s): office-model and office-browser replaced.\n' "$project"
printf '  D0: untouched — lives in Postgres, outside the Office.\n'
printf '  D1 (oikonomos-workspace): PRESERVED — reattached unchanged.\n'
printf '  D2 (image layer, packages, /tmp, caches): DISCARDED — same as rebuild, the replaced containers start clean.\n'
printf '  D3 (oikonomos-secrets): PRESERVED — reattached unchanged, still mounted only into office-browser.\n'
printf '  Any run that was in flight against this environment is cancelled, never suspended.\n'
