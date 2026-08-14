#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?Set DATABASE_URL, for example postgresql://user:password@127.0.0.1:5432/oikonomos}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
migrations_dir="$script_dir/../migrations"

for migration in "$migrations_dir"/*.down.sql; do
  printf 'Reverting %s\n' "$(basename "$migration")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done
