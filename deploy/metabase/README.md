# Metabase BI

Metabase se agrega como perfil opcional `bi`.

## Levantar Metabase

```bash
docker compose --profile bi up -d metabase
```

Abrir:

```text
http://127.0.0.1:3001
```

## Conexion a PostgreSQL del hub

Desde el wizard de Metabase:

- Database type: PostgreSQL
- Host: `db-postgres`
- Port: `5432`
- Database name: `sports_db`
- Username: `sports_admin`
- Password: el valor configurado en Docker/.env

## Dashboards recomendados

1. MLB Real Paper
   - cerradas
   - win rate
   - profit
   - CLV promedio
   - underdogs vs favorites

2. CLV Lab
   - CLV por mercado
   - CLV por provider
   - CLV por rango de cuota

3. Football Today Universe
   - fixtures observados
   - market snapshots
   - shadow candidates
   - conversion observado -> candidato -> pick

4. No Bet Intelligence
   - razones de bloqueo
   - stale line
   - mercado no listo
   - provider sospechoso

## Seguridad

No uses Metabase para ejecutar acciones operativas. Solo lectura y analisis.
