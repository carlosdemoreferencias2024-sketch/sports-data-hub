# Sports API

API deportiva autonoma multideporte con Postgres para historicos, Redis para estado en vivo, Fastify para REST/WebSockets y workers propios para ingestion.

## Stack

- Backend: Node.js + TypeScript + Fastify
- Database: PostgreSQL
- Live cache: Redis
- Workers: Python + BeautifulSoup, con fixtures locales y modo ESPN por fuente
- Runtime local: Docker Compose

## Quick start

```bash
docker compose up --build
```

Servicios:

- API: `http://localhost:4000`
- Postgres: `localhost:5433`
- Redis: `localhost:6380`
- OpenAPI docs: `http://localhost:4000/docs`

## Endpoints iniciales

- `GET /health`
- `GET /api/v1/sports`
- `GET /api/v1/leagues?sport=baseball`
- `GET /api/v1/teams?league=mlb`
- `GET /api/v1/matches?league=mlb&status=live`
- `GET /api/v1/matches?date=2026-05-25&league=mlb&status=scheduled`
- `GET /api/v1/matches/:id`
- `GET /api/v1/leagues/:slug/table`
- `GET /api/v1/teams/:slug/form`
- `GET /api/v1/teams/:id/stats`
- `WS /ws/matches/:id`

## Workers

El MVP incluye scrapers contra fixtures HTML locales para validar parsing y normalizacion sin depender de internet:

```bash
cd workers
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python batch_scraper.py --fixture fixtures/sample_scoreboard.html --source sample-local --api-url http://localhost:4000/api/v1/internal/matches/batch --api-key replace_with_local_internal_api_key
python soccer_scraper.py --fixture fixtures/soccer_scoreboard.html --source sample-soccer-local --dry-run
python soccer_scraper.py --source-mode espn --source espn-mexico --shadow-mode
python mlb_scraper.py --source-mode fixture --fixture fixtures/sample_scoreboard.html --source sample-local --dry-run
python mlb_scraper.py --source-mode espn --source espn-mlb --shadow-mode
python mlb_scraper.py --source-mode espn --source espn-mlb --backfill-date 20260524
python mlb_scraper.py --source-mode espn --source espn-mlb --backfill-days 7
```

Los servicios Docker `scraper-soccer` y `scraper-mlb` arrancan contra ESPN Mexico con `SHADOW_MODE=false`, por lo que envian datos al backend por `/api/v1/internal/matches/batch` usando `X-Internal-API-Key`.

Para auditar los workers:

```bash
docker compose logs -f scraper-soccer
docker compose logs -f scraper-mlb
```

Si necesitas probar un parser sin escribir en Postgres, ejecuta el worker con `--shadow-mode` o cambia la variable `SHADOW_MODE`/`MLB_SHADOW_MODE` a `true`.

Para alimentar historico usa `--backfill-date YYYYMMDD`, `BACKFILL_DATE=YYYYMMDD`, o `--backfill-days N` para recorrer automaticamente desde ayer hacia atras. El worker cambia la URL de ESPN a la fecha indicada y conserva `source_match_id` estable por dia, asi que repetir el comando actualiza en vez de duplicar.

Ejemplo desde Docker:

```bash
docker compose exec -T scraper-mlb python mlb_scraper.py --source-mode espn --source espn-mlb --backfill-date 20260524
docker compose exec -T scraper-soccer python soccer_scraper.py --source-mode espn --source espn-mexico --backfill-date 20260524
docker compose exec -T scraper-mlb python mlb_scraper.py --source-mode espn --source espn-mlb --backfill-days 7
docker compose exec -T scraper-soccer python soccer_scraper.py --source-mode espn --source espn-mexico --backfill-days 7
```

## Analytics

El servicio opcional `analytics-bot` consume solo la API publica. No toca Postgres ni Redis directamente.

```bash
docker compose --profile analytics run --rm analytics-bot
```

Genera un scanner de oportunidades usando:

- Inercia ponderada de forma reciente.
- Rating ofensivo/defensivo ajustado por promedio de liga.
- Probabilidad estimada local/visitante.
- EV real cuando `/matches` trae `home_odds` y `away_odds`.
- EV simulado como fallback con cuotas decimales configurables.

Variables utiles:

- `SIMULATED_HOME_ODDS=2.00`
- `SIMULATED_AWAY_ODDS=2.00`
- `MIN_EV_THRESHOLD=0.00`
- `MIN_PLAYED_FOR_SIGNAL=2`

## Odds

El contrato batch acepta cuotas opcionales:

```json
{
  "home_odds": 1.91,
  "away_odds": 2.04
}
```

La API expone esos campos en `/api/v1/matches` y `/api/v1/matches/:id`. Si un partido esta vivo, Redis puede entregar cuotas frescas con `source: "redis_live"`; si no, Postgres mantiene las cuotas historicas o programadas.

Los scrapers intentan detectar contenedores tipo `Odds` o `Line` de forma defensiva. Si no encuentran cuotas, envian `null` y la ingesta sigue normal.

El historico desacoplado de mercado vive en `market_quotes`. Los workers de cuotas
pueden insertar snapshots mediante `POST /api/v1/internal/quotes`, y los consumidores
leen la cuota fresca con `GET /api/v1/internal/matches/:matchId/latest-quotes`.
Ambas rutas requieren `X-Internal-API-Key`.

El worker desacoplado de cuotas se activa con el profile `odds`:

```bash
ODDS_SOURCE_URL=https://proveedor/quotes docker compose --profile odds up -d odds-worker
```

La fuente puede entregar una lista o un objeto con `quotes`, `items`, `events`,
`response`, `results` o `data`. Cada fila debe incluir `hub_match_id`/`match_id`, o la
combinacion exacta `league_slug + home_team + away_team`, ademas de las cuotas.
El Hub descarta automaticamente snapshots identicos al ultimo registrado.
El worker expone `/health` dentro del contenedor y reporta `stale` si una fuente
configurada pasa mas de `ODDS_WORKER_STALE_SECONDS` sin producir una cuota.

Para BetsAPI Bet365 por RapidAPI, el worker usa primero `Upcoming Events`, enlaza
solo partidos activos del Hub y despues consulta `PreMatch Odds` por `FI`. La
clave se pasa por entorno y nunca se guarda en el repositorio:

```powershell
$env:ODDS_SOURCE_MODE="betsapi_bet365"
$env:ODDS_SOURCE_URL="https://betsapi2.p.rapidapi.com/v1/bet365/upcoming?sport_id=1"
$env:ODDS_SOURCE_DETAIL_URL="https://betsapi2.p.rapidapi.com/v3/bet365/prematch"
$env:ODDS_SOURCE_PROVIDER="bet365_betsapi"
$env:ODDS_SOURCE_API_KEY_HEADER="x-rapidapi-key"
$env:ODDS_SOURCE_API_KEY="<rapidapi-key>"
$env:ODDS_SOURCE_HOST="betsapi2.p.rapidapi.com"
docker compose --profile odds up -d --build odds-worker
```

Por defecto se excluye esports y se limita el numero de consultas PreMatch por
ciclo mediante `ODDS_SOURCE_MAX_DETAIL_REQUESTS`. `ODDS_SOURCE_MAX_PAGES`
controla cuantas paginas de Upcoming se inspeccionan para encontrar coincidencias.
Las llamadas de detalle se espacian con `ODDS_SOURCE_DETAIL_DELAY_SECONDS` para
respetar limites de RapidAPI.

Los workers comparten `workers/base_worker.py`, que centraliza HTTP, POST al Hub
y reintentos con exponential backoff. Respeta `Retry-After` y reintenta `429` y
errores `5xx` sin que un proveedor bloquee a los demas.

El adaptador aislado `football-data-worker` se puede iniciar con:

```powershell
docker compose --profile football-data up -d --build football-data-worker
```

Este adaptador permanece `data-only`: no publica en `market_quotes` hasta que
`FOOTBALL_DATA_URL` sea un endpoint confirmado de cuotas. Endpoints de jugadores,
fixtures o resultados no se convierten artificialmente en precios de mercado.

## Rosetta Stone de proveedores

Los workers resuelven identidad por `provider_event_mappings` antes de publicar
cuotas. Si ven eventos que el Hub no conoce, los guardan en `raw_provider_events`
para revision:

```powershell
Invoke-RestMethod `
  -Uri "http://127.0.0.1:4000/api/v1/internal/mappings/unmapped?provider=bet365_betsapi" `
  -Headers @{ "X-Internal-API-Key" = $env:INTERNAL_API_KEY }
```

Para mapear uno:

```powershell
.\scripts\map-provider-event.ps1 `
  -ProviderName "bet365_betsapi" `
  -ProviderEventId "195731196" `
  -HubMatchId "043fa077-1902-4de5-be3e-218134dd59dd" `
  -HomeTeamName "ATL Braves" `
  -AwayTeamName "TOR Blue Jays" `
  -Kickoff "2026-06-04T16:43:26Z"
```

## Model-Only Trading Lab

Cuando no haya proveedor de cuotas, el Hub puede generar precios internos en
`model_quotes`.

Genera una plantilla con partidos mapeados:

```powershell
docker compose run --rm odds-worker python generate_stats_template.py --output /app/stats_input_template.csv
```

O desde Windows, usando Postgres expuesto en `localhost:5433`:

```powershell
cd "C:\Users\tsacl\OneDrive\Documentos\New project\sports-data-hub\workers"
python generate_stats_template.py --output stats_input_template.csv
```

Rellena ERA/WHIP y, opcionalmente, OPS/bullpen ERA. Luego ingesta:

```powershell
python ingest_stats.py --input stats_input.csv --model-name carlos_v1_mlb
```

Consulta oportunidades internas frescas:

```powershell
Invoke-RestMethod `
  -Uri "http://127.0.0.1:4000/api/v1/internal/model-quotes/opportunities?min_confidence=0.20" `
  -Headers @{ "X-Internal-API-Key" = $env:INTERNAL_API_KEY }
```

Este flujo no usa cuotas externas. Produce `MODEL_ONLY` con fair odds propias.
El worker primero resuelve identidad por `provider_event_mappings`. El
emparejamiento por nombres queda bloqueado salvo que se habilite explicitamente
`ODDS_SOURCE_ALLOW_DISCOVERY_MATCH=true`; si ademas se habilita
`ODDS_SOURCE_ALLOW_REVERSED_MATCH=true`, el worker intercambia las cuotas antes
de persistirlas.

## Tiempo real

Para validar WebSocket, abre `ws://localhost:4000/ws/matches/{match_id}` y publica una actualizacion por el endpoint interno:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:4000/api/v1/internal/matches/{match_id}/live" `
  -Headers @{ "X-Internal-API-Key" = "replace_with_local_internal_api_key" } `
  -ContentType "application/json" `
  -Body '{"status":"live","period":"65''","home_score":2,"away_score":1,"payload":{"source":"manual-test"}}'
```

No uses `HSET` directo como prueba principal: el backend guarda JSON en Redis y publica eventos WebSocket con Pub/Sub.

Cuando `/api/v1/internal/matches/batch` recibe un partido `finished`, el backend deja el marcador final persistido en Postgres y limpia `match:live:{id}` de Redis si existia. Los partidos `live` se sirven como `source: "redis_live"`; los terminados o historicos como `source: "postgres_historical"`.

## Seguridad

Las rutas internas `/api/v1/internal/*` y `/internal/*` requieren `X-Internal-API-Key`. Docker Compose define la misma clave en `engine-node`, `scraper-soccer` y `scraper-mlb` para que los workers puedan entrar y los clientes anonimos reciban `401`.

Los endpoints publicos tienen rate limit por IP usando Redis:

- `RATE_LIMIT_MAX=60`
- `RATE_LIMIT_WINDOW=1 minute`

## Notas de diseno

Los zips externos se usan como referencia conceptual, no como dependencias. La normalizacion propia se apoya en tablas `source_team_aliases` y `source_match_refs` para mapear nombres externos hacia IDs internos.

