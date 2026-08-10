#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-$USER}"
SSH_PORT="${SSH_PORT:-22}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo APP_USER=$APP_USER bash deploy/digitalocean/bootstrap_vps.sh"
  exit 1
fi

apt-get update
apt-get install -y git ca-certificates curl ufw

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

usermod -aG docker "$APP_USER"

ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose

echo "bootstrap_complete=true"
echo "Next: log out/in, clone repo, create .env, then run deploy_stack.sh"