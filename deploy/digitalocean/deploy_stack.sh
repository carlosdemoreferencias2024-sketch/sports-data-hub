#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy deploy/digitalocean/env.vps.example to .env and fill secrets first."
  exit 1
fi

set -a
source .env
set +a

: "${INTERNAL_API_KEY:?INTERNAL_API_KEY is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

if [[ "${INTERNAL_API_KEY}" == "change_me_on_vps" || "${POSTGRES_PASSWORD}" == "change_me_on_vps" ]]; then
  echo "Refusing to deploy with placeholder secrets."
  exit 1
fi

mkdir -p backups/postgres

docker compose --profile odds --profile football-data --profile bi --profile edge up -d --build

docker compose --profile odds --profile football-data --profile bi --profile edge ps

echo "deploy_started=true"