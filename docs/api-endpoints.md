# API Endpoints

Base URL: `/api/v1`

Interactive docs: `/docs`

## Discovery

- `GET /sports`: deportes soportados.
- `GET /leagues?sport={sport_slug}`: ligas activas.
- `GET /teams?league={league_slug}&search={text}`: equipos.

## Matches

- `GET /matches?date=YYYY-MM-DD&league={league_slug}&status=live&team={team_slug_or_abbr}`
- `GET /matches/{id}`
- `GET /matches/{id}/live`
- `GET /leagues/{slug}/table`
- `GET /teams/{slug}/form`
- `GET /teams/{id}/stats`

Los endpoints de partidos fusionan estado vivo desde Redis cuando existe `match:live:{id}`. Si no existe, responden desde Postgres con `source: "postgres_historical"`.

## Internal ingestion

- `POST /api/v1/internal/matches/{id}/live` requiere `X-Internal-API-Key` cuando `API_KEY` esta configurada.
- `POST /internal/live/matches/{id}` queda disponible temporalmente por compatibilidad.
- No usar `HSET` directo en Redis para validar WebSocket. El flujo correcto es publicar por este endpoint, porque Fastify guarda el JSON en Redis y emite por Pub/Sub.

Payload:

```json
{
  "status": "live",
  "period": "7th Inning",
  "clock": null,
  "home_score": 2,
  "away_score": 4,
  "payload": {}
}
```

Ejemplo PowerShell:

```powershell
$body = @{
  status = "live"
  period = "5th Inning"
  home_score = 2
  away_score = 1
  payload = @{ source = "manual-test" }
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:4000/api/v1/internal/matches/{match_id}/live" `
  -Headers @{ "X-Internal-API-Key" = "replace_with_local_internal_api_key" } `
  -ContentType "application/json" `
  -Body $body
```

## WebSockets

- `WS /ws/matches/{id}`

El backend publica en `match_updates:{id}` y mantiene `match:{id}` por compatibilidad.

Mensajes:

```json
{
  "type": "update",
  "data": {
    "match_id": "uuid",
    "status": "live",
    "home_score": 2,
    "away_score": 4,
    "updated_at": "2026-05-25T23:10:00.000Z"
  }
}
```

## Soccer

- `GET /leagues?sport=soccer`
- `GET /teams?league=liga-mx`
- `GET /matches?date=2026-05-25&league=liga-mx`

El fixture local de futbol vive en `workers/fixtures/soccer_scoreboard.html`.

El scraper de futbol puede correr en dos modos:

- `SOCCER_SOURCE_MODE=fixture`: usa el fixture local.
- `SOCCER_SOURCE_MODE=espn`: lee ESPN Mexico con selectores defensivos.

Con `SHADOW_MODE=true`, el scraper solo imprime detecciones en logs y no llama al endpoint batch.

## MLB

- `GET /leagues?sport=baseball`
- `GET /teams?league=mlb`
- `GET /matches?league=mlb`
- `GET /matches?league=mlb&status=live`
- `GET /leagues/mlb/table`

El worker `scraper-mlb` lee ESPN Mexico MLB desde `https://www.espn.com.mx/beisbol/mlb/resultados` y envia los juegos al endpoint batch con `source_slug: "espn-mlb"`.

El parser tambien puede correr contra `workers/fixtures/sample_scoreboard.html` para pruebas locales:

```bash
python mlb_scraper.py --source-mode fixture --fixture fixtures/sample_scoreboard.html --source sample-local --dry-run
```

Para historico:

```bash
python mlb_scraper.py --source-mode espn --source espn-mlb --backfill-date 20260524
python soccer_scraper.py --source-mode espn --source espn-mexico --backfill-date 20260524
python mlb_scraper.py --source-mode espn --source espn-mlb --backfill-days 7
python soccer_scraper.py --source-mode espn --source espn-mexico --backfill-days 7
```

Los scrapers aceptan `BACKFILL_DATE` en formato `YYYYMMDD` o `YYYY-MM-DD`. Tambien aceptan `--backfill-days N` para procesar desde ayer hacia atras, con una pausa corta entre fechas.

## Analytics

El bot analitico se ejecuta como servicio opcional:

```bash
docker compose --profile analytics run --rm analytics-bot
```

Consume:

- `GET /api/v1/leagues/{slug}/table`
- `GET /api/v1/teams/{slug}/form`
- `GET /api/v1/matches?league={slug}&status=scheduled`
- `GET /api/v1/matches?league={slug}&status=live`

El scanner calcula inercia ponderada, ratings ofensivos/defensivos por promedio de liga, probabilidades y EV simulado. Ajustes por entorno:

- `SIMULATED_HOME_ODDS`
- `SIMULATED_AWAY_ODDS`
- `MIN_EV_THRESHOLD`
- `MIN_PLAYED_FOR_SIGNAL`

Si un partido incluye `home_odds`, `away_odds` y `odds_source: "market_odds"`, el scanner puede calcular EV y registrar una operacion. Las cuotas `simulated_odds` y `manual_backfill_odds` solo sirven para analisis en shadow mode y nunca autorizan paper trades.

## Odds

`GET /matches` y `GET /matches/{id}` pueden incluir:

```json
{
  "home_odds": "1.91",
  "away_odds": "2.04",
  "odds_source": "market_odds"
}
```

El endpoint batch acepta esos mismos campos como numeros opcionales:

```json
{
  "matches": [
    {
      "source_slug": "espn-mlb",
      "source_match_id": "example",
      "league_slug": "mlb",
      "match_date": "2026-06-01T20:00:00Z",
      "status": "scheduled",
      "home_alias": "Boston Red Sox",
      "away_alias": "NY Yankees",
      "home_odds": 1.91,
      "away_odds": 2.04,
      "odds_source": "market_odds"
    }
  ]
}
```

Fuentes admitidas:

- `market_odds`: cuota observada de mercado; puede autorizar paper trading.
- `manual_backfill_odds`: cuota agregada manualmente; solo auditoria y pruebas.
- `simulated_odds`: cuota sintetica; solo shadow mode.

## Integridad de trading y snapshots

Para actualizar una base ya existente sin borrar el volumen:

```powershell
docker compose up -d db-postgres
docker compose exec -T db-postgres psql -U sports_admin -d sports_db -f /migrations/003_trading_integrity_and_snapshots.sql
docker compose up -d --build engine-node
```

La migracion permite varias senales por partido usando la identidad compuesta:

```text
(match_id, market_type, selection, model_version)
```

Los trades sin marcador final completo quedan en `PENDING_RESULTS`. La liquidacion centralizada nunca transforma marcadores ausentes en un empate.

Para crear snapshots prepartido del historico:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:4000/api/v1/internal/snapshots/backfill" `
  -Headers @{ "X-Internal-API-Key" = "replace_with_local_internal_api_key" } `
  -ContentType "application/json" `
  -Body '{"limit":5000}'
```

El backtest solo procesa partidos que tengan snapshots y `odds_source: "market_odds"`. Si falta cualquiera de esas evidencias, omite el partido en vez de usar informacion futura o cuotas teoricas.

## Batch Ingestion

- `POST /api/v1/internal/matches/batch`
- Requiere `X-Internal-API-Key: replace_with_local_internal_api_key`.
- Resuelve aliases usando `source_team_aliases`.
- Si un partido llega como `live`, actualiza `match:live:{id}` en Redis y publica por WebSocket.
- Si un partido llega como `finished`, persiste el marcador final en Postgres, borra `match:live:{id}` si existe y publica el cierre una sola vez.

Payload:

```json
{
  "matches": [
    {
      "source_slug": "sample-soccer-local",
      "source_match_id": "sample-soccer-ligamx-001",
      "league_slug": "liga-mx",
      "match_date": "2026-05-25T20:00:00Z",
      "status": "live",
      "home_alias": "Club America",
      "away_alias": "Chivas",
      "home_score": 2,
      "away_score": 1,
      "period": "65'"
    }
  ]
}
```

