# Postgres and evidence-volume backup

`backup.sh` writes a PostgreSQL custom-format dump, an archive of the Docker
evidence volume, and checksums into one immutable backup directory. It reads
operational values from the environment; no credentials are stored in this
repository or printed by the scripts.

On the production host, schedule the following daily through the platform
scheduler/systemd timer, with environment values supplied by the existing
secret mechanism (age/systemd credentials today; OpenBao when adopted):

```sh
BACKUP_DIR=/srv/oikonomos/backups \
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)" \
DATABASE_URL="$DATABASE_URL" \
EVIDENCE_VOLUME=oikonomos-evidence \
./infra/backup/backup.sh
```

`DATABASE_URL` is the production Postgres connection string and
`EVIDENCE_VOLUME` is the Docker volume that stores evidence. The backup host
must provide Linux Docker (the backup uses the pinned `pgvector/pgvector:pg16`
client image with host networking), `sha256sum`, and a durable,
access-restricted `BACKUP_DIR`. Encrypt and replicate that directory using the
production backup service; this task intentionally does not invent a
key-management scheme. Using the pinned client image for both the source and
restored data fingerprints avoids false drill failures from host/container
`pg_dump` minor-version header differences.

`POSTGRES_DUMP_DOCKER_NETWORK` defaults to `host`, which lets the pinned client
reach a database listening on the backup host. Set it only when the database is
on a Docker network instead; `test-drill.sh` does this for its isolated source.

## Restore drill

The drill never uses the production database or evidence volume. It creates a
new Postgres container and a new evidence Docker volume, restores the selected
backup, verifies the database data fingerprint and archive checksums, extracts
the evidence archive, prints `RESTORE_DRILL_VERIFIED`, then deletes its
disposable resources.

```sh
DRILL_POSTGRES_USER="$DRILL_POSTGRES_USER" \
DRILL_POSTGRES_PASSWORD="$DRILL_POSTGRES_PASSWORD" \
DRILL_POSTGRES_DB="$DRILL_POSTGRES_DB" \
BACKUP_DIR=/srv/oikonomos/backups \
BACKUP_ID=20260817T120000Z \
./infra/backup/restore-drill.sh
```

For a fully isolated demonstration (including source data and an evidence
file), run `./infra/backup/test-drill.sh`. It generates an ephemeral password
at runtime and cleans every test container, volume, and temporary backup after
the verified restore. Run this drill before production cutover and after every
material backup-tool change; retain its command output with operations records.
