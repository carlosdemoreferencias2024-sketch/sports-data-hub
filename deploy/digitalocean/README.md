# DigitalOcean deployment checklist

Objetivo: correr `sports-data-hub` 24/7 en un VPS sin activar dinero real, Kelly ni Telegram automatico.

## Estado de seguridad obligatorio

Antes, durante y despues del deploy:

- `REAL_CANDIDATE = 0`
- dinero real apagado
- Kelly apagado
- Telegram automatico apagado
- parlays reales apagados
- run line/totals reales bloqueados
- dashboard protegido, no publico sin autenticacion
- Postgres y Redis nunca expuestos a internet

## Droplet recomendado

- Ubuntu 24.04 LTS
- 2 vCPU / 4 GB RAM minimo para empezar
- Disco 80 GB minimo si se conservaran snapshots, logs y backups
- Backups/snapshots de DigitalOcean activados
- Firewall: abrir solo `22`, `80`, `443`
- Mantener `4000`, `5433`, `6380`, health ports de workers y Metabase cerrados al publico

## Primer arranque

```bash
sudo apt update
sudo apt install -y git ca-certificates curl ufw
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Cierra y vuelve a entrar por SSH para que aplique el grupo `docker`.

```bash
git clone <repo-url> sports-data-hub
cd sports-data-hub
cp .env.example .env
```

Edita `.env` con secretos reales. No subas `.env` a GitHub.

## Firewall base

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

## Arranque seguro

```bash
docker compose --profile odds --profile football-data --profile bi up -d --build
docker compose --profile odds --profile football-data --profile bi ps
```

Validaciones:

```bash
curl -f http://127.0.0.1:4000/health
curl -f http://127.0.0.1:4000/dashboard/trading
```

Endpoints internos esperados:

```bash
curl -f -H "X-API-Key: <INTERNAL_API_KEY>" http://127.0.0.1:4000/api/v1/internal/analytics/command-center
curl -f -H "X-API-Key: <INTERNAL_API_KEY>" http://127.0.0.1:4000/api/v1/internal/analytics/football-confirmed-pick-chain
curl -f -H "X-API-Key: <INTERNAL_API_KEY>" http://127.0.0.1:4000/api/v1/internal/analytics/pilot-checklist
```

## Publicacion recomendada

Usar Cloudflare Tunnel hacia `http://127.0.0.1:4000`.

No publiques directamente:

- Postgres `5432/5433`
- Redis `6379/6380`
- Worker health ports
- Metabase sin autenticacion

## Backups PostgreSQL

Local/Windows:

```powershell
scripts\backup_postgres.cmd
```

En VPS Linux, usar el mismo patron con Docker:

```bash
mkdir -p backups/postgres
STAMP=$(date +%Y%m%d_%H%M%S)
docker exec data_hub_db pg_dump -U sports_admin -d sports_db --format=custom --no-owner --no-privileges --file=/tmp/sports_db_${STAMP}.dump
docker exec data_hub_db pg_restore --list /tmp/sports_db_${STAMP}.dump >/dev/null
docker cp data_hub_db:/tmp/sports_db_${STAMP}.dump backups/postgres/sports_db_${STAMP}.dump
docker exec data_hub_db rm -f /tmp/sports_db_${STAMP}.dump
find backups/postgres -name "*.dump" -mtime +14 -delete
```

Cron sugerido:

```bash
crontab -e
```

Agregar:

```cron
15 3 * * * cd /home/<user>/sports-data-hub && mkdir -p backups/postgres && STAMP=$(date +\%Y\%m\%d_\%H\%M\%S) && docker exec data_hub_db pg_dump -U sports_admin -d sports_db --format=custom --no-owner --no-privileges --file=/tmp/sports_db_${STAMP}.dump && docker exec data_hub_db pg_restore --list /tmp/sports_db_${STAMP}.dump >/dev/null && docker cp data_hub_db:/tmp/sports_db_${STAMP}.dump backups/postgres/sports_db_${STAMP}.dump && docker exec data_hub_db rm -f /tmp/sports_db_${STAMP}.dump && find backups/postgres -name "*.dump" -mtime +14 -delete
```

## Operacion diaria MLB

Entry:

```powershell
scripts\run_auto_mlb_real_paper.cmd -Date YYYY-MM-DD -ForceEntry -InternalApiKey <key> -SportsDataIoApiKey <key>
```

Closing:

```powershell
scripts\run_auto_mlb_real_paper.cmd -Date YYYY-MM-DD -ForceClosing -InternalApiKey <key> -SportsDataIoApiKey <key>
```

## Criterio para promover a VPS principal

No considerar el VPS como principal hasta que pase:

- dashboard `/dashboard/trading` responde 200
- `command-center` responde 200
- `pilot-checklist` responde 200
- `football-confirmed-pick-chain` responde 200
- `odds-worker` healthy
- `football-data-worker` healthy
- backup PostgreSQL creado y verificado
- Cloudflare/Access protege el dashboard
- guardrails confirman dinero real OFF, Kelly OFF y Telegram auto OFF

Mientras tanto, la PC local queda como laboratorio y respaldo.

## Compose seguro VPS

En el VPS, copia `deploy/digitalocean/env.vps.example` como base para `.env`. Mantener estos binds:

```env
ENGINE_BIND_ADDRESS=127.0.0.1
POSTGRES_BIND_ADDRESS=127.0.0.1
REDIS_BIND_ADDRESS=127.0.0.1
METABASE_BIND_ADDRESS=127.0.0.1
```

Con esto, `4000`, `5433`, `6380` y `3001` quedan accesibles solo dentro del VPS. Cloudflare Tunnel publica el dashboard sin exponer Postgres ni Redis.

Arranque con tunnel:

```bash
docker compose --profile odds --profile football-data --profile bi --profile edge up -d --build
```

Script VPS de backup incluido:

```bash
chmod +x deploy/digitalocean/backup_postgres.sh
./deploy/digitalocean/backup_postgres.sh
```

## Flujo ejecutable recomendado

En el VPS nuevo:

```bash
sudo APP_USER=$USER bash deploy/digitalocean/bootstrap_vps.sh
```

Cierra y vuelve a entrar por SSH para que aplique el grupo `docker`.

Luego, dentro del repo:

```bash
cp deploy/digitalocean/env.vps.example .env
nano .env
```

No continuar si siguen valores `change_me_on_vps`.

Arrancar stack:

```bash
chmod +x deploy/digitalocean/*.sh
deploy/digitalocean/deploy_stack.sh
```

Instalar backup diario:

```bash
deploy/digitalocean/install_backup_cron.sh
```

Validar que el VPS ya puede ser candidato principal:

```bash
deploy/digitalocean/validate_vps.sh
```

La validacion crea un backup real de prueba y revisa dashboard, endpoints internos y contenedores.

## Cloudflare Access

Para usar el perfil `edge`, primero crea un Tunnel en Cloudflare Zero Trust y pega el token en `.env`:

```env
CLOUDFLARE_TUNNEL_TOKEN=...
```

Despues arranca con:

```bash
docker compose --profile odds --profile football-data --profile bi --profile edge up -d --build
```

Recomendacion: proteger el hostname con Cloudflare Access por correo autorizado. El dashboard no debe quedar publico sin login.