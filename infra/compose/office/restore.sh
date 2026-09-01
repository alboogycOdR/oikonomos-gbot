#!/usr/bin/env sh
# restore: reattach the last SYNCED volume snapshot (Grok Bot's "Reset").
#
# THE ONLY OFFICE LIFECYCLE VERB THAT CAN LOSE D1 WRITES: anything written to
# oikonomos-workspace after the snapshot named by SNAPSHOT_ID was taken is
# discarded by this verb. Addendum F §2.3 F3 requires this to be the only
# lifecycle verb that needs an approval; that approval gate is enforced by
# the broker (ADR-004/ADR-007 nonce-bound, single-use), not by this script —
# this script performs the environment side once an approval has already
# cleared. See README.md "restore" section for the full data-loss statement.
set -eu
require() { eval "value=\${$1-}"; [ -n "$value" ] || { printf '%s must be set\n' "$1" >&2; exit 64; }; }
require SNAPSHOT_DIR
require SNAPSHOT_ID
case "$SNAPSHOT_ID" in *[!A-Za-z0-9._-]*|'') printf 'Invalid SNAPSHOT_ID\n' >&2; exit 64;; esac
command -v docker >/dev/null
command -v sha256sum >/dev/null
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/../docker-compose.office.yml"
project="${OFFICE_PROJECT:-oikonomos-office-basileia}"

archive_dir="$SNAPSHOT_DIR/$SNAPSHOT_ID"
manifest="$archive_dir/manifest.env"
for file in "$archive_dir/workspace.tar.gz" "$manifest"; do [ -f "$file" ] || { printf 'Snapshot is incomplete: %s\n' "$file" >&2; exit 66; }; done
FORMAT_VERSION=$(awk -F= '$1 == "FORMAT_VERSION" { print $2 }' "$manifest")
WORKSPACE_TAR_SHA256=$(awk -F= '$1 == "WORKSPACE_TAR_SHA256" { print $2 }' "$manifest")
[ "$FORMAT_VERSION" = 1 ] || { printf 'Unsupported snapshot format\n' >&2; exit 66; }
[ "${#WORKSPACE_TAR_SHA256}" -eq 64 ] || { printf 'Malformed snapshot manifest\n' >&2; exit 66; }
[ "$(sha256sum "$archive_dir/workspace.tar.gz" | awk '{print $1}')" = "$WORKSPACE_TAR_SHA256" ] || { printf 'Snapshot checksum mismatch\n' >&2; exit 66; }

workspace_volume="${project}_oikonomos-workspace"
docker volume inspect "$workspace_volume" >/dev/null

OFFICE_PROJECT="$project" docker compose -p "$project" -f "$compose_file" stop office-model office-browser
docker run --rm --volume "$workspace_volume:/target" alpine:3.20 sh -c 'find /target -mindepth 1 -delete'
docker run --rm --volume "$workspace_volume:/target" --mount "type=bind,source=$archive_dir,target=/backup,readonly" alpine:3.20 sh -c 'tar -C /target -xzf /backup/workspace.tar.gz'
OFFICE_PROJECT="$project" docker compose -p "$project" -f "$compose_file" up -d office-model office-browser

printf 'restore(%s): oikonomos-workspace (D1) reattached from snapshot %s.\n' "$project" "$SNAPSHOT_ID"
printf '  WARNING: any D1 write made after snapshot %s was taken has been LOST. restore is the only Office lifecycle verb that can lose durable (D1) data — this is why it is the only one requiring an approval (F3).\n' "$SNAPSHOT_ID"
printf '  D2 (image layer, packages, /tmp, caches): also discarded, same as rebuild.\n'
printf '  D3 (oikonomos-secrets): NOT touched by this script — unchanged.\n'
