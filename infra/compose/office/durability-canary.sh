#!/usr/bin/env sh
# durability-canary: THE liveness assertion for Addendum F §2.2 F2 and §4.3
# F11 (ADR-005 control liveness).
#
# Writes a digest-bearing marker into D1 and into D2, runs a REAL rebuild
# (rebuild.sh — real docker compose recreate, not a simulation), then asserts:
#   (a) the D1 marker is present after rebuild with an IDENTICAL digest, and
#   (b) the D2 marker is GONE after rebuild.
# A canary that only checks the compose file lists a volume is exactly the
# inert-control failure ADR-005 exists for; this one is keyed on evidence the
# volume mount emits by doing its job, never on config being present.
#
# It also asserts D3 absence (§4.3 F11 layer 1, N13) FROM INSIDE office-model
# — the container the model actually runs in, both before and after rebuild
# — proving the secrets path does not exist there at all, not merely that
# some other layer denies reading it.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/../docker-compose.office.yml"
project="${OFFICE_PROJECT:-oikonomos-office-basileia}"
command -v docker >/dev/null

model_container=$(docker compose -p "$project" -f "$compose_file" ps -q office-model)
[ -n "$model_container" ] || { printf 'DURABILITY_CANARY_FAILED: office-model is not running under project %s\n' "$project" >&2; exit 68; }

run_id="canary-$$-${RANDOM:-0}"
d1_digest=$(docker run --rm alpine:3.20 sh -c 'od -An -N16 -tx1 /dev/urandom | tr -d "[:space:]"')
docker exec "$model_container" sh -c "mkdir -p /oikonomos/workspace && printf '%s' \"$d1_digest\" > /oikonomos/workspace/CANARY_D1"
docker exec "$model_container" sh -c "printf '%s' \"$d1_digest\" > /tmp/CANARY_D2"

if docker exec "$model_container" sh -c 'test -e /oikonomos-secrets' 2>/dev/null; then
  printf 'DURABILITY_CANARY_FAILED: D3 path is visible inside office-model (pre-rebuild)\n' >&2
  exit 69
fi

"$script_dir/rebuild.sh" >&2

model_container=$(docker compose -p "$project" -f "$compose_file" ps -q office-model)
d1_after=$(docker exec "$model_container" sh -c 'cat /oikonomos/workspace/CANARY_D1 2>/dev/null' || true)
[ "$d1_after" = "$d1_digest" ] || { printf 'DURABILITY_CANARY_FAILED: D1 marker missing or digest mismatch after rebuild (expected %s, got %s)\n' "$d1_digest" "$d1_after" >&2; exit 69; }

if docker exec "$model_container" sh -c 'test -e /tmp/CANARY_D2' 2>/dev/null; then
  printf 'DURABILITY_CANARY_FAILED: D2 marker survived rebuild — D2 is not disposable\n' >&2
  exit 69
fi

if docker exec "$model_container" sh -c 'test -e /oikonomos-secrets' 2>/dev/null; then
  printf 'DURABILITY_CANARY_FAILED: D3 path is visible inside office-model (post-rebuild)\n' >&2
  exit 69
fi

printf 'DURABILITY_CANARY_VERIFIED run=%s project=%s d1=present(digest-match) d2=absent d3=absent(model)\n' "$run_id" "$project"
