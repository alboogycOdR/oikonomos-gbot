#!/usr/bin/env sh
# provision: first creation of the tenant Office environment (Addendum F §2.3 F3).
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/../docker-compose.office.yml"
project="${OFFICE_PROJECT:-oikonomos-office-basileia}"
command -v docker >/dev/null

OFFICE_PROJECT="$project" docker compose -p "$project" -f "$compose_file" up -d

printf 'provision(%s): office-model and office-browser created.\n' "$project"
printf '  D0 (Postgres: roles, routines, memory, audit, approvals): untouched — lives outside the Office.\n'
printf '  D1 (oikonomos-workspace, shared workspace + role dirs): created fresh, now durable.\n'
printf '  D2 (image layer, packages, /tmp, caches): created fresh from image; explicitly disposable from this point on.\n'
printf '  D3 (oikonomos-secrets, browser/connector credentials): created fresh, mounted only into office-browser; office-model has no access to it.\n'
