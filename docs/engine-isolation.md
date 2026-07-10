# Aislamiento de motores

`sports-data-hub` es la fuente de verdad de datos deportivos. Su API Fastify
escucha internamente en el puerto `3000`, pero Docker la publica en el host por
el puerto `4000`.

## Puertos

| Componente | Host | Contenedor |
| --- | ---: | ---: |
| Data Hub API | 4000 | 3000 |
| Data Hub PostgreSQL | 5433 | 5432 |
| Data Hub Redis | 6380 | 6379 |

Los servicios dentro de este Compose deben usar:

```text
http://engine-node:3000
postgres://sports_admin:replace_with_local_postgres_password@db-postgres:5432/sports_db
redis://cache-redis:6379
```

Los clientes ejecutados directamente en Windows deben usar:

```text
SPORTS_DATA_HUB_URL=http://localhost:4000
```

Un bot ejecutado dentro de otro Docker Compose debe usar:

```text
SPORTS_DATA_HUB_URL=http://host.docker.internal:4000
```

No uses `localhost:4000` desde otro contenedor: dentro de Docker, `localhost`
apunta al propio contenedor del bot.

## Arranque

```powershell
cd "C:\Users\tsacl\OneDrive\Documentos\New project\sports-data-hub"
docker compose up -d db-postgres cache-redis
docker compose exec -T db-postgres psql -v ON_ERROR_STOP=1 -U sports_admin -d sports_db -f /migrations/003_trading_integrity_and_snapshots.sql
docker compose up -d --build engine-node scraper-soccer scraper-mlb
```

Validacion:

```powershell
Invoke-RestMethod http://localhost:4000/health
docker compose ps
```

La carpeta original `sports-api` queda como respaldo. No levantes ambos
proyectos al mismo tiempo porque comparten los puertos externos `5433` y `6380`.
