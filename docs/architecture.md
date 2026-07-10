# Architecture

## Runtime

`docker-compose.yml` levanta tres servicios:

- `engine-node`: Fastify REST + WebSocket.
- `db-postgres`: datos historicos y catalogos.
- `cache-redis`: marcadores en vivo, Pub/Sub y rate-limit futuro.

## Data Flow

1. Worker batch lee calendario/resultados desde una fuente.
2. El normalizador traduce aliases externos a `team_id` usando `source_team_aliases`.
3. Resultados finales o programados se guardan en Postgres.
4. Worker live actualiza `match:live:{id}` en Redis.
5. API lee Redis para estado vivo y publica eventos WebSocket con canal `match:{id}`.
6. Cuando un partido termina, el estado final se persiste en Postgres y se limpia Redis.

## Model

El modelo central sigue:

`sports -> leagues -> seasons -> matches -> match_competitors`

Las estadisticas multideporte viven en `JSONB` para que baseball, basketball, soccer y otros deportes puedan avanzar sin cambiar columnas en cada fase.

## External Projects

Los repos importados se mantienen como referencias:

- `scoreboard-api`: polling y formato de scoreboard.
- `Public-ESPN-API`: entidades deporte/liga/equipo/evento/competidor.
- `sportsipy`: parsing y estructuras por deporte.
- `sport-api-specifications`: documentacion OpenAPI.
- Betting bots: fase posterior de picks/trading, no base de datos core.
