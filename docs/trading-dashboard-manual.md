# Manual rapido del Trading Dashboard

Este dashboard no es una pantalla para apostar dinero real. Es una cabina de control para decidir si un mercado ya merece mas revision. La regla actual es: Real Paper y Shadow solamente. Kelly, dinero real, Telegram automatico, parlays reales, run line real y totals real siguen apagados.

## 1. Lectura en 60 segundos

Empieza siempre arriba:

1. Data Health
   - REAL_CANDIDATE debe estar en 0.
   - REAL_PAPER_CANDIDATE puede aparecer solo con provider real y MLB Moneyline.
   - REVIEW no es malo: significa que el sistema encontro algo que necesita filtro.

2. CLV Lab / Timing Engine
   - CLV positivo significa que el pick vencio al cierre.
   - Profit positivo sin CLV positivo puede ser suerte.
   - CLV positivo con profit positivo es la senal que buscamos.

3. Edge Quality
   - A: excelente para revisar en Real Paper.
   - B: fuerte, pero aun requiere contexto.
   - C: radar/observacion.
   - D/F: no se usa para avanzar.

4. Pilot Checklist
   - NO_REAL_MONEY o PILOT_READY_BUT_LOCKED significa que seguimos bloqueados para dinero real.
   - Aunque aparezca READY, se requiere autorizacion manual explicita.

## 2. Estados principales

| Estado | Significado | Accion |
| --- | --- | --- |
| REAL_CANDIDATE | Reservado para dinero real futuro | Debe permanecer en 0 |
| REAL_PAPER_CANDIDATE | Cuota real, stake simulado | Medir CLV/profit, no apostar |
| RADAR_ONLY | Shadow/manual/paper | Sirve para aprendizaje |
| REVIEW | Hay una bandera tecnica o de mercado | Revisar razon antes de confiar |
| NO_BET | El sistema descarto el pick | No forzar apuesta |

## 3. Metricas que si importan

### CLV
Closing Line Value. Mide si tomaste mejor precio que el cierre.

- CLV positivo: entraste mejor que el cierre.
- CLV negativo: el mercado se movio contra ti.
- CLV positivo sostenido es mas importante que una racha corta de wins.

### Profit flat
Ganancia simulada usando stake plano. Sirve para comparar reglas sin Kelly.

### Brier
Mide si la probabilidad del modelo esta bien calibrada. Mas bajo es mejor.

### Win rate
Util, pero no suficiente. Un win rate alto con cuotas bajas puede no tener valor.

### Edge Quality Score
Score 0-100 que combina EV, CLV, provider, mercado aprobado, frescura, muestra historica, calibracion y flags negativos.

## 4. Como leer cada seccion

### Data Health
Confirma que el sistema esta sano:
- REAL_CANDIDATE = 0.
- Providers reales activos.
- Processed true/false.
- Tipos de REVIEW.

### Internal Odds Hub
Muestra las capturas internas de cuotas:
- Provider.
- Bookmaker.
- Snapshots entry/closing.
- Quality score.

### Provider Scorecard
Evalua si un provider es confiable.
- ACTIVE_CLEAN: usable para Real Paper.
- WATCH/REVIEW: no promover todavia.

### CLV Lab
Lee esto antes que profit:
- N: muestra.
- CLV promedio.
- CLV+ rate.
- Profit.
- Decision.

### Edge Quality Score
Prioriza picks por calidad. A/B son buenos para revisar, pero no autorizan dinero real.

### Pick Explainability
Explica por que un pick paso o no paso:
- approval_rules_passed.
- blocking_rules.
- explanation_text.

### Timing Engine
Dice en que ventana de entrada se comporta mejor la estrategia:
- 24h, 12h, 6h, 1h, closing.
- best_entry_window y worst_entry_window.

### Line Movement Radar
Detecta movimiento de linea:
- STEAM_FAVORABLE: mercado se movio a favor.
- STEAM_AGAINST: mercado se movio en contra.
- STALE_LINE: linea vieja.
- SUSPICIOUS_PROVIDER_MOVE: movimiento raro.

### Auto Research Lab
Prueba combinaciones de reglas automaticamente.

Recomendaciones:
- PROMOTE: candidata a watchlist/revision.
- WATCH: seguir midiendo.
- ACCUMULATING / INSUFFICIENT_SAMPLE: falta muestra.
- REJECT: no usar.

### Rule Watchlist
Reglas que merecen seguimiento. No significa dinero real.

### Pilot Checklist
Semaforo final. Si dice locked, seguimos sin apostar dinero.

## 5. Reglas de decision actuales

Para avanzar un mercado se busca:

- 50+ cerradas como minimo.
- Ideal 75+ cerradas.
- Profit positivo.
- CLV positivo.
- Provider limpio.
- Mercado aprobado.
- Sin drift negativo.
- Sin flags graves.

Para dinero real, ademas:

- Autorizacion manual explicita.
- Kill switch activo.
- Stake maximo por pick definido.
- Stake maximo diario definido.
- Kelly apagado al inicio.
- Telegram automatico apagado.

## 6. Que hacer cada dia

Antes de partidos:

1. Correr MLB Real Paper diario.
2. Revisar Data Health.
3. Revisar Live Candidates / Real Paper Candidates.
4. Confirmar que REAL_CANDIDATE siga en 0.

Despues de partidos:

1. Correr ClosingOnly + Settle.
2. Revisar CLV Lab.
3. Revisar Auto Research Lab.
4. Revisar Rule Watchlist.
5. No cambiar Kelly ni dinero real.

## 7. Interpretacion rapida

- Profit positivo + CLV positivo + N suficiente = revisar para watchlist.
- Profit positivo + CLV negativo = puede ser suerte; seguir midiendo.
- Profit negativo + CLV positivo = posible mala muestra; revisar calibracion.
- Profit negativo + CLV negativo = bloquear o rechazar.
- A grade sin CLV historico suficiente = observar, no promover.

## 8. Regla de oro

El bot es bueno cuando sabe decir: no hay apuesta.

No forzar picks. No relajar filtros solo para ver candidatos. El objetivo es que cuando salga una senal fuerte, sepamos exactamente por que paso.
