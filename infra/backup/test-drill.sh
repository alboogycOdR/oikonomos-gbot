#!/usr/bin/env sh
# Demonstrates a clean-environment restore using disposable Docker resources.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work_dir=$(mktemp -d)
suffix="$$-${RANDOM:-0}"
source_container="oikonomos-backup-test-source-$suffix"
source_evidence="oikonomos-backup-test-evidence-$suffix"
source_network="oikonomos-backup-test-network-$suffix"
# Keep the demonstration self-contained: the backup scripts require Docker,
# not a host OpenSSL installation.
test_password=$(docker run --rm alpine:3.20 sh -c 'od -An -N24 -tx1 /dev/urandom | tr -d "[:space:]"')
cleanup() { docker rm -f "$source_container" >/dev/null 2>&1 || true; docker volume rm "$source_evidence" >/dev/null 2>&1 || true; docker network rm "$source_network" >/dev/null 2>&1 || true; rm -rf "$work_dir"; }
trap cleanup EXIT HUP INT TERM
docker volume create "$source_evidence" >/dev/null
docker network create "$source_network" >/dev/null
docker run --rm --volume "$source_evidence:/evidence" alpine:3.20 sh -c 'printf "evidence-payload\n" > /evidence/proof.txt'
docker run -d --rm --name "$source_container" --network "$source_network" -e POSTGRES_USER=drill_user -e POSTGRES_PASSWORD="$test_password" -e POSTGRES_DB=drill_db pgvector/pgvector:pg16 >/dev/null
until docker exec -e PGPASSWORD="$test_password" "$source_container" psql -h 127.0.0.1 -U drill_user -d drill_db -c 'SELECT 1' >/dev/null 2>&1; do sleep 1; done
docker exec -e PGPASSWORD="$test_password" "$source_container" psql -U drill_user -d drill_db -v ON_ERROR_STOP=1 -c "CREATE TABLE drill_proof (id integer PRIMARY KEY, note text NOT NULL); INSERT INTO drill_proof VALUES (1, 'backup-restore');" >/dev/null
BACKUP_DIR="$work_dir" BACKUP_ID=drill DATABASE_URL="postgresql://drill_user:$test_password@$source_container:5432/drill_db" POSTGRES_DUMP_DOCKER_NETWORK="$source_network" EVIDENCE_VOLUME="$source_evidence" sh "$script_dir/backup.sh"
DRILL_POSTGRES_USER=drill_user DRILL_POSTGRES_PASSWORD="$test_password" DRILL_POSTGRES_DB=drill_db BACKUP_DIR="$work_dir" BACKUP_ID=drill sh "$script_dir/restore-drill.sh"
printf 'BACKUP_RESTORE_DRILL_TEST_PASSED\n'
