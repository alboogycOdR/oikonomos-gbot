#!/usr/bin/env sh
set -eu

require() { eval "value=\${$1-}"; [ -n "$value" ] || { printf '%s must be set\n' "$1" >&2; exit 64; }; }
require BACKUP_DIR
require BACKUP_ID
require DRILL_POSTGRES_USER
require DRILL_POSTGRES_PASSWORD
require DRILL_POSTGRES_DB
case "$BACKUP_ID" in *[!A-Za-z0-9._-]*|'') printf 'Invalid BACKUP_ID\n' >&2; exit 64;; esac
command -v docker >/dev/null
command -v sha256sum >/dev/null
archive_dir="$BACKUP_DIR/$BACKUP_ID"
manifest="$archive_dir/manifest.env"
for file in "$archive_dir/postgres.dump" "$archive_dir/evidence.tar.gz" "$manifest"; do [ -f "$file" ] || { printf 'Backup is incomplete: %s\n' "$file" >&2; exit 66; }; done
FORMAT_VERSION=$(awk -F= '$1 == "FORMAT_VERSION" { print $2 }' "$manifest")
POSTGRES_DUMP_SHA256=$(awk -F= '$1 == "POSTGRES_DUMP_SHA256" { print $2 }' "$manifest")
POSTGRES_DATA_SHA256=$(awk -F= '$1 == "POSTGRES_DATA_SHA256" { print $2 }' "$manifest")
EVIDENCE_TAR_SHA256=$(awk -F= '$1 == "EVIDENCE_TAR_SHA256" { print $2 }' "$manifest")
EVIDENCE_ENTRY_COUNT=$(awk -F= '$1 == "EVIDENCE_ENTRY_COUNT" { print $2 }' "$manifest")
[ "$FORMAT_VERSION" = 1 ] || { printf 'Unsupported backup format\n' >&2; exit 66; }
for checksum in "$POSTGRES_DUMP_SHA256" "$POSTGRES_DATA_SHA256" "$EVIDENCE_TAR_SHA256"; do
  [ "${#checksum}" -eq 64 ] || { printf 'Malformed backup manifest\n' >&2; exit 66; }
  case "$checksum" in *[!0123456789abcdef]*) printf 'Malformed backup manifest\n' >&2; exit 66;; esac
done
case "$EVIDENCE_ENTRY_COUNT" in *[!0-9]*|'') printf 'Malformed backup manifest\n' >&2; exit 66;; esac
[ "$(sha256sum "$archive_dir/postgres.dump" | awk '{print $1}')" = "$POSTGRES_DUMP_SHA256" ] || { printf 'Postgres archive checksum mismatch\n' >&2; exit 66; }
[ "$(sha256sum "$archive_dir/evidence.tar.gz" | awk '{print $1}')" = "$EVIDENCE_TAR_SHA256" ] || { printf 'Evidence archive checksum mismatch\n' >&2; exit 66; }
suffix="${BACKUP_ID}-$$-${RANDOM:-0}"
container="oikonomos-restore-drill-$suffix"
evidence_volume="oikonomos-restore-drill-evidence-$suffix"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; docker volume rm "$evidence_volume" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
docker volume create "$evidence_volume" >/dev/null
docker run -d --rm --name "$container" -e POSTGRES_USER="$DRILL_POSTGRES_USER" -e POSTGRES_PASSWORD="$DRILL_POSTGRES_PASSWORD" -e POSTGRES_DB="$DRILL_POSTGRES_DB" pgvector/pgvector:pg16 >/dev/null
until docker exec "$container" pg_isready -U "$DRILL_POSTGRES_USER" -d "$DRILL_POSTGRES_DB" >/dev/null 2>&1; do sleep 1; done
docker cp "$archive_dir/postgres.dump" "$container:/restore.dump"
docker exec -e PGPASSWORD="$DRILL_POSTGRES_PASSWORD" "$container" pg_restore -U "$DRILL_POSTGRES_USER" -d "$DRILL_POSTGRES_DB" --no-owner --no-privileges --exit-on-error /restore.dump
restored_sha256=$(docker exec -e PGPASSWORD="$DRILL_POSTGRES_PASSWORD" "$container" pg_dump -U "$DRILL_POSTGRES_USER" -d "$DRILL_POSTGRES_DB" --data-only --inserts --no-owner --no-privileges | sed '/^\\restrict /d; /^\\unrestrict /d' | sha256sum | awk '{print $1}')
[ "$restored_sha256" = "$POSTGRES_DATA_SHA256" ] || { printf 'Restored Postgres data fingerprint mismatch\n' >&2; exit 67; }
restored_evidence_count=$(docker run --rm --volume "$evidence_volume:/target" --volume "$archive_dir:/backup:ro" alpine:3.20 sh -c 'tar -C /target -xzf /backup/evidence.tar.gz && find /target -mindepth 1 -print | wc -l' | tr -d '[:space:]')
[ "$restored_evidence_count" = "$EVIDENCE_ENTRY_COUNT" ] || { printf 'Restored evidence entry count mismatch\n' >&2; exit 67; }
printf 'RESTORE_DRILL_VERIFIED backup=%s database=data-fingerprint evidence=archive-extracted\n' "$BACKUP_ID"
