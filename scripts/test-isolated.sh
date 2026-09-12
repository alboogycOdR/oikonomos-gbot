#!/usr/bin/env sh
# TASK-240 — POSIX twin of test-isolated.ps1 for non-Windows hosts (future
# always-on host, TASK-249). Does not manage a Windows watchdog; stop any live
# worker yourself before running. Never prints DATABASE_URL.
set -eu
: "${DATABASE_URL:?Set DATABASE_URL}"
container="${OIK_PG_CONTAINER:-oikonomos-postgres-local}"
testdb="oikonomos_test"
base="${DATABASE_URL%/*}"
test_url="$base/$testdb"
pguser="$(docker exec "$container" printenv POSTGRES_USER)"
if [ "${1:-}" = "--init" ]; then
  docker exec "$container" psql -U "$pguser" -d postgres -Atc "select 1 from pg_database where datname='$testdb'" | grep -q 1 \
    || docker exec "$container" psql -U "$pguser" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $testdb" >/dev/null
  for m in infra/postgres/migrations/*.up.sql; do
    echo "[test-isolated] applying $(basename "$m")"
    docker exec -i "$container" psql -U "$pguser" -d "$testdb" -v ON_ERROR_STOP=1 -f - < "$m" >/dev/null
  done
  shift
fi
echo "[test-isolated] database: $testdb"
DATABASE_URL="$test_url" pnpm -r test
