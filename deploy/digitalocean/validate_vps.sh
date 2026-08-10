#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then
  echo "Missing .env"
  exit 1
fi

set -a
source .env
set +a

API="${INTERNAL_API_KEY:?INTERNAL_API_KEY is required}"
BASE="${BASE_URL:-http://127.0.0.1:4000}"

curl -fsS "${BASE}/health" >/dev/null
curl -fsS "${BASE}/dashboard/trading" >/dev/null
curl -fsS -H "X-API-Key: ${API}" "${BASE}/api/v1/internal/analytics/command-center" >/dev/null
curl -fsS -H "X-API-Key: ${API}" "${BASE}/api/v1/internal/analytics/football-confirmed-pick-chain" >/dev/null
curl -fsS -H "X-API-Key: ${API}" "${BASE}/api/v1/internal/analytics/pilot-checklist" >/dev/null

docker compose --profile odds --profile football-data --profile bi --profile edge ps

./deploy/digitalocean/backup_postgres.sh >/tmp/sports_data_hub_backup_check.log
cat /tmp/sports_data_hub_backup_check.log

echo "vps_validation_passed=true"