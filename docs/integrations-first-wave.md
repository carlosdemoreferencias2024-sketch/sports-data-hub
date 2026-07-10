# First-wave integrations

Prioridad elegida:

1. GitHub
2. DigitalOcean
3. Cloudflare
4. Metabase

## GitHub

Ya queda preparado CI en `.github/workflows/ci.yml`.

El CI corre:

- `npm ci`
- `npm run build`
- `npm test`
- `docker compose config`

Uso recomendado:

- trabajar por ramas
- pull requests pequenos
- no commitear `.env`
- revisar que `audit guardrails passed` siempre pase

## DigitalOcean

DigitalOcean queda como destino natural para correr 24/7.

Ver `deploy/digitalocean/README.md`.

Estado esperado en VPS:

- `engine-node` healthy
- `db-postgres` healthy
- `odds-worker` healthy
- `football-data-worker` healthy si aplica
- dashboard accesible solo detras de Cloudflare

## Cloudflare

Cloudflare debe usarse como puerta segura:

- Tunnel o reverse proxy
- Access login obligatorio
- no exponer Postgres ni Redis

Ver `deploy/cloudflare/README.md`.

## Metabase

Metabase queda integrado como perfil opcional:

```bash
docker compose --profile bi up -d metabase
```

Ver `deploy/metabase/README.md`.

## No incluidos todavia

- Supabase/Neon: esperar hasta decidir migracion real de Postgres.
- Vercel/Netlify: esperar hasta separar frontend/backend.
- PostHog: esperar hasta tener uso multiusuario del dashboard.
- Datadog: esperar hasta estar en produccion 24/7; puede ser caro.

## Guardrails obligatorios

Estos cambios no habilitan apuestas reales:

- dinero real apagado
- Kelly apagado
- Telegram automatico apagado
- `REAL_CANDIDATE = 0`
