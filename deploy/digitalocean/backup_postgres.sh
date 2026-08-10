#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-backups/postgres}"
DB_CONTAINER="${DB_CONTAINER:-data_hub_db}"
POSTGRES_USER="${POSTGRES_USER:-sports_admin}"
POSTGRES_DB="${POSTGRES_DB:-sports_db}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
REMOTE_FILE="/tmp/${POSTGRES_DB}_${STAMP}.dump"
LOCAL_FILE="${BACKUP_DIR}/${POSTGRES_DB}_${STAMP}.dump"

docker exec "$DB_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges --file="$REMOTE_FILE"
docker exec "$DB_CONTAINER" pg_restore --list "$REMOTE_FILE" >/dev/null
docker cp "$DB_CONTAINER:$REMOTE_FILE" "$LOCAL_FILE"
docker exec "$DB_CONTAINER" rm -f "$REMOTE_FILE"
find "$BACKUP_DIR" -name "*.dump" -mtime +"$RETENTION_DAYS" -delete

echo "backup_created=$LOCAL_FILE"
