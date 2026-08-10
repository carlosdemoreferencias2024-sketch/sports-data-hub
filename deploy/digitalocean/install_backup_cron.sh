#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$(pwd)}"
CRON_TIME="${CRON_TIME:-15 3 * * *}"
CRON_CMD="cd ${APP_DIR} && ./deploy/digitalocean/backup_postgres.sh >> backups/postgres/backup.log 2>&1"
CRON_LINE="${CRON_TIME} ${CRON_CMD}"

mkdir -p backups/postgres

( crontab -l 2>/dev/null | grep -v 'backup_postgres.sh' || true; echo "$CRON_LINE" ) | crontab -

crontab -l | grep 'backup_postgres.sh'
echo "backup_cron_installed=true"