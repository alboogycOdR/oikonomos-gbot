#!/usr/bin/env sh
set -eu

require() { eval "value=\${$1-}"; [ -n "$value" ] || { printf '%s must be set\n' "$1" >&2; exit 64; }; }
require DATABASE_URL
require EVIDENCE_VOLUME
require BACKUP_DIR
require BACKUP_ID
case "$BACKUP_ID" in *[!A-Za-z0-9._-]*|'') printf 'Invalid BACKUP_ID\n' >&2; exit 64;; esac
postgres_docker_network=${POSTGRES_DUMP_DOCKER_NETWORK:-host}
case "$postgres_docker_network" in *[!A-Za-z0-9_.-]*|'') printf 'Invalid POSTGRES_DUMP_DOCKER_NETWORK\n' >&2; exit 64;; esac
command -v docker >/dev/null
command -v sha256sum >/dev/null
archive_dir="$BACKUP_DIR/$BACKUP_ID"
[ ! -e "$archive_dir" ] || { printf 'Refusing to overwrite existing backup: %s\n' "$archive_dir" >&2; exit 65; }
umask 077
mkdir -p "$archive_dir"
cleanup() { rm -rf "$archive_dir"; }
trap cleanup HUP INT TERM
docker volume inspect "$EVIDENCE_VOLUME" >/dev/null
# Use the same pinned pg_dump image used by restore-drill.sh.  Hashing a host
# client dump and a container client dump makes an otherwise faithful restore
# fail when the clients differ only in their version header comments.
docker run --rm --network "$postgres_docker_network" --env DATABASE_URL="$DATABASE_URL" --mount "type=bind,source=$archive_dir,target=/backup" pgvector/pgvector:pg16 sh -c \
  'pg_dump --format=custom --no-owner --no-privileges --file /backup/postgres.dump "$DATABASE_URL" &&
   pg_dump --data-only --inserts --no-owner --no-privileges "$DATABASE_URL" |
     sed -e "/^\\\\restrict /d" -e "/^\\\\unrestrict /d" |
     sha256sum | awk "{print \$1}" > /backup/postgres-data.sha256'
docker run --rm --volume "$EVIDENCE_VOLUME:/source:ro" --mount "type=bind,source=$archive_dir,target=/backup" alpine:3.20 sh -c 'tar -C /source -czf /backup/evidence.tar.gz .'
postgres_sha256=$(sha256sum "$archive_dir/postgres.dump" | awk '{print $1}')
evidence_sha256=$(sha256sum "$archive_dir/evidence.tar.gz" | awk '{print $1}')
evidence_entry_count=$(docker run --rm --volume "$EVIDENCE_VOLUME:/source:ro" alpine:3.20 sh -c 'find /source -mindepth 1 -print | wc -l' | tr -d '[:space:]')
cat > "$archive_dir/manifest.env" <<EOF
FORMAT_VERSION=1
BACKUP_ID=$BACKUP_ID
POSTGRES_DUMP_SHA256=$postgres_sha256
POSTGRES_DATA_SHA256=$(cat "$archive_dir/postgres-data.sha256")
EVIDENCE_TAR_SHA256=$evidence_sha256
EVIDENCE_ENTRY_COUNT=$evidence_entry_count
EOF
trap - HUP INT TERM
printf 'Backup created: %s\n' "$archive_dir"
