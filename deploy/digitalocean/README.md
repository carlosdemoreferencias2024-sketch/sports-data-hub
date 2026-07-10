# DigitalOcean deployment checklist

Objetivo: correr `sports-data-hub` 24/7 en un VPS sin activar dinero real, Kelly ni Telegram automatico.

## Droplet recomendado

- Ubuntu LTS
- 2 vCPU / 4 GB RAM minimo para empezar
- Disco 80 GB si se conservaran snapshots y logs
- Firewall: abrir solo `22`, `80`, `443`; mantener `4000`, `5433`, `6380` cerrados al publico

## Primer arranque

```bash
sudo apt update
sudo apt install -y git ca-certificates curl
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

## Arranque seguro

```bash
docker compose --profile odds --profile football-data up -d --build
docker compose --profile odds ps
```

Validaciones:

```bash
curl -f http://127.0.0.1:4000/health
curl -f http://127.0.0.1:4000/dashboard/trading
```

## Reglas de seguridad

- `REAL_CANDIDATE` debe permanecer en `0` hasta autorizacion explicita.
- No activar Kelly.
- No activar Telegram automatico.
- No exponer Postgres ni Redis a internet.
- Usar Cloudflare Tunnel o reverse proxy con autenticacion para el dashboard.

## Operacion diaria MLB

Entry:

```powershell
scripts\run_auto_mlb_real_paper.cmd -Date YYYY-MM-DD -ForceEntry -InternalApiKey <key> -SportsDataIoApiKey <key>
```

Closing:

```powershell
scripts\run_auto_mlb_real_paper.cmd -Date YYYY-MM-DD -ForceClosing -InternalApiKey <key> -SportsDataIoApiKey <key>
```
