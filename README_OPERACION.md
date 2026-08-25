# README OPERACION

Comandos diarios para operar `sports-data-hub` en modo Shadow Trading.

## 1. Levantar el stack

```powershell
cd "C:\Users\tsacl\OneDrive\Documentos\New project\sports-data-hub"
docker compose up -d --build
docker compose --profile odds up -d --build odds-worker
```

Ver salud:

```powershell
docker compose ps
Invoke-RestMethod -Uri "http://127.0.0.1:4000/health"
```

## 2. Variables locales

No guardes tokens reales en codigo. Usa variables de entorno o `.env` local:

```powershell
$env:INTERNAL_API_KEY = "TU_INTERNAL_KEY"
$env:TELEGRAM_BOT_TOKEN = "TOKEN_ROTADO"
$env:TELEGRAM_CHAT_ID = "CHAT_ID"
```

Si un token fue pegado en un chat o log, rota el token antes de usarlo en real.

## 3. Pipelines de modelo

```powershell
docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport mlb --model-name carlos_v1_mlb --league-slug mlb --include-live
docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport nba --model-name carlos_v1_nba --include-live
docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport football --model-name carlos_v1_football --league-slug liga-mx --include-live
```

## 4. Consultas principales

```powershell
$headers = @{ "X-Internal-API-Key" = $env:INTERNAL_API_KEY }

Invoke-RestMethod `
  -Uri "http://127.0.0.1:4000/api/v1/internal/model-quotes/live-board?limit=20&max_age_minutes=1440" `
  -Headers $headers | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri "http://127.0.0.1:4000/api/v1/internal/model-quotes/performance-summary" `
  -Headers $headers | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri "http://127.0.0.1:4000/api/v1/internal/model-quotes/alpha-opportunities?processed=false&min_ev=0&limit=20" `
  -Headers $headers | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri "http://127.0.0.1:4000/api/v1/internal/model-quotes/alpha-summary" `
  -Headers $headers | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri "http://127.0.0.1:4000/api/v1/internal/model-quotes/smart-selection?min_ev=0.05&max_market_age_minutes=30" `
  -Headers $headers | ConvertTo-Json -Depth 8
```

## 4.1 Dashboard visual

Abre:

```text
http://127.0.0.1:4000/dashboard/trading
```

Pega tu `X-Internal-API-Key` en el campo superior y pulsa `Guardar key`.
El tablero muestra:

- Live Board
- Smart Selection EV+
- Alpha Opportunities pendientes
- Performance por modelo/deporte
- Profit teorico de Paper Trading

## 5. Alpha Manual Shadow Test

Genera una cuota manual `manual_shadow`, corre `alpha_detector.py` y valida que aparezca en `alpha_opportunities`.

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\scripts\manual_shadow_alpha_test.ps1
```

## 6. Notificador Telegram

Dry-run sin enviar Telegram:

```powershell
.\scripts\run-webhook-notifier.ps1 -DryRun -MinEv 0.05
```

Dry-run y marcar como procesado para probar el cierre sin Telegram real:

```powershell
.\scripts\run-webhook-notifier.ps1 -DryRun -MarkProcessed -MinEv 0.05
```

Envio real, solo despues de configurar token rotado y chat:

```powershell
.\scripts\run-webhook-notifier.ps1 -MinEv 0.05
```

## 7. Procesar o resetear Alpha

Marcar una Alpha como procesada:

```powershell
.\scripts\process-alpha-opportunity.ps1 -AlphaId "ALPHA_UUID" -Note "alert_sent"
```

Resetear una Alpha para reprobar alertas:

```powershell
.\scripts\reset-alpha-opportunity.ps1 -AlphaId "ALPHA_UUID" -Note "retest_alert"
```

## 8. Estado recomendado

- Mantener todo en Shadow Trading hasta tener 20-50 predicciones cerradas por deporte.
- No ajustar pesos con muestra pequena.
- No activar Paper Trading automatico hasta validar Telegram y dedupe de Alpha.

## 9. Optimizer y logs compactos

Optimizer separado por deporte:

```powershell
docker compose --profile odds exec -T odds-worker python optimizer.py --model-name carlos_v1_mlb --sport baseball --dry-run
docker compose --profile odds exec -T odds-worker python optimizer.py --model-name carlos_v1_nba --sport basketball --dry-run
docker compose --profile odds exec -T odds-worker python optimizer.py --model-name carlos_v1_football --sport soccer --dry-run
```

Pipeline con resumen compacto:

```powershell
docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport football --model-name carlos_v1_football --league-slug liga-mx --include-live --compact-logs
```

## 10. Futbol multiliga

El scraper de futbol puede leer varias ligas ESPN en una sola corrida usando `SOCCER_LEAGUE_CONFIGS`.
Formato:

```text
league_slug|source_slug|heading|url;league_slug|source_slug|heading|url
```

La configuracion default en `docker-compose.yml` incluye estas ligas y corre cada 5 minutos:

- `liga-mx`
- `mls`
- `premier-league`
- `la-liga`
- `serie-a`
- `bundesliga`
- `ligue-1`
- `uefa-champions-league`
- `fifa-world-cup-2026`

Antes de activar produccion, aplica la migracion de fuentes:

```powershell
docker compose exec -T db-postgres psql -U sports_admin -d sports_db -f /migrations/012_soccer_multileague_sources.sql
```

Prueba en sombra sin insertar:

```powershell
docker compose exec -T scraper-soccer python soccer_scraper.py --source-mode espn --shadow-mode --league-configs "liga-mx|espn-mexico|Liga MX|https://www.espn.com.mx/futbol/resultados/_/liga/mex.1;mls|espn-mls|MLS|https://www.espn.com.mx/futbol/resultados/_/liga/usa.1"
```

Ejecutar una liga especifica en el pipeline:

```powershell
docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport football --model-name carlos_v1_football --league-slug liga-mx --include-live --compact-logs
docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport football --model-name carlos_v1_football --league-slug mls --include-live --compact-logs
docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport football --model-name carlos_v1_football --league-slug premier-league --include-live --compact-logs
docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport football --model-name carlos_v1_football --league-slug serie-a --include-live --compact-logs
docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport football --model-name carlos_v1_football --league-slug bundesliga --include-live --compact-logs
docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport football --model-name carlos_v1_football --league-slug ligue-1 --include-live --compact-logs
docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport football --model-name carlos_v1_football --league-slug uefa-champions-league --include-live --compact-logs
docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport football --model-name carlos_v1_football --league-slug fifa-world-cup-2026 --include-live --compact-logs
```

Nota operativa: si el scraper devuelve `Alias no reconocido`, no es fallo de arquitectura. Significa que falta mapear ese equipo en `source_team_aliases` para la fuente ESPN de esa liga. Ese bloqueo protege la base contra equipos mal identificados.

## 11. Alpha -> Paper Trading

Crear paper trades automaticamente cuando Alpha detecte EV+:

```powershell
docker compose --profile odds exec -T odds-worker python alpha_detector.py --model-name carlos_v1_football --min-ev 0.05 --auto-paper --stake-mode flat --flat-fraction 0.01
```

Tambien se puede activar desde el pipeline:

```powershell
docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport football --model-name carlos_v1_football --league-slug fifa-world-cup-2026 --include-live --compact-logs --auto-paper --stake-mode flat --flat-fraction 0.01
```

Staking:

- `flat`: usa una unidad fija teorica. Recomendado al inicio: `--flat-fraction 0.01`.
- `kelly`: usa Kelly fraccional. Activarlo despues de tener muestra suficiente: `--stake-mode kelly --kelly-fraction 0.25 --max-fraction 0.02`.

## 11.1 Mercados de futbol soportados

El motor Poisson de futbol genera estos mercados en `model_quotes`:

- `moneyline_3way`: `home`, `draw`, `away`
- `draw_no_bet`: `home`, `away`
- `total_goals_2_5`: `over`, `under` con `line=2.5`
- `btts`: `yes`, `no`

Para alimentar cuotas manual shadow usa `/api/v1/internal/quotes` con `market_type`, `line` si aplica, y mapea la seleccion a las columnas compatibles:

- `home_odds`: `home`, `over` o `yes`
- `away_odds`: `away`, `under` o `no`
- `draw_odds`: `draw`

Despues corre Alpha con paper flat:

```powershell
docker compose --profile odds exec -T odds-worker python alpha_detector.py --model-name carlos_v1_football --min-ev 0.05 --auto-paper --stake-mode flat --flat-fraction 0.01
```

## 12. Settlement de Paper Trading

Cerrar paper trades pendientes cuando `matches` ya tenga resultados finales:

```powershell
docker compose --profile odds exec -T odds-worker python settle_paper_trades.py --dry-run
docker compose --profile odds exec -T odds-worker python settle_paper_trades.py
```

El settlement tambien se dispara desde la ingesta cuando un partido pasa a `finished`.

## 13. Guardrail de muestra

El optimizer no persiste cambios si la muestra es menor a 20 partidos por defecto:

```powershell
docker compose --profile odds exec -T odds-worker python optimizer.py --model-name carlos_v1_football --sport soccer --min-sample-to-persist 20
```

Recomendacion operativa: acumular 20-50 predicciones cerradas por deporte/liga antes de ajustar pesos.

## 14. Contrato operativo vigente

El contrato vigente de futbol esta en `docs/FOOTBALL_TECHNICAL_CONTRACT.md` y prevalece sobre ejemplos historicos de este README.

- No usar `--auto-paper` para saltar Candidate Preflight.
- Kelly, dinero real, Telegram auto y autopost permanecen apagados.
- Solo se permite un foco por deporte y ventana.
- Ningun registro post-kickoff puede volver a clasificarse como pregame o clean-v2.
- Validar el reloj con `scripts\get_dual_sport_clock_status.ps1 -Strict`.

Las secciones Alpha y staking anteriores se conservan como referencia historica del prototipo; no son el flujo autorizado para futbol, MLB, NFL ni NBA.
