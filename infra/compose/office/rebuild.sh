#!/usr/bin/env sh
# rebuild: fresh image, D1 and D3 volumes reattached (Grok Bot's "Update").
# Addendum F §2.3 F3: any run in flight against this environment is
# cancelled, never suspended — there is no checkpoint/resume. Recording the
# run as run_status='cancelled' with a failure note naming this verb is the
# caller's responsibility (D0); this script only handles the environment side.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/../docker-compose.office.yml"
project="${OFFICE_PROJECT:-oikonomos-office-basileia}"
command -v docker >/dev/null

OFFICE_PROJECT="$project" docker compose -p "$project" -f "$compose_file" up -d --force-recreate --no-deps office-model office-browser

printf 'rebuild(%s): office-model and office-browser recreated from a fresh image layer.\n' "$project"
printf '  D0: untouched — lives in Postgres, outside the Office.\n'
printf '  D1 (oikonomos-workspace): PRESERVED — reattached unchanged.\n'
printf '  D2 (image layer, packages, /tmp, caches): DISCARDED — each container starts from a clean writable layer.\n'
printf '  D3 (oikonomos-secrets): PRESERVED — reattached unchanged, still mounted only into office-browser.\n'
printf '  Any run that was in flight against this environment is cancelled, never suspended.\n'
