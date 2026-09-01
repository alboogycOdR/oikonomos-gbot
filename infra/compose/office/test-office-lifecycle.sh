#!/usr/bin/env sh
# Self-contained demonstration/test of the Office lifecycle scripts and the
# durability canary, using a disposable, isolated compose project so it never
# touches a real tenant Office. Run this before relying on any change to
# infra/compose/docker-compose.office.yml or infra/compose/office/**.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/../docker-compose.office.yml"
export OFFICE_PROJECT="oikonomos-office-test-$$-${RANDOM:-0}"
snapshot_dir=$(mktemp -d)
cleanup() {
  docker compose -p "$OFFICE_PROJECT" -f "$compose_file" down -v >/dev/null 2>&1 || true
  rm -rf "$snapshot_dir"
}
trap cleanup EXIT HUP INT TERM

"$script_dir/provision.sh"
"$script_dir/durability-canary.sh"

# recover drill: office-model must come back reachable with D1 intact.
"$script_dir/recover.sh" >&2
model_container=$(docker compose -p "$OFFICE_PROJECT" -f "$compose_file" ps -q office-model)
[ "$(docker exec "$model_container" sh -c 'cat /oikonomos/workspace/CANARY_D1')" != '' ] || { printf 'OFFICE_TEST_FAILED: recover lost the D1 marker\n' >&2; exit 1; }

# restore drill: snapshot D1, write a further D1 marker, restore, and confirm
# the post-snapshot marker is gone while the pre-snapshot marker survives —
# restore is the one verb allowed to lose D1 writes, and only writes made
# after the snapshot.
SNAPSHOT_DIR="$snapshot_dir" SNAPSHOT_ID=drill "$script_dir/snapshot.sh"
docker exec "$model_container" sh -c 'printf "post-snapshot\n" > /oikonomos/workspace/POST_SNAPSHOT'
SNAPSHOT_DIR="$snapshot_dir" SNAPSHOT_ID=drill "$script_dir/restore.sh"
model_container=$(docker compose -p "$OFFICE_PROJECT" -f "$compose_file" ps -q office-model)

if docker exec "$model_container" sh -c 'test -e /oikonomos/workspace/POST_SNAPSHOT' 2>/dev/null; then
  printf 'OFFICE_TEST_FAILED: restore did not lose the post-snapshot D1 write\n' >&2
  exit 1
fi
if ! docker exec "$model_container" sh -c 'test -e /oikonomos/workspace/CANARY_D1' 2>/dev/null; then
  printf 'OFFICE_TEST_FAILED: restore lost the pre-snapshot D1 marker too\n' >&2
  exit 1
fi

printf 'OFFICE_LIFECYCLE_TEST_PASSED\n'
