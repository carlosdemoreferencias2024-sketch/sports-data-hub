# Roadmap

## Phase 1: Base

- Docker Compose con API, Postgres y Redis.
- Schema SQL y seeds.
- `/health` validando Postgres y Redis.

## Phase 2: Scrapers

- Fixture scraper estable.
- Batch scraper diario por fuente.
- Live scraper activado por partidos en vivo.
- Tabla de errores por corrida.
- Soccer scraper contra ESPN Mexico Liga MX usando `/api/v1/internal/matches/batch`.
- MLB scraper contra ESPN Mexico MLB usando la misma tuberia batch protegida.

## Phase 3: Cache

- Estado live en Redis.
- Pub/Sub por partido.
- Persistencia final a Postgres.

## Phase 4: Public API

- REST historico.
- WebSockets por partido.
- Documentacion OpenAPI.

## Phase 5: Production

- API keys y rate limiting.
- Rotacion de user-agent/proxy para scrapers autorizados.
- Alertas Discord/Telegram/logs.
- VPS con `docker compose up -d --build`.

## Phase 6: Historico y Analitica

- `BACKFILL_DATE` en scrapers ESPN para cargar resultados pasados.
- `--backfill-days` en scrapers ESPN para cargar rangos historicos automaticamente.
- Worker MLB y Soccer soportan fechas historicas sin duplicar partidos.
- Servicio opcional `analytics-bot` consume solo la API publica y genera scanner de oportunidades con inercia, ratings y EV simulado.

## Phase 7: Mercado y EV Real

- `matches.home_odds` y `matches.away_odds` para cuotas programadas, live o cierre.
- Contrato batch acepta cuotas opcionales sin romper scrapers que no las tengan.
- Redis puede entregar cuotas live y Postgres conserva cuotas historicas.
- `analytics-bot` usa cuotas reales cuando existen y fallback simulado cuando no.
