#!/usr/bin/env sh
# snapshot: capture the current oikonomos-workspace (D1) volume contents into
# SNAPSHOT_DIR/SNAPSHOT_ID, for later use by restore.sh. Not one of the four
# Addendum F §2.3 lifecycle verbs itself — it produces restore's input, the
# "last SYNCED volume snapshot".
set -eu
require() { eval "value=\${$1-}"; [ -n "$value" ] || { printf '%s must be set\n' "$1" >&2; exit 64; }; }
require SNAPSHOT_DIR
require SNAPSHOT_ID
case "$SNAPSHOT_ID" in *[!A-Za-z0-9._-]*|'') printf 'Invalid SNAPSHOT_ID\n' >&2; exit 64;; esac
command -v docker >/dev/null
command -v sha256sum >/dev/null
project="${OFFICE_PROJECT:-oikonomos-office-basileia}"
workspace_volume="${project}_oikonomos-workspace"
docker volume inspect "$workspace_volume" >/dev/null

archive_dir="$SNAPSHOT_DIR/$SNAPSHOT_ID"
[ ! -e "$archive_dir" ] || { printf 'Refusing to overwrite existing snapshot: %s\n' "$archive_dir" >&2; exit 65; }
umask 077
mkdir -p "$archive_dir"
docker run --rm --volume "$workspace_volume:/source:ro" --mount "type=bind,source=$archive_dir,target=/backup" alpine:3.20 sh -c 'tar -C /source -czf /backup/workspace.tar.gz .'
workspace_sha256=$(sha256sum "$archive_dir/workspace.tar.gz" | awk '{print $1}')
cat > "$archive_dir/manifest.env" <<EOF
FORMAT_VERSION=1
SNAPSHOT_ID=$SNAPSHOT_ID
WORKSPACE_TAR_SHA256=$workspace_sha256
EOF

printf 'snapshot(%s): oikonomos-workspace (D1) captured to %s\n' "$project" "$archive_dir"
