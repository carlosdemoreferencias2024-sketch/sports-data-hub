import { FastifyInstance } from "fastify";

const dashboardHtml = String.raw`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sports Data Hub Trading Board</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --ink: #172033;
      --muted: #5c667a;
      --line: #d8deea;
      --panel: #ffffff;
      --green: #0f8f4d;
      --yellow: #a46a00;
      --red: #b42318;
      --blue: #2457c5;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      letter-spacing: 0;
    }
    header {
      padding: 18px 24px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    h1 { margin: 0 0 12px; font-size: 22px; }
    .controls {
      display: grid;
      grid-template-columns: minmax(220px, 360px) repeat(4, auto);
      gap: 8px;
      align-items: center;
    }
    input, button {
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      font: inherit;
      background: white;
      color: var(--ink);
    }
    button {
      cursor: pointer;
      background: #eef3ff;
      border-color: #c9d6fb;
      color: #183e91;
      font-weight: 650;
    }
    main { padding: 18px 24px 32px; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 18px;
    }
    .tabs button {
      height: 32px;
      padding: 0 12px;
      border-radius: 999px;
      background: #ffffff;
    }
    .metric, section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric { padding: 14px; }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 4px; font-size: 24px; }
    section { margin: 0 0 18px; overflow: hidden; }
    section h2 {
      margin: 0;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      font-size: 16px;
      background: #fbfcff;
    }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 900px; }
    th, td {
      padding: 9px 10px;
      border-bottom: 1px solid #edf0f6;
      text-align: left;
      font-size: 13px;
      white-space: nowrap;
    }
    th { color: var(--muted); font-size: 12px; background: #fbfcff; }
    tr:last-child td { border-bottom: 0; }
    .badge {
      display: inline-block;
      padding: 3px 7px;
      border-radius: 999px;
      background: #eef0f5;
      color: #3d4658;
      font-size: 12px;
      font-weight: 700;
    }
    .badge.real { background: #e8f7ef; color: #0f6a3b; }
    .badge.radar { background: #eef3ff; color: #183e91; }
    .badge.review { background: #fff3d8; color: #7a4b00; }
    .value { color: var(--green); font-weight: 800; }
    .warn { color: var(--yellow); font-weight: 800; }
    .loss { color: var(--red); font-weight: 800; }
    .status { padding: 12px 0; color: var(--muted); }
    .guide {
      display: grid;
      grid-template-columns: 1.2fr .8fr;
      gap: 12px;
      margin-bottom: 18px;
    }
    .guide-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
    }
    .guide-card h2 {
      margin: 0 0 8px;
      padding: 0;
      border: 0;
      background: transparent;
      font-size: 16px;
    }
    .guide-card p {
      margin: 6px 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }
    .steps {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .step {
      border: 1px solid #edf0f6;
      border-radius: 6px;
      padding: 10px;
      background: #fbfcff;
      min-height: 70px;
    }
    .step strong { display: block; margin-bottom: 4px; }
    .action {
      color: var(--blue);
      font-weight: 800;
    }
    .muted { color: var(--muted); }
    .reader-grid {
      display: grid;
      grid-template-columns: minmax(280px, 1.1fr) minmax(280px, .9fr);
      gap: 12px;
      margin-bottom: 18px;
    }
    .reader-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
    }
    .reader-card h2 { margin: 0 0 10px; font-size: 16px; }
    .reader-card p, .reader-card li { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .reader-card ul { margin: 8px 0 0; padding-left: 18px; }
    .signal-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
    .signal { border: 1px solid #edf0f6; border-radius: 6px; background: #fbfcff; padding: 10px; min-height: 72px; }
    .signal span { display: block; color: var(--muted); font-size: 12px; }
    .signal strong { display: block; margin-top: 4px; font-size: 18px; }
    .signal.ok strong { color: var(--green); }
    .signal.watch strong { color: var(--yellow); }
    .signal.block strong { color: var(--red); }
    .playbook { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 18px; }
    .playbook-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-height: 92px; }
    .playbook-card strong { display: block; margin-bottom: 6px; }
    .playbook-card p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.35; }
    .command-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
    .command-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; min-height: 112px; }
    .command-card span { display: block; color: var(--muted); font-size: 12px; }
    .command-card strong { display: block; margin-top: 6px; font-size: 22px; line-height: 1.1; }
    .command-card p { margin: 8px 0 0; color: var(--muted); font-size: 13px; line-height: 1.35; }
    .pick-card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 12px; }
    .pick-card { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 14px; }
    .pick-card h3 { margin: 0 0 8px; font-size: 16px; }
    .pick-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 10px 0; }
    .pick-meta div { border: 1px solid #edf0f6; border-radius: 6px; padding: 8px; background: #fbfcff; }
    .pick-meta span { display: block; color: var(--muted); font-size: 11px; }
    .pick-meta strong { display: block; margin-top: 3px; font-size: 14px; }
    .reason-list { margin: 8px 0 0; padding-left: 18px; color: var(--muted); font-size: 13px; line-height: 1.4; }
    .simple-status { display: inline-block; padding: 4px 8px; border-radius: 999px; font-size: 12px; font-weight: 800; background: #eef0f5; color: #3d4658; }
    .simple-status.confirmed { background: #e8f7ef; color: #0f6a3b; }
    .simple-status.paper { background: #eef3ff; color: #183e91; }
    .simple-status.review { background: #fff3d8; color: #7a4b00; }
    .simple-status.conflict { background: #ffe8e5; color: #9f1d16; }
    details.tech-mode { margin: 0 0 18px; }
    details.tech-mode > summary { cursor: pointer; list-style: none; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; font-weight: 800; }
    details.tech-mode > summary::after { content: "Abrir tablas tecnicas"; float: right; color: var(--muted); font-size: 12px; font-weight: 600; }
    details.tech-mode[open] > summary::after { content: "Cerrar tablas tecnicas"; }
    @media (max-width: 900px) {
      .controls { grid-template-columns: 1fr 1fr; }
      .metrics { grid-template-columns: 1fr 1fr; }
      .reader-grid { grid-template-columns: 1fr; }
      .playbook { grid-template-columns: 1fr 1fr; }
      .signal-grid { grid-template-columns: 1fr; }
      .guide { grid-template-columns: 1fr; }
      .command-grid { grid-template-columns: 1fr 1fr; }
      .pick-meta { grid-template-columns: 1fr; }
      .steps { grid-template-columns: 1fr; }
    }
    @media (max-width: 560px) {
      header, main { padding-left: 14px; padding-right: 14px; }
      .controls, .metrics, .playbook, .command-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Trading Board</h1>
    <div class="controls">
      <input id="apiKey" type="password" placeholder="X-Internal-API-Key" autocomplete="off" />
      <button id="saveKey">Guardar key</button>
      <button id="refresh">Actualizar</button>
      <button id="clearKey">Limpiar</button>
      <span id="status" class="status"></span>
    </div>
  </header>
  <main>
    <div class="metrics">
      <div class="metric"><span>Live Board</span><strong id="mLive">0</strong></div>
      <div class="metric"><span>Smart EV+</span><strong id="mSmart">0</strong></div>
      <div class="metric"><span>Alpha Pendiente</span><strong id="mAlpha">0</strong></div>
      <div class="metric"><span>Profit TeÃ³rico</span><strong id="mProfit">0u</strong></div>
    </div>
    <section id="tradingCommandCenter"><h2>Trading Command Center</h2><div class="command-grid">
      <div class="command-card"><span>Estado del sistema</span><strong id="ccSystemStatus">SAFE</strong><p id="ccGuardrails">Real Paper only</p></div>
      <div class="command-card"><span>Accion recomendada hoy</span><strong id="ccAction">REVIEW_ONLY</strong><p id="ccActionReason">Esperando diagnostico.</p></div>
      <div class="command-card"><span>Picks activos</span><strong id="ccPicks">0</strong><p id="ccPickBreakdown">Sin picks activos.</p></div>
      <div class="command-card"><span>Mercado fuerte</span><strong id="ccMarket">MLB ML</strong><p id="ccMarketHealth">Cargando salud de mercado.</p></div>
    </div></section>
    <section id="todaysPicks"><h2>Today's Picks - Simple View</h2><div id="todayPickCards" class="pick-card-grid"></div></section>
    <section id="whyThisPick"><h2>Why This Pick?</h2><div class="table-wrap"><table id="whyThisPickTable"></table></div></section>
    <section id="simpleMarketHealth"><h2>Simple Market Health</h2><div class="table-wrap"><table id="simpleMarketHealthTable"></table></div></section>
    <section id="pendingSettlement"><h2>Pending Settlement Monitor</h2><p id="pendingSettlementRecommendation" class="muted">Cargando estado de settlement.</p><div class="table-wrap"><table id="pendingSettlementMonitor"></table></div></section>
    <section id="footballCommandCenter"><h2>Football Command Center</h2><div class="command-grid">
      <div class="command-card"><span>Estado futbol</span><strong id="footballSystemStatus">SHADOW</strong><p id="footballGuardrails">Shadow Paper only</p></div>
      <div class="command-card"><span>Ligas favoritas</span><strong id="footballFavoriteCount">0</strong><p id="footballFavorites">Cargando ligas.</p></div>
      <div class="command-card"><span>Mejor mercado</span><strong id="footballBestMarket">-</strong><p id="footballBestMarketMeta">Sin datos.</p></div>
      <div class="command-card"><span>Accion recomendada</span><strong id="footballAction">ACCUMULATE</strong><p id="footballNextGoal">20 cerradas por mercado.</p></div>
    </div><div class="table-wrap"><table id="footballCommandTable"></table></div></section>
    <section id="footballTodayUniverse"><h2>Football Today Universe</h2><div class="command-grid">
      <div class="command-card"><span>Partidos observados</span><strong id="ftuObserved">0</strong><p id="ftuLeagues">0 ligas observadas</p></div>
      <div class="command-card"><span>Market snapshots</span><strong id="ftuSnapshots">0</strong><p>Cuotas guardadas sin contar como pick.</p></div>
      <div class="command-card"><span>Shadow candidates</span><strong id="ftuCandidates">0</strong><p id="ftuConversion">Conversion 0%</p></div>
      <div class="command-card"><span>Shadow paper</span><strong id="ftuShadowPaper">0</strong><p>Performance solo cuando cierre.</p></div>
    </div><p id="footballTodayUniverseRecommendation" class="muted">Cargando universo de futbol.</p><div class="table-wrap"><table id="footballTodayUniverseTable"></table></div></section>
    <section id="footballMarketLab"><h2>Football Market Lab</h2><p id="footballMarketLabRecommendation" class="muted">Cargando laboratorio de futbol.</p><div class="table-wrap"><table id="footballMarketLabTable"></table></div></section>
    <section id="footballPendingSettlement"><h2>Football Pending Settlement Monitor</h2><p id="footballPendingSettlementRecommendation" class="muted">Cargando pendientes de futbol.</p><div class="table-wrap"><table id="footballPendingSettlementTable"></table></div></section>
    <section id="footballFeedQuality"><h2>Football Feed Quality Report</h2><p class="muted">Calidad temporal y trazabilidad de señales Shadow Paper.</p><div class="table-wrap"><table id="footballFeedQualityTable"></table></div></section>
    <details class="tech-mode"><summary>Modo tecnico avanzado</summary>
    <div class="tabs">
      <button data-scroll="dataHealth">Overview</button>
      <button data-scroll="clvLab">CLV Lab</button>
      <button data-scroll="closingLineIntelligence">Closing Line</button>
      <button data-scroll="confidenceCalibration">Calibration</button>
      <button data-scroll="betGrading">Bet Grades</button>
      <button data-scroll="edgeQuality">Edge Quality</button>
      <button data-scroll="pickExplainability">Explainability</button>
      <button data-scroll="timingEngine">Timing</button>
      <button data-scroll="lineMovementRadar">Line Radar</button>
      <button data-scroll="autoResearchLab">Auto Research</button>
      <button data-scroll="whyNoBettablePaper">Why no Bettable</button>
      <button data-scroll="highEvAudit">High EV Audit</button>
      <button data-scroll="matchupConfirmation">Matchup</button>
      <button data-scroll="staleArchiveReport">Stale Archive</button>
      <button data-scroll="pickDecisionEngine">Pick Decisions</button>
      <button data-scroll="underdogPlusV2">Underdog Plus v2</button>
      <button data-scroll="underdogLab">Underdog Lab</button>
      <button data-scroll="providerScorecard">Provider Scorecard</button>
      <button data-scroll="marketLab">Market Lab</button>
      <button data-scroll="marketProducts">Market Products</button>
      <button data-scroll="formalMlbAudit">Formal Audit</button>
      <button data-scroll="marketPromotion">Market Promotion</button>
      <button data-scroll="noBetIntelligence">No Bet Intel</button>
      <button data-scroll="clvDrift">CLV Drift</button>
      <button data-scroll="modelErrorExplorer">Model Errors</button>
      <button data-scroll="manualAlertReport">Manual Alerts</button>
      <button data-scroll="pilotChecklist">Pilot Checklist</button>
      <button data-scroll="pilotReadiness">Pilot</button>
      <button data-scroll="modelRegistry">Model Registry</button>
      <button data-scroll="riskEngine">Risk</button>
      <button data-scroll="backtestLab">Backtest</button>
      <button data-scroll="ruleExplorer">Rule Explorer</button>
      <button data-scroll="ruleWatchlist">Rule Watchlist</button>
      <button data-scroll="liveCandidates">Live Candidates</button>
      <button data-scroll="footballTodayUniverse">Football Today</button>
      <button data-scroll="footballMarketLab">Football Lab</button>
    </div>
    <div class="reader-grid">
      <div class="reader-card">
        <h2>Lectura rapida del tablero</h2>
        <p id="readerSummary">Carga el dashboard para ver el diagnostico operativo.</p>
        <div class="signal-grid">
          <div class="signal block"><span>Dinero real</span><strong id="sRealMoney">OFF</strong></div>
          <div class="signal block"><span>Kelly</span><strong id="sKelly">OFF</strong></div>
          <div class="signal watch"><span>Estado del piloto</span><strong id="sPilot">REVIEW</strong></div>
        </div>
      </div>
      <div class="reader-card">
        <h2>Que mirar primero</h2>
        <ul id="readerChecklist">
          <li>Data Health: confirma que REAL_CANDIDATE siga en 0.</li>
          <li>CLV Lab: si CLV y profit son positivos, el mercado merece revision.</li>
          <li>Edge Quality: A/B son candidatos fuertes, pero solo Real Paper.</li>
          <li>Pilot Checklist: si dice locked, no hay dinero real todavia.</li>
        </ul>
      </div>
    </div>
    <div class="playbook">
      <div class="playbook-card"><strong>REAL_CANDIDATE</strong><p>Reservado para dinero real futuro. Debe estar en 0 hasta autorizacion explicita.</p></div>
      <div class="playbook-card"><strong>REAL_PAPER</strong><p>Cuotas reales, stake simulado, sirve para medir CLV y profit sin riesgo.</p></div>
      <div class="playbook-card"><strong>RADAR_ONLY</strong><p>Shadow/manual. Sirve para aprendizaje, no para apostar.</p></div>
      <div class="playbook-card"><strong>REVIEW</strong><p>Dato sospechoso: linea vieja, provider raro, mercado bloqueado o bandera tecnica.</p></div>
    </div>
    <section><h2>Data Health</h2><div class="table-wrap"><table id="dataHealth"></table></div></section>
    <section><h2>Internal Odds Hub</h2><div class="table-wrap"><table id="internalOddsHub"></table></div></section>
    <section><h2>Provider Scorecard</h2><div class="table-wrap"><table id="providerScorecard"></table></div></section>
    <section><h2>CLV Lab</h2><div class="table-wrap"><table id="clvLab"></table></div></section>
    <section><h2>Closing Line Intelligence</h2><div class="table-wrap"><table id="closingLineIntelligence"></table></div></section>
    <section><h2>Confidence Calibration</h2><div class="table-wrap"><table id="confidenceCalibration"></table></div></section>
    <section><h2>Bet Grading Engine</h2><div class="table-wrap"><table id="betGrading"></table></div></section>
    <section><h2>Edge Quality Score</h2><div class="table-wrap"><table id="edgeQuality"></table></div></section>
    <section><h2>Pick Explainability</h2><div class="table-wrap"><table id="pickExplainability"></table></div></section>
    <section><h2>Timing Engine</h2><div class="table-wrap"><table id="timingEngine"></table></div></section>
    <section><h2>Line Movement Radar</h2><div class="table-wrap"><table id="lineMovementRadar"></table></div></section>
    <section><h2>Auto-Research Lab</h2><div class="table-wrap"><table id="autoResearchLab"></table></div></section>
    <section><h2>Why no BETTABLE_PAPER?</h2><div class="table-wrap"><table id="whyNoBettablePaper"></table></div></section>
    <section><h2>High EV & Duplicate Audit</h2><div class="table-wrap"><table id="highEvAudit"></table></div></section>
    <section><h2>High EV Historical Performance</h2><div class="table-wrap"><table id="highEvHistorical"></table></div></section>
    <section><h2>Matchup Confirmation</h2><div class="table-wrap"><table id="matchupConfirmation"></table></div></section>
    <section><h2>Stale Archive Report</h2><div class="table-wrap"><table id="staleArchiveReport"></table></div></section>
    <section><h2>Pick Decision Engine</h2><div class="table-wrap"><table id="pickDecisionEngine"></table></div></section>
    <section><h2>Underdog Plus v2</h2><div class="table-wrap"><table id="underdogPlusV2"></table></div></section>
    <section><h2>Underdog Lab</h2><div class="table-wrap"><table id="underdogLab"></table></div></section>
    <section><h2>Underdog Plus Candidates</h2><div class="table-wrap"><table id="underdogPlusCandidates"></table></div></section>
    <section><h2>MLB 75+ Audit</h2><div class="table-wrap"><table id="mlbAudit"></table></div></section>
    <section><h2>Formal MLB 75+ Audit</h2><div class="table-wrap"><table id="formalMlbAudit"></table></div></section>
    <section><h2>Market Promotion Rules</h2><div class="table-wrap"><table id="marketPromotion"></table></div></section>
    <section><h2>No Bet Intelligence</h2><div class="table-wrap"><table id="noBetIntelligence"></table></div></section>
    <section><h2>CLV Drift Monitor</h2><div class="table-wrap"><table id="clvDrift"></table></div></section>
    <section><h2>Model Error Explorer</h2><div class="table-wrap"><table id="modelErrorExplorer"></table></div></section>
    <section><h2>Manual Alert Report</h2><div class="table-wrap"><table id="manualAlertReport"></table></div></section>
    <section><h2>Pilot Checklist</h2><div class="table-wrap"><table id="pilotChecklist"></table></div></section>
    <section><h2>Minimum Pilot Guardrails</h2><div class="table-wrap"><table id="pilotReadiness"></table></div></section>
    <section><h2>Market Lab</h2><div class="table-wrap"><table id="marketLab"></table></div></section>
    <section><h2>Market Products</h2><div class="table-wrap"><table id="marketProducts"></table></div></section>
    <section><h2>Odds Consensus</h2><div class="table-wrap"><table id="oddsConsensus"></table></div></section>
    <section><h2>Backtest Lab</h2><div class="table-wrap"><table id="backtestLab"></table></div></section>
    <section><h2>Rule Explorer</h2><div class="table-wrap"><table id="ruleExplorer"></table></div></section>
    <section><h2>Rule Watchlist</h2><div class="table-wrap"><table id="ruleWatchlist"></table></div></section>
    <section><h2>Backtest Runs</h2><div class="table-wrap"><table id="backtestRuns"></table></div></section>
    <section><h2>Model Registry</h2><div class="table-wrap"><table id="modelRegistry"></table></div></section>
    <section><h2>Feature Store</h2><div class="table-wrap"><table id="featureStore"></table></div></section>
    <section><h2>Risk Engine</h2><div class="table-wrap"><table id="riskEngine"></table></div></section>
    <section><h2>Live Candidates</h2><div class="table-wrap"><table id="liveCandidates"></table></div></section>
    <section><h2>Portfolio Operativo</h2><div class="table-wrap"><table id="portfolio"></table></div></section>
    <section><h2>Portfolio Calibracion</h2><div class="table-wrap"><table id="portfolioCalibration"></table></div></section>
    <div class="guide">
      <div class="guide-card">
        <h2>CÃ³mo leer una apuesta</h2>
        <p>Opera solo desde Smart Selection o Alpha Opportunities. Live Board muestra el precio justo del modelo, pero no confirma EV+ por sÃ­ solo.</p>
        <div class="steps">
          <div class="step"><strong>1. Pick</strong><span class="muted">Local, Empate o Visitante.</span></div>
          <div class="step"><strong>2. EV</strong><span class="muted">Debe ser positivo y pasar tu umbral.</span></div>
          <div class="step"><strong>3. Stake</strong><span class="muted">Shadow: flat 1%. Kelly queda apagado.</span></div>
        </div>
      </div>
      <div class="guide-card">
        <h2>Modo actual</h2>
        <p><strong>Shadow Trading.</strong> El tablero sirve para validar seÃ±ales, no para ejecutar dinero real.</p>
        <p>Regla activa: flat 1%, settlement al terminar partidos, sin Kelly hasta tener 20-50 cerradas por deporte.</p>
      </div>
    </div>
    <section><h2>Real Picks</h2><div class="table-wrap"><table id="realPicks"></table></div></section>
    <section><h2>Real Paper Candidates</h2><div class="table-wrap"><table id="realPaperPicks"></table></div></section>
    <section><h2>Radar Picks</h2><div class="table-wrap"><table id="radarPicks"></table></div></section>
    <section><h2>Review Diagnostics</h2><div class="table-wrap"><table id="reviewPicks"></table></div></section>
    <section><h2>Run Line Diagnostics</h2><div class="table-wrap"><table id="runLineDiagnostics"></table></div></section>
    <section><h2>No Bet</h2><div class="table-wrap"><table id="noBetPicks"></table></div></section>
    <table id="smart" style="display:none"></table>
    <section><h2>Estrategia de Parlays</h2><div class="table-wrap"><table id="parlays"></table></div></section>
    <section><h2>Alpha Opportunities</h2><div class="table-wrap"><table id="alpha"></table></div></section>
    <section><h2>Live Board</h2><div class="table-wrap"><table id="live"></table></div></section>
    <section><h2>Performance</h2><div class="table-wrap"><table id="performance"></table></div></section>
    <section><h2>Paper Performance</h2><div class="table-wrap"><table id="paper"></table></div></section>
    <section><h2>Real Performance</h2><div class="table-wrap"><table id="realPerformance"></table></div></section>
    <section><h2>Mercados por Deporte</h2><div class="table-wrap"><table id="markets"></table></div></section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const apiKey = $("apiKey");
    apiKey.value = localStorage.getItem("sportsDataHubInternalKey") || "";

    $("saveKey").onclick = () => {
      localStorage.setItem("sportsDataHubInternalKey", apiKey.value.trim());
      load();
    };
    $("clearKey").onclick = () => {
      localStorage.removeItem("sportsDataHubInternalKey");
      apiKey.value = "";
    };
    $("refresh").onclick = () => load();
    document.querySelectorAll("[data-scroll]").forEach((button) => {
      button.addEventListener("click", () => {
        const target = $(button.getAttribute("data-scroll"));
        if (target) target.closest("section").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    function fmtPct(value) {
      const n = Number(value || 0);
      return (n * 100).toFixed(2) + "%";
    }
    function fmtOdds(value) {
      return value === null || value === undefined ? "-" : Number(value).toFixed(4);
    }
    function fmtDateTime(value) {
      return value ? new Date(value).toLocaleString() : "-";
    }
    function pickLabel(value) {
      return ({ home: "Local", draw: "Empate", away: "Visitante", over: "Over", under: "Under", yes: "SÃ­", no: "No" })[value] || value || "-";
    }
    function marketLabel(value) {
      return ({
        moneyline_2way: "Ganador 2 vÃ­as",
        moneyline_3way: "1X2",
        draw_no_bet: "Empate no acciÃ³n",
        total_goals_2_5: "Over/Under goles",
        btts: "Ambos anotan",
        total_runs: "Total carreras",
        total_points: "Total puntos",
        spread: "HÃ¡ndicap / Run line",
        run_line: "Run line",
        total: "Over/Under",
        tennis_moneyline: "Tenis ganador",
        player_props: "Props jugador"
      })[value] || value || "-";
    }
    function matchLabel(row) {
      if (!row) return "-";
      const metrics = row.metrics || {};
      if (row.match && row.match !== "Home vs Away") return row.match;
      if (row.event_name && row.event_name !== "Home vs Away") return row.event_name;
      if (metrics.match && metrics.match !== "Home vs Away") return metrics.match;
      const home = row.home_team_name || row.home_team || row.home || row.home_name || row.team_home_name || metrics.home_team_name || metrics.home_team || metrics.home;
      const away = row.away_team_name || row.away_team || row.away || row.away_name || row.team_away_name || metrics.away_team_name || metrics.away_team || metrics.away;
      if (home && away) return home + " vs " + away;
      if (home) return home;
      if (away) return away;
      return "-";
    }    function auditBadge(row) {
      const status = row.audit_status || "RADAR_ONLY";
      if (status === "REAL_CANDIDATE") return "<span class='badge real'>Real</span>";
      if (status === "REAL_PAPER_CANDIDATE") return "<span class='badge real'>Real Paper</span>";
      if (status === "REVIEW") return "<span class='badge review'>Review</span>";
      return "<span class='badge radar'>Radar</span>";
    }
    function isRunLineDiagnostic(row) {
      return String(row.provider_name || "").toLowerCase() === "manual_shadow_mlb_runline";
    }
    function actionText(row) {
      const line = row.line === null || row.line === undefined ? "" : " " + Number(row.line).toFixed(1);
      const prefix = row.allow_real_bet ? "Real candidato" : row.allow_real_paper ? "Real paper" : "Shadow/Radar";
      return prefix + ": " + marketLabel(row.market_type) + " " + pickLabel(row.market_selection) + line + " @ " + fmtOdds(row.market_odds) + " | flat 1%";
    }
    function smartColumns() {
      return [
        { label: "Audit", value: r => auditBadge(r) },
        { label: "Accion", value: r => "<span class='action'>" + actionText(r) + "</span>" },
        { label: "Match", value: r => matchLabel(r) },
        { label: "Sport", value: r => r.sport_slug + "/" + r.league_slug },
        { label: "Mercado", value: r => marketLabel(r.market_type) },
        { label: "Linea", value: r => r.line === null || r.line === undefined ? "-" : Number(r.line).toFixed(1) },
        { label: "Pick", value: r => "<span class='badge'>" + pickLabel(r.market_selection) + "</span>" },
        { label: "EV Real", value: r => "<span class='value'>" + fmtPct(r.real_expected_value ?? r.expected_value) + "</span>" },
        { label: "Model Prob", value: r => fmtPct(r.model_probability_audit ?? r.model_probability) },
        { label: "Implied Prob", value: r => fmtPct(r.implied_probability) },
        { label: "Fair", value: r => fmtOdds(r.model_fair_odds) },
        { label: "Market", value: r => fmtOdds(r.market_odds) },
        { label: "Model Score", value: r => fmtPct(r.confidence) },
        { label: "Review Type", value: r => r.review_type || "-" },
        { label: "Reason", value: r => r.audit_reason || "-" },
        { label: "Age", value: r => (r.market_age_seconds ?? r.age_seconds ?? 0) + "s" }
      ];
    }
    function parlayLegsText(row) {
      const legs = row.legs || [];
      if (!legs.length) return "-";
      return legs.map(leg => {
        const line = leg.line === null || leg.line === undefined ? "" : " " + Number(leg.line).toFixed(1);
        return matchLabel(leg) + " (" + marketLabel(leg.market_type) + " " + pickLabel(leg.market_selection) + line + ")";
      }).join("<br>");
    }
    function headers() {
      const key = apiKey.value.trim() || localStorage.getItem("sportsDataHubInternalKey") || "";
      return key ? { "X-Internal-API-Key": key } : {};
    }
    async function getJson(url, internal = true) {
      const res = await fetch(url, { headers: internal ? headers() : {} });
      if (!res.ok) throw new Error(url + " -> " + res.status);
      return res.json();
    }
    function renderTable(id, columns, rows) {
      const table = $(id);
      if (!table) return;
      const safeRows = Array.isArray(rows) ? rows : (rows ? [rows] : []);
      const head = "<tr>" + columns.map(c => "<th>" + c.label + "</th>").join("") + "</tr>";
      const body = safeRows.map((row, index) => "<tr>" + columns.map(c => "<td>" + c.value(row, index) + "</td>").join("") + "</tr>").join("");
      table.innerHTML = head + body;
    }
    function setSignal(id, value, mode) {
      const el = $(id);
      if (!el) return;
      el.textContent = value;
      const box = el.closest(".signal");
      if (box) box.className = "signal " + mode;
    }
    function esc(value) {
      return String(value ?? "-").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]);
    }
    function simpleStatusClass(status) {
      const normalized = String(status || "").toLowerCase();
      if (normalized.includes("confirmed") || normalized.includes("bettable") || normalized.includes("paper")) return "confirmed";
      if (normalized.includes("review") || normalized.includes("value")) return "review";
      if (normalized.includes("conflict") || normalized.includes("blocked") || normalized.includes("reject")) return "conflict";
      return "paper";
    }
    function listItems(items, emptyText) {
      const values = (items || []).filter(Boolean);
      if (!values.length) return "<li>" + esc(emptyText || "Sin datos") + "</li>";
      return values.map(item => "<li>" + esc(item) + "</li>").join("");
    }
    function renderCommandCenter(commandCenter) {
      const cc = commandCenter || {};
      const counts = cc.counts || {};
      const health = cc.market_health_simple || {};
      const guardrails = cc.guardrails || {};
      const picks = cc.today_picks_simple || [];
      const safeFlags = [
        guardrails.real_paper_only ? "Real Paper only" : "Revisar modo",
        guardrails.real_money_enabled ? "Dinero real ON" : "Dinero real OFF",
        guardrails.kelly_enabled ? "Kelly ON" : "Kelly OFF",
        guardrails.telegram_auto_enabled ? "Telegram auto ON" : "Telegram auto OFF"
      ];
      $("ccSystemStatus").textContent = cc.system_status || "SAFE_REAL_PAPER_ONLY";
      $("ccGuardrails").textContent = safeFlags.join(" | ");
      $("ccAction").textContent = cc.recommended_action || "REVIEW_ONLY";
      $("ccActionReason").textContent = cc.recommended_reason || cc.recommendation || "Sin recomendacion operativa.";
      $("ccPicks").textContent = String(counts.active_picks || picks.length || 0);
      $("ccPickBreakdown").textContent = "Bettable paper: " + (counts.bettable_paper || 0) + " | UnderDog+: " + (counts.underdog_plus_paper || 0) + " | Review: " + (counts.review || 0);
      $("ccMarket").textContent = health.market || "MLB Moneyline";
      $("ccMarketHealth").textContent = (health.status || "-") + " | Closed " + (health.closed || 0) + " | CLV " + (health.average_clv === null || health.average_clv === undefined ? "-" : fmtPct(health.average_clv)) + " | Profit " + (health.profit_units ?? 0) + "u";

      const cards = picks.map(pick => {
        const cls = simpleStatusClass(pick.simple_status || pick.pick_decision_status || pick.underdog_plus_status);
        return "<article class='pick-card'>" +
          "<header><span class='simple-status " + cls + "'>" + esc(pick.simple_status || "REVIEW") + "</span><strong>" + esc(pick.match) + "</strong></header>" +
          "<div class='pick-meta'><span>Pick: <b>" + esc(pick.pick_label || pick.pick) + "</b></span><span>Odds: <b>" + esc(pick.odds) + "</b></span><span>Prob: <b>" + (pick.model_probability === null || pick.model_probability === undefined ? "-" : fmtPct(pick.model_probability)) + "</b></span><span>EV: <b>" + (pick.expected_value === null || pick.expected_value === undefined ? "-" : fmtPct(pick.expected_value)) + "</b></span><span>Grade: <b>" + esc(pick.edge_quality_grade) + "</b></span></div>" +
          "<div class='pick-meta'><span>Decision: " + esc(pick.pick_decision_status) + "</span><span>Underdog+: " + esc(pick.underdog_plus_status) + "</span><span>Matchup: " + esc(pick.matchup_status) + "</span><span>EV audit: " + esc(pick.high_ev_status) + "</span></div>" +
          "<div class='reason-list'><div><b>Por que interesa</b><ul>" + listItems(pick.positive_reasons, "Sin razones positivas fuertes") + "</ul></div><div><b>Por que se frena</b><ul>" + listItems(pick.blocking_reasons, "Sin bloqueos activos") + "</ul></div></div>" +
          "<p class='muted'>" + esc(pick.recommended_action || "Revisar en Real Paper") + "</p>" +
        "</article>";
      }).join("");
      $("todayPickCards").innerHTML = cards || "<article class='pick-card'><strong>No hay picks activos limpios.</strong><p class='muted'>Corre ingest fresco o espera nuevos partidos; el sistema sigue en Real Paper only.</p></article>";

      renderTable("whyThisPickTable", [
        { label: "Match", value: r => esc(r.match) },
        { label: "Status", value: r => "<span class='simple-status " + simpleStatusClass(r.simple_status) + "'>" + esc(r.simple_status) + "</span>" },
        { label: "Por que si", value: r => (r.positive_reasons || []).map(esc).join("<br>") || "-" },
        { label: "Por que no", value: r => (r.blocking_reasons || []).map(esc).join("<br>") || "-" },
        { label: "Accion", value: r => esc(r.recommended_action || "REVIEW_ONLY") }
      ], picks);

      renderTable("simpleMarketHealthTable", [
        { label: "Market", value: r => esc(r.market || "MLB Moneyline") },
        { label: "Status", value: r => r.status === "READY_FOR_REVIEW" ? "<span class='value'>READY_FOR_REVIEW</span>" : "<span class='warn'>" + esc(r.status || "-") + "</span>" },
        { label: "Closed", value: r => r.closed || 0 },
        { label: "W/L", value: r => (r.wins || 0) + "/" + (r.losses || 0) },
        { label: "CLV", value: r => r.average_clv === null || r.average_clv === undefined ? "-" : fmtPct(r.average_clv) },
        { label: "Profit", value: r => (r.profit_units || 0) + "u" },
        { label: "Mejor segmento", value: r => esc(r.best_segment || "odds 2.01+") },
        { label: "Evitar", value: r => esc(r.avoid_segment || "odds 1.61-2.00") }
      ], [health]);
    }
    function renderPendingSettlementMonitor(pendingSettlement) {
      const data = pendingSettlement || {};
      const summary = data.summary || {};
      $("pendingSettlementRecommendation").textContent = data.recommendation || "Sin recomendacion.";
      const summaryRow = Object.assign({ row_type: "Resumen" }, summary);
      const detailRows = (data.rows || []).map(row => Object.assign({ row_type: "Snapshot" }, row));
      renderTable("pendingSettlementMonitor", [
        { label: "Tipo", value: r => esc(r.row_type || "-") },
        { label: "Estado", value: r => r.settlement_state ? "<span class='badge'>" + esc(r.settlement_state) + "</span>" : esc(r.snapshot_status || "-") },
        { label: "Match", value: r => r.home_team || r.away_team ? esc((r.home_team || "Home") + " vs " + (r.away_team || "Away")) : "MLB Moneyline" },
        { label: "Match status", value: r => esc(r.match_status || "-") },
        { label: "Fecha", value: r => fmtDateTime(r.match_date || r.oldest_open_entry || r.latest_entry) },
        { label: "Open", value: r => r.open ?? "-" },
        { label: "Finished ready", value: r => r.finished_ready_for_settle ?? "-" },
        { label: "Pending closing", value: r => r.pending_closing ?? "-" },
        { label: "Pending results", value: r => r.pending_results ?? "-" },
        { label: "Pick", value: r => pickLabel(r.pick) },
        { label: "Entry", value: r => fmtOdds(r.entry_odds) },
        { label: "Closing", value: r => fmtOdds(r.closing_odds) }
      ], [summaryRow].concat(detailRows));
    }
    function renderFootballCommandCenter(footballCommandCenter) {
      const data = footballCommandCenter || {};
      const favorites = data.favorite_leagues || [];
      const best = data.best_current_market || {};
      const worst = data.worst_current_market || {};
      $("footballSystemStatus").textContent = data.system_status || "FOOTBALL_GLOBAL_SHADOW_PAPER_ONLY";
      $("footballGuardrails").textContent = "Real money OFF | Kelly OFF | Telegram auto OFF | REAL_CANDIDATE=" + (data.real_candidate_count || 0);
      $("footballFavoriteCount").textContent = String(favorites.length || 0);
      $("footballFavorites").textContent = favorites.map(league => league.display_name).join(", ") || "Sin ligas favoritas";
      $("footballBestMarket").textContent = best.league_display_name ? (best.league_display_name + " " + marketLabel(best.market)) : "Sin muestra";
      $("footballBestMarketMeta").textContent = best.closed ? ("Closed " + best.closed + " | W/L " + (best.wins || 0) + "/" + (best.losses || 0) + " | Profit " + (best.profit_units || 0) + "u") : "Esperando muestra cerrada.";
      $("footballAction").textContent = data.blocked_markets?.length ? "REVIEW_BLOCKS" : "ACCUMULATE";
      $("footballNextGoal").textContent = data.recommended_action || data.next_goal || "Acumular muestra por liga y mercado.";
      renderTable("footballCommandTable", [
        { label: "Liga", value: r => esc(r.league_display_name || r.league_id || "-") },
        { label: "Prioridad", value: r => r.priority === "FAVORITE" ? "<span class='value'>FAVORITE</span>" : "<span class='badge'>" + esc(r.priority || "-") + "</span>" },
        { label: "Flujo", value: r => esc(r.flow || "shadow_paper") },
        { label: "Mercado", value: r => marketLabel(r.market) },
        { label: "Cerradas", value: r => r.closed || 0 },
        { label: "W/L/P", value: r => (r.wins || 0) + "/" + (r.losses || 0) + "/" + (r.pushes || 0) },
        { label: "Win rate", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
        { label: "Profit", value: r => (r.profit_units || 0) + "u" },
        { label: "CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
        { label: "Estado", value: r => r.status === "READY_FOR_REVIEW" ? "<span class='value'>READY_FOR_REVIEW</span>" : (r.status === "BLOCKED" ? "<span class='loss'>BLOCKED</span>" : "<span class='warn'>" + esc(r.status || "-") + "</span>") },
        { label: "Recomendacion", value: r => esc(r.recommendation || "-") }
      ], data.league_market_performance || []);
    }
    function renderFootballTodayUniverse(data) {
      data = data || {};
      $("ftuObserved").textContent = String(data.observed_fixtures || 0);
      $("ftuLeagues").textContent = (data.leagues_observed || 0) + " ligas observadas";
      $("ftuSnapshots").textContent = String(data.market_snapshots || 0);
      $("ftuCandidates").textContent = String(data.shadow_candidates || 0);
      $("ftuShadowPaper").textContent = String(data.shadow_paper || 0);
      $("ftuConversion").textContent = "Obs -> cand " + fmtPct((data.conversion || {}).observed_to_candidate || 0) + " | cand -> pick " + fmtPct((data.conversion || {}).candidate_to_pick || 0);
      $("footballTodayUniverseRecommendation").textContent = data.recommendation || "Cargar fixtures globales como OBSERVATION_ONLY.";
      const leagueRows = (data.by_league || []).map(row => Object.assign({ row_type: "Liga" }, row));
      const marketRows = (data.by_market || []).map(row => Object.assign({ row_type: "Mercado" }, row));
      renderTable("footballTodayUniverseTable", [
        { label: "Tipo", value: r => esc(r.row_type || "-") },
        { label: "Liga/Mercado", value: r => esc(r.league_id || marketLabel(r.market) || "-") },
        { label: "Observed", value: r => r.observed_fixtures ?? "-" },
        { label: "Market snapshots", value: r => r.market_snapshots ?? "-" },
        { label: "Shadow candidates", value: r => r.shadow_candidates ?? "-" },
        { label: "Shadow paper", value: r => r.shadow_paper ?? "-" },
        { label: "Conversion", value: r => r.observed_fixtures ? fmtPct((r.shadow_candidates || 0) / r.observed_fixtures) : "-" }
      ], leagueRows.concat(marketRows).length ? leagueRows.concat(marketRows) : [{
        row_type: "Resumen",
        league_id: "Sin observaciones",
        observed_fixtures: 0,
        market_snapshots: 0,
        shadow_candidates: 0,
        shadow_paper: 0
      }]);
    }
    function renderFootballMarketLab(footballMarketLab) {
      const data = footballMarketLab || {};
      $("footballMarketLabRecommendation").textContent = data.recommendation || "Alimentar ligas favoritas en Shadow Paper.";
      renderTable("footballMarketLabTable", [
        { label: "Liga", value: r => esc(r.league_display_name || r.league_id || "-") },
        { label: "Tier", value: r => r.tier === "FAVORITE" ? "<span class='value'>FAVORITE</span>" : "<span class='badge'>" + esc(r.tier || "-") + "</span>" },
        { label: "Region", value: r => esc(r.country_or_region || "-") },
        { label: "Mercado", value: r => marketLabel(r.market) },
        { label: "Cerradas", value: r => r.closed || 0 },
        { label: "W/L/P", value: r => (r.wins || 0) + "/" + (r.losses || 0) + "/" + (r.pushes || 0) },
        { label: "Win Rate", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
        { label: "Profit", value: r => (r.profit || 0) + "u" },
        { label: "CLV", value: r => r.clv === null || r.clv === undefined ? "-" : fmtPct(r.clv) },
        { label: "Estado", value: r => r.status === "READY_FOR_REVIEW" ? "<span class='value'>READY_FOR_REVIEW</span>" : (r.status === "BLOCKED" ? "<span class='loss'>BLOCKED</span>" : "<span class='warn'>" + esc(r.status || "-") + "</span>") },
        { label: "Progreso 20", value: r => fmtPct(r.sample_progress_to_20 || 0) },
        { label: "Progreso 50", value: r => fmtPct(r.sample_progress_to_50 || 0) },
        { label: "Progreso 75", value: r => fmtPct(r.sample_progress_to_75 || 0) },
        { label: "Recomendacion", value: r => esc(r.recommendation || "-") }
      ], data.visible_rows || data.rows || []);
    }
    function renderFootballPendingSettlementMonitor(data) {
      data = data || {};
      $("footballPendingSettlementRecommendation").textContent = data.recommendation || "Sin pendientes liquidables.";
      const summary = Object.assign({ row_type: "Resumen" }, data);
      const leagueRows = (data.by_league || []).map(row => Object.assign({ row_type: "Liga" }, row));
      const marketRows = (data.by_market || []).map(row => Object.assign({ row_type: "Mercado" }, row));
      const exampleRows = (data.examples || []).map(row => Object.assign({ row_type: "Ejemplo" }, row));
      renderTable("footballPendingSettlementTable", [
        { label: "Tipo", value: r => esc(r.row_type || "-") },
        { label: "Liga", value: r => esc(r.league_id || r.league_slug || "-") },
        { label: "Mercado", value: r => marketLabel(r.market || r.market_type) },
        { label: "Match", value: r => r.home_team || r.away_team ? esc((r.home_team || "Home") + " vs " + (r.away_team || "Away")) : esc(r.match_id || "-") },
        { label: "Total", value: r => r.total ?? "-" },
        { label: "Open", value: r => r.open ?? "-" },
        { label: "Closed", value: r => r.closed ?? "-" },
        { label: "Ready", value: r => r.finished_ready_for_settle ?? "-" },
        { label: "Missing result", value: r => r.missing_result ?? "-" },
        { label: "Missing closing", value: r => r.missing_closing ?? "-" },
        { label: "Stale open", value: r => r.stale_open ?? "-" },
        { label: "Status", value: r => esc(r.status || "-") }
      ], [summary].concat(leagueRows, marketRows, exampleRows));
    }
    function renderFootballFeedQualityReport(data) {
      data = data || {};
      const summary = Object.assign({ row_type: "Resumen" }, data);
      const leagueRows = (data.by_league || []).map(row => Object.assign({ row_type: "Liga" }, row));
      const marketRows = (data.by_market || []).map(row => Object.assign({ row_type: "Mercado" }, row));
      const providerRows = (data.by_provider || []).map(row => Object.assign({ row_type: "Provider" }, row));
      renderTable("footballFeedQualityTable", [
        { label: "Tipo", value: r => esc(r.row_type || "-") },
        { label: "Liga/Provider", value: r => esc(r.league_id || r.provider || "-") },
        { label: "Mercado", value: r => marketLabel(r.market) },
        { label: "Total", value: r => r.total_signals ?? r.total ?? "-" },
        { label: "Fresh", value: r => r.fresh_line ?? "-" },
        { label: "Acceptable", value: r => r.acceptable_line ?? "-" },
        { label: "Stale", value: r => r.stale_line ?? "-" },
        { label: "Post kickoff", value: r => r.post_kickoff_rejected ?? r.odds_timestamp_after_kickoff ?? "-" },
        { label: "BTTS blocked", value: r => r.btts_requires_manual_review ?? "-" },
        { label: "Avg min to kickoff", value: r => r.avg_line_age_to_kickoff_minutes ?? "-" }
      ], [summary].concat(leagueRows, marketRows, providerRows));
    }
    function updateReaderGuide({ health, pilotChecklist, timingEngine, edgeQuality, autoResearchLab }) {
      const counts = health.counts || {};
      const mlb = (timingEngine.rows || []).find(r => r.segment === "MLB Moneyline" && r.entry_window === "closing") || {};
      const topRule = (autoResearchLab.rows || [])[0] || {};
      const grades = (edgeQuality.rows || []).reduce((acc, row) => {
        const grade = row.edge_quality_grade || row.grade || "-";
        acc[grade] = (acc[grade] || 0) + 1;
        return acc;
      }, {});
      const checks = pilotChecklist.checks || [];
      const realMoneyOff = checks.find(c => c.key === "real_money_disabled")?.passed !== false;
      const kellyOff = checks.find(c => c.key === "kelly_disabled")?.passed !== false;
      const pilotDecision = pilotChecklist.decision || "REVIEW_ONLY";
      setSignal("sRealMoney", realMoneyOff ? "OFF" : "ON", realMoneyOff ? "block" : "watch");
      setSignal("sKelly", kellyOff ? "OFF" : "ON", kellyOff ? "block" : "watch");
      setSignal("sPilot", pilotDecision, pilotDecision.includes("LOCKED") ? "watch" : "block");
      const clvText = mlb.average_clv === null || mlb.average_clv === undefined ? "sin CLV" : fmtPct(mlb.average_clv);
      const profitText = mlb.profit_flat === null || mlb.profit_flat === undefined ? "0u" : mlb.profit_flat + "u";
      $("readerSummary").textContent = "Modo seguro: REAL_CANDIDATE=" + (counts.real_candidate || 0) + ", MLB Moneyline N=" + (mlb.n || 0) + ", CLV=" + clvText + ", profit=" + profitText + ". Grades fuertes: A=" + (grades.A || 0) + ", B=" + (grades.B || 0) + ".";
      $("readerChecklist").innerHTML = [
        "REAL_CANDIDATE debe seguir en 0; si sube sin autorizacion, detener y revisar.",
        "MLB Moneyline es el mercado principal; revisa N, CLV y profit antes de cualquier decision.",
        "Edge A/B significa buena calidad para revision, no permiso para dinero real.",
        "Auto Research: mejor regla actual " + (topRule.rule_key || "sin regla") + " -> " + (topRule.recommendation || "sin recomendacion") + ".",
        "Review y No Bet explican por que el sistema se protege; no son fallas, son frenos."
      ].map(item => "<li>" + item + "</li>").join("");
    }
    async function load() {
      $("status").textContent = "Cargando...";
      try {
        if (!apiKey.value.trim() && !localStorage.getItem("sportsDataHubInternalKey")) {
          $("status").textContent = "Pega la X-Internal-API-Key, guarda y actualiza.";
          return;
        }
        const [
          live,
          perf,
          alpha,
          smart,
          parlays,
          paper,
          health,
          commandCenter,
          pendingSettlement,
          footballCommandCenter,
          footballTodayUniverse,
          footballMarketLab,
          footballPendingSettlement,
          footballFeedQuality,
          realPaper,
          portfolio,
          internalOdds,
          providerScorecard,
          clvLab,
          closingLineIntelligence,
          confidenceCalibration,
          betGrading,
          edgeQuality,
          pickExplainability,
          timingEngine,
          lineMovementRadar,
          autoResearchLab,
          whyNoBettablePaper,
          highEvAudit,
          matchupConfirmation,
          staleArchiveReport,
          pickDecisions,
          underdogPlusV2,
          underdogLab,
          mlbAudit,
          formalMlbAudit,
          marketPromotion,
          noBetIntelligence,
          clvDrift,
          modelErrorExplorer,
          manualAlertReport,
          pilotChecklist,
          pilotReadiness,
          marketLab,
          marketProducts,
          oddsConsensus,
          backtestLab,
          ruleExplorer,
          ruleWatchlist,
          backtestRuns,
          modelRegistry,
          featureStore,
          riskEngine,
          liveCandidates
        ] = await Promise.all([
          getJson("/api/v1/internal/model-quotes/live-board?limit=50&max_age_minutes=1440"),
          getJson("/api/v1/internal/model-quotes/performance-summary"),
          getJson("/api/v1/internal/model-quotes/alpha-opportunities?processed=false&min_ev=0&limit=50"),
          getJson("/api/v1/internal/model-quotes/smart-selection?min_ev=0.05&min_confidence=0&limit=50&max_model_age_minutes=1440&max_market_age_minutes=1440"),
          getJson("/api/v1/internal/model-quotes/parlay-suggestions?processed=false&min_ev=0.05&limit=80&max_age_minutes=1440"),
          getJson("/api/v1/paper-trades/summary", false),
          getJson("/api/v1/internal/model-quotes/data-health"),
          getJson("/api/v1/internal/analytics/command-center"),
          getJson("/api/v1/internal/analytics/pending-settlement-monitor"),
          getJson("/api/v1/internal/analytics/football-command-center"),
          getJson("/api/v1/internal/analytics/football-today-universe"),
          getJson("/api/v1/internal/analytics/football-market-lab"),
          getJson("/api/v1/internal/analytics/football-pending-settlement-monitor"),
          getJson("/api/v1/internal/analytics/football-feed-quality-report"),
          getJson("/api/v1/internal/model-quotes/real-paper-summary"),
          getJson("/api/v1/internal/model-quotes/portfolio-summary"),
          getJson("/api/v1/internal/odds-snapshots/health?max_age_hours=720&limit=50"),
          getJson("/api/v1/internal/odds-snapshots/provider-scorecard?max_age_hours=720&limit=50"),
          getJson("/api/v1/internal/model-quotes/clv-lab?league_slug=mlb&market_type=moneyline_2way&min_closed=1&limit=100"),
          getJson("/api/v1/internal/analytics/closing-line-intelligence"),
          getJson("/api/v1/internal/analytics/confidence-calibration"),
          getJson("/api/v1/internal/analytics/bet-grading"),
          getJson("/api/v1/internal/analytics/edge-quality-score"),
          getJson("/api/v1/internal/analytics/pick-explainability"),
          getJson("/api/v1/internal/analytics/timing-engine"),
          getJson("/api/v1/internal/analytics/line-movement-radar"),
          getJson("/api/v1/internal/analytics/auto-research-lab"),
          getJson("/api/v1/internal/analytics/why-no-bettable-paper"),
          getJson("/api/v1/internal/analytics/high-ev-audit"),
          getJson("/api/v1/internal/analytics/matchup-confirmation"),
          getJson("/api/v1/internal/analytics/stale-archive-report?max_age_hours=24"),
          getJson("/api/v1/internal/analytics/pick-decisions"),
          getJson("/api/v1/internal/analytics/underdog-plus-v2"),
          getJson("/api/v1/internal/analytics/underdog-lab"),
          getJson("/api/v1/internal/model-quotes/mlb-real-paper-audit?min_closed=75&limit=100"),
          getJson("/api/v1/internal/analytics/formal-mlb-75-audit"),
          getJson("/api/v1/internal/analytics/market-promotion-rules"),
          getJson("/api/v1/internal/analytics/no-bet-intelligence"),
          getJson("/api/v1/internal/analytics/clv-drift-monitor"),
          getJson("/api/v1/internal/analytics/model-error-explorer"),
          getJson("/api/v1/internal/analytics/manual-alert-report"),
          getJson("/api/v1/internal/analytics/pilot-checklist"),
          getJson("/api/v1/internal/analytics/pilot-readiness"),
          getJson("/api/v1/internal/analytics/market-lab?max_age_hours=720&limit=80"),
          getJson("/api/v1/internal/analytics/market-products"),
          getJson("/api/v1/internal/analytics/odds-consensus?league_slug=mlb&market_type=moneyline_2way&min_quality=80&min_books=1&limit=80"),
          getJson("/api/v1/internal/analytics/backtest-lab?sport=baseball&league_slug=mlb&market_type=moneyline_2way&min_model_probability=0.60&min_ev=0.05&min_odds=2.01"),
          getJson("/api/v1/internal/analytics/rule-explorer?active_only=true&min_closed=1&limit=50"),
          getJson("/api/v1/internal/analytics/rule-watchlist?status=watch&limit=50"),
          getJson("/api/v1/internal/analytics/backtest-runs?limit=20"),
          getJson("/api/v1/internal/analytics/model-registry"),
          getJson("/api/v1/internal/analytics/feature-store-health"),
          getJson("/api/v1/internal/analytics/risk-overview"),
          getJson("/api/v1/internal/analytics/live-candidates")
        ]);

        $("mLive").textContent = live.count || 0;
        $("mSmart").textContent = smart.count || 0;
        $("mAlpha").textContent = alpha.count || 0;
        $("mProfit").textContent = ((paper.balance_neto_mxn || 0) / 100).toFixed(2) + "u";
        updateReaderGuide({ health, pilotChecklist, timingEngine, edgeQuality, autoResearchLab });
        renderCommandCenter(commandCenter);
        renderPendingSettlementMonitor(pendingSettlement);
        renderFootballCommandCenter(footballCommandCenter);
        renderFootballTodayUniverse(footballTodayUniverse);
        renderFootballMarketLab(footballMarketLab);
        renderFootballPendingSettlementMonitor(footballPendingSettlement);
        renderFootballFeedQualityReport(footballFeedQuality);

        renderTable("dataHealth", [
          { label: "Total picks", value: r => r.counts.total_picks },
          { label: "Real", value: r => r.counts.real_candidate },
          { label: "Real Paper", value: r => r.counts.real_paper_candidate || 0 },
          { label: "Radar", value: r => r.counts.radar_only },
          { label: "Review", value: r => r.counts.review },
          { label: "No Bet", value: r => r.counts.no_bet },
          { label: "Processed true", value: r => r.counts.processed_true },
          { label: "Processed false", value: r => r.counts.processed_false },
          { label: "Real providers", value: r => r.providers.real_active + " / " + (r.providers.real.join(", ") || "-") },
          { label: "Shadow providers", value: r => r.providers.shadow_active + " / " + (r.providers.shadow.join(", ") || "-") },
          { label: "Ultima real", value: r => fmtDateTime(r.latest.real) },
          { label: "Ultima shadow", value: r => fmtDateTime(r.latest.shadow) },
          { label: "Review types", value: r => (r.review_types || []).map(x => x.type + ": " + x.count).join(", ") || "-" }
        ], [health]);

        renderTable("internalOddsHub", [
          { label: "Provider", value: r => r.provider_name },
          { label: "Bookmaker", value: r => r.bookmaker || "-" },
          { label: "Sport", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") },
          { label: "Market", value: r => marketLabel(r.market_type) },
          { label: "Role", value: r => r.snapshot_role || "-" },
          { label: "Snapshots", value: r => r.snapshots || 0 },
          { label: "Clean >=80", value: r => r.clean_snapshots || 0 },
          { label: "Review <80", value: r => r.review_snapshots || 0 },
          { label: "Avg Quality", value: r => r.avg_quality_score ?? "-" },
          { label: "Latest", value: r => fmtDateTime(r.latest_captured_at) }
        ], (internalOdds.rows || []).length ? internalOdds.rows : [{
          provider_name: "Sin snapshots",
          bookmaker: "-",
          sport_slug: "-",
          league_slug: "-",
          market_type: "-",
          snapshot_role: "-",
          snapshots: 0,
          clean_snapshots: 0,
          review_snapshots: 0,
          avg_quality_score: "-",
          latest_captured_at: null
        }]);

        renderTable("providerScorecard", [
          { label: "Provider", value: r => r.provider_name || "-" },
          { label: "Bookmaker", value: r => r.bookmaker || "-" },
          { label: "Sport", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") },
          { label: "Market", value: r => marketLabel(r.market_type) },
          { label: "Score", value: r => r.provider_score ?? "-" },
          { label: "Status", value: r => r.status === "ACTIVE_CLEAN" ? "<span class='value'>ACTIVE_CLEAN</span>" : "<span class='warn'>" + (r.status || "-") + "</span>" },
          { label: "Snapshots", value: r => r.snapshots || 0 },
          { label: "Clean Rate", value: r => r.clean_rate === null || r.clean_rate === undefined ? "-" : fmtPct(r.clean_rate) },
          { label: "Market", value: r => r.market_snapshots || 0 },
          { label: "Closing", value: r => r.closing_snapshots || 0 },
          { label: "Avg Quality", value: r => r.avg_quality_score ?? "-" },
          { label: "Latest Market", value: r => fmtDateTime(r.latest_market_at) },
          { label: "Latest Closing", value: r => fmtDateTime(r.latest_closing_at) }
        ], (providerScorecard.rows || []).length ? providerScorecard.rows : [{
          provider_name: "Sin provider score",
          bookmaker: "-",
          sport_slug: "-",
          league_slug: "-",
          market_type: "-",
          provider_score: "-",
          status: "-",
          snapshots: 0,
          clean_rate: null,
          market_snapshots: 0,
          closing_snapshots: 0,
          avg_quality_score: "-",
          latest_market_at: null,
          latest_closing_at: null
        }]);

        const clvColumns = [
          { label: "Grupo", value: r => r.group_type || "-" },
          { label: "Valor", value: r => r.group_value || "-" },
          { label: "Total", value: r => r.total || 0 },
          { label: "Closed", value: r => r.closed || 0 },
          { label: "W/L/P", value: r => (r.wins || 0) + "/" + (r.losses || 0) + "/" + (r.pushes || 0) },
          { label: "Win Rate", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
          { label: "Entry", value: r => r.avg_entry_odds === null || r.avg_entry_odds === undefined ? "-" : fmtOdds(r.avg_entry_odds) },
          { label: "Close", value: r => r.avg_closing_odds === null || r.avg_closing_odds === undefined ? "-" : fmtOdds(r.avg_closing_odds) },
          { label: "CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "CLV+", value: r => r.positive_clv_rate === null || r.positive_clv_rate === undefined ? "-" : fmtPct(r.positive_clv_rate) },
          { label: "Profit", value: r => (r.profit_units || 0) + "u" },
          { label: "Decision", value: r => r.decision === "READY_FOR_REVIEW" ? "<span class='value'>READY_FOR_REVIEW</span>" : "<span class='warn'>" + (r.decision || "-") + "</span>" }
        ];
        renderTable("clvLab", clvColumns, clvLab.rows || []);

        renderTable("closingLineIntelligence", [
          { label: "Ventana", value: r => r.entry_window || "-" },
          { label: "Closed", value: r => r.closed || 0 },
          { label: "W/L", value: r => (r.wins || 0) + "/" + (r.losses || 0) },
          { label: "Win Rate", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
          { label: "Horas antes", value: r => r.avg_hours_before_start ?? "-" },
          { label: "Entry", value: r => fmtOdds(r.avg_entry_odds) },
          { label: "Close", value: r => fmtOdds(r.avg_closing_odds) },
          { label: "CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "CLV+", value: r => r.closed ? fmtPct((r.positive_clv || 0) / r.closed) : "-" },
          { label: "Profit", value: r => (r.profit_units || 0) + "u" },
          { label: "Steam", value: r => r.steam_signal === "STEAM_FOR_US" ? "<span class='value'>STEAM_FOR_US</span>" : (r.steam_signal === "STEAM_AGAINST_US" ? "<span class='loss'>STEAM_AGAINST_US</span>" : "<span class='badge'>" + (r.steam_signal || "-") + "</span>") },
          { label: "Timing", value: r => r.timing_signal === "preferred_window_candidate" ? "<span class='value'>preferred</span>" : "<span class='warn'>" + (r.timing_signal || "-") + "</span>" }
        ], closingLineIntelligence.rows || []);

        renderTable("confidenceCalibration", [
          { label: "Bucket", value: r => r.probability_bucket || "-" },
          { label: "Closed", value: r => r.closed || 0 },
          { label: "W/L", value: r => (r.wins || 0) + "/" + (r.losses || 0) },
          { label: "Model Prob", value: r => r.avg_model_probability === null || r.avg_model_probability === undefined ? "-" : fmtPct(r.avg_model_probability) },
          { label: "Observed", value: r => r.observed_win_rate === null || r.observed_win_rate === undefined ? "-" : fmtPct(r.observed_win_rate) },
          { label: "Gap", value: r => r.calibration_gap === null || r.calibration_gap === undefined ? "-" : fmtPct(r.calibration_gap) },
          { label: "CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "Profit", value: r => (r.profit_units || 0) + "u" },
          { label: "Status", value: r => r.calibration_status === "CALIBRATED" ? "<span class='value'>CALIBRATED</span>" : "<span class='warn'>" + (r.calibration_status || "-") + "</span>" }
        ], confidenceCalibration.rows || []);

        renderTable("betGrading", [
          { label: "Grade", value: r => r.grade === "A" ? "<span class='value'>A</span>" : (r.grade === "F" ? "<span class='loss'>F</span>" : "<span class='badge'>" + (r.grade || "-") + "</span>") },
          { label: "Match", value: r => matchLabel(r) },
          { label: "Market", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") + " " + marketLabel(r.market_type) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Reason", value: r => r.grade_reason || "-" },
          { label: "Market Status", value: r => r.market_status || "-" },
          { label: "Provider", value: r => r.provider_status || "-" },
          { label: "Book", value: r => (r.metrics || {}).bookmaker || "-" },
          { label: "Entry", value: r => fmtOdds((r.metrics || {}).entry_odds) },
          { label: "CLV", value: r => (r.metrics || {}).clv === null || (r.metrics || {}).clv === undefined ? "-" : fmtPct((r.metrics || {}).clv) },
          { label: "P/L", value: r => ((r.metrics || {}).profit_loss || 0) + "u" }
        ], betGrading.rows || []);

        renderTable("edgeQuality", [
          { label: "Edge", value: r => (r.edge_quality_score ?? "-") + " / 100" },
          { label: "Match", value: r => matchLabel(r) },
          { label: "Grade", value: r => r.edge_quality_grade === "A" ? "<span class='value'>A</span>" : (r.edge_quality_grade === "F" ? "<span class='loss'>F</span>" : "<span class='badge'>" + (r.edge_quality_grade || r.grade || "-") + "</span>") },
          { label: "Market", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") + " " + marketLabel(r.market_type) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Status", value: r => r.snapshot_status || "-" },
          { label: "Market Status", value: r => r.market_status || "-" },
          { label: "Provider", value: r => r.provider_status || "-" },
          { label: "Hist N", value: r => (r.metrics || {}).historical_similar_sample ?? "-" },
          { label: "Hist CLV", value: r => (r.metrics || {}).historical_avg_clv === null || (r.metrics || {}).historical_avg_clv === undefined ? "-" : fmtPct((r.metrics || {}).historical_avg_clv) },
          { label: "Explanation", value: r => r.explanation_text || r.grade_reason || "-" }
        ], edgeQuality.rows || []);

        renderTable("pickExplainability", [
          { label: "Status", value: r => r.status === "REAL_PAPER_CANDIDATE" ? "<span class='value'>REAL_PAPER</span>" : (r.status === "REVIEW" ? "<span class='warn'>REVIEW</span>" : "<span class='badge'>" + (r.status || "-") + "</span>") },
          { label: "Match", value: r => matchLabel(r) },
          { label: "Grade", value: r => r.grade || "-" },
          { label: "Market", value: r => marketLabel(r.market_type) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Provider", value: r => r.provider || "-" },
          { label: "Model Prob", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
          { label: "Implied", value: r => r.implied_probability === null || r.implied_probability === undefined ? "-" : fmtPct(r.implied_probability) },
          { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
          { label: "Hist CLV", value: r => r.clv_average === null || r.clv_average === undefined ? "-" : fmtPct(r.clv_average) },
          { label: "Hist N", value: r => r.historical_similar_sample || 0 },
          { label: "Passed", value: r => (r.approval_rules_passed || []).join(", ") || "-" },
          { label: "Blocks", value: r => (r.blocking_rules || []).join(", ") || "-" },
          { label: "Why", value: r => r.explanation_text || "-" }
        ], pickExplainability.rows || []);

        renderTable("timingEngine", [
          { label: "Segment", value: r => r.segment || "-" },
          { label: "Window", value: r => r.entry_window || "-" },
          { label: "N", value: r => r.n || 0 },
          { label: "W/L", value: r => (r.wins || 0) + "/" + (r.losses || 0) },
          { label: "Win Rate", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
          { label: "CLV", value: r => r.average_clv === null || r.average_clv === undefined ? "-" : fmtPct(r.average_clv) },
          { label: "Profit", value: r => (r.profit_flat || 0) + "u" },
          { label: "Best", value: r => r.best_entry_window || "-" },
          { label: "Worst", value: r => r.worst_entry_window || "-" }
        ], timingEngine.rows || []);

        renderTable("lineMovementRadar", [
          { label: "Alert", value: r => r.alert_level === "HIGH" ? "<span class='loss'>HIGH</span>" : (r.alert_level === "MEDIUM" ? "<span class='warn'>MEDIUM</span>" : "<span class='badge'>LOW</span>") },
          { label: "Steam", value: r => r.steam_detected === "STEAM_FAVORABLE" ? "<span class='value'>STEAM_FAVORABLE</span>" : (r.steam_detected === "STEAM_AGAINST" || r.steam_detected === "SHARP_DROP" || r.steam_detected === "STALE_LINE" ? "<span class='loss'>" + (r.steam_detected || "-") + "</span>" : "<span class='badge'>" + (r.steam_detected || "-") + "</span>") },
          { label: "Match", value: r => matchLabel(r) },
          { label: "Market", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") + " " + marketLabel(r.market_type) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Book", value: r => r.bookmaker || "-" },
          { label: "Entry", value: r => fmtOdds(r.opening_entry_odds) },
          { label: "Current", value: r => fmtOdds(r.current_odds) },
          { label: "Closing", value: r => fmtOdds(r.closing_odds) },
          { label: "Move", value: r => r.movement_percentage === null || r.movement_percentage === undefined ? "-" : fmtPct(r.movement_percentage) },
          { label: "Direction", value: r => r.movement_direction || "-" },
          { label: "Latest", value: r => fmtDateTime(r.latest_snapshot_at) }
        ], lineMovementRadar.rows || []);

        renderTable("autoResearchLab", [
          { label: "Rule", value: r => r.rule_key || "-" },
          { label: "N", value: r => r.n || 0 },
          { label: "W/L", value: r => (r.wins || 0) + "/" + (r.losses || 0) },
          { label: "Win Rate", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
          { label: "Brier", value: r => r.brier ?? "-" },
          { label: "Profit", value: r => (r.profit_flat || 0) + "u" },
          { label: "ROI", value: r => r.roi === null || r.roi === undefined ? "-" : r.roi },
          { label: "Yield", value: r => r.yield === null || r.yield === undefined ? "-" : r.yield },
          { label: "CLV", value: r => r.average_clv === null || r.average_clv === undefined ? "-" : fmtPct(r.average_clv) },
          { label: "Max DD", value: r => r.max_drawdown ?? "-" },
          { label: "Recommendation", value: r => r.recommendation === "PROMOTE" ? "<span class='value'>PROMOTE</span>" : (r.recommendation === "REJECT" ? "<span class='loss'>REJECT</span>" : "<span class='warn'>" + (r.recommendation || "-") + "</span>") }
        ], autoResearchLab.rows || []);


        renderTable("whyNoBettablePaper", [
          { label: "Reason", value: r => r.reason || r.dominant_reason || "-" },
          { label: "Count", value: r => r.count ?? ((r.bettable_paper_count || 0) + " BETTABLE | " + (r.underdog_plus_paper_count || 0) + " UNDERDOG_PLUS") },
          { label: "Severity", value: r => r.severity === "HIGH" ? "<span class='loss'>HIGH</span>" : (r.severity === "MEDIUM" ? "<span class='warn'>MEDIUM</span>" : "<span class='badge'>" + (r.severity || "INFO") + "</span>") },
          { label: "Affected Market", value: r => r.affected_market || "Resumen operativo" },
          { label: "Example Match", value: r => r.example_match || r.summary || "-" },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], [{
          reason: whyNoBettablePaper.dominant_reason || "-",
          bettable_paper_count: whyNoBettablePaper.bettable_paper_count || 0,
          underdog_plus_paper_count: whyNoBettablePaper.underdog_plus_paper_count || 0,
          severity: (whyNoBettablePaper.reasons || [])[0]?.severity || "INFO",
          affected_market: "Resumen operativo",
          example_match: whyNoBettablePaper.summary || "-",
          recommendation: whyNoBettablePaper.recommendation || "-"
        }].concat(whyNoBettablePaper.reasons || []));
        renderTable("highEvAudit", [
          { label: "Audit", value: r => r.high_ev_audit_status === "EV_CLEAN" ? "<span class='value'>EV_CLEAN</span>" : (r.high_ev_audit_status === "DUPLICATE_BLOCKED" || r.high_ev_audit_status === "ODDS_OUTLIER_REVIEW" ? "<span class='loss'>" + (r.high_ev_audit_status || "-") + "</span>" : "<span class='warn'>" + (r.high_ev_audit_status || "-") + "</span>") },
          { label: "Clean", value: r => r.audit_clean ? "<span class='value'>true</span>" : "<span class='warn'>false</span>" },
          { label: "Match", value: r => r.match || matchLabel(r) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
          { label: "Bucket", value: r => r.ev_bucket || "-" },
          { label: "Model Prob", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
          { label: "Implied", value: r => r.implied_probability === null || r.implied_probability === undefined ? "-" : fmtPct(r.implied_probability) },
          { label: "Provider", value: r => r.provider || r.provider_name || r.bookmaker || "-" },
          { label: "Grade", value: r => r.grade || r.edge_quality_grade || "-" },
          { label: "CLV 10", value: r => r.recent_clv_10 === null || r.recent_clv_10 === undefined ? "-" : fmtPct(r.recent_clv_10) },
          { label: "Exposure", value: r => r.exposure_rank || 1 },
          { label: "Timestamp Gap", value: r => r.timestamp_gap_seconds === null || r.timestamp_gap_seconds === undefined ? "-" : Math.round(Number(r.timestamp_gap_seconds) / 60) + "m" },
          { label: "Flags", value: r => (r.flags || []).join(", ") || "-" },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], (highEvAudit.rows || []).length ? highEvAudit.rows : [{
          high_ev_audit_status: "SIN PICKS ACTIVOS",
          audit_clean: false,
          match: "No hay picks abiertos",
          flags: [],
          recommendation: "Esperar siguiente ciclo Real Paper"
        }]);

        renderTable("highEvHistorical", [
          { label: "EV Bucket", value: r => r.ev_bucket || "-" },
          { label: "Closed", value: r => r.closed || 0 },
          { label: "W/L", value: r => (r.wins || 0) + "/" + (r.losses || 0) },
          { label: "Win Rate", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
          { label: "Profit", value: r => (r.profit_units || 0) + "u" },
          { label: "CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "CLV+", value: r => r.clv_positive_rate === null || r.clv_positive_rate === undefined ? "-" : fmtPct(r.clv_positive_rate) },
          { label: "Brier", value: r => r.brier ?? "-" },
          { label: "Avg Odds", value: r => fmtOdds(r.avg_odds) },
          { label: "Avg Model Prob", value: r => r.avg_model_prob === null || r.avg_model_prob === undefined ? "-" : fmtPct(r.avg_model_prob) }
        ], highEvAudit.historical_performance || []);
        renderTable("matchupConfirmation", [
          { label: "Final", value: r => r.final_operational_status === "BETTABLE_PAPER_CONFIRMED" ? "<span class='value'>BETTABLE_PAPER_CONFIRMED</span>" : (r.final_operational_status === "MODEL_CONFLICT_REVIEW" ? "<span class='loss'>MODEL_CONFLICT</span>" : "<span class='warn'>" + (r.final_operational_status || "-") + "</span>") },
          { label: "Matchup", value: r => r.matchup_status === "MATCHUP_CONFIRMED" ? "<span class='value'>MATCHUP_CONFIRMED</span>" : (r.matchup_status === "MODEL_CONFLICT" ? "<span class='loss'>MODEL_CONFLICT</span>" : "<span class='badge'>" + (r.matchup_status || "-") + "</span>") },
          { label: "Score", value: r => r.matchup_score ?? "-" },
          { label: "Match", value: r => r.match || matchLabel(r) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Odds", value: r => fmtOdds(r.entry_odds) },
          { label: "Model Prob", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
          { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
          { label: "Pick Decision", value: r => r.pick_decision || r.decision || "-" },
          { label: "Underdog+", value: r => r.underdog_plus_status || "-" },
          { label: "Pitcher", value: r => r.pitcher_status || "-" },
          { label: "Bullpen", value: r => r.bullpen_status || "-" },
          { label: "Lineup", value: r => r.lineup_status || "-" },
          { label: "Recent Form", value: r => r.recent_form_status || "-" },
          { label: "Market Move", value: r => r.market_movement_status || "-" },
          { label: "Confirm", value: r => (r.confirmation_reasons || []).join(", ") || "-" },
          { label: "Conflicts", value: r => (r.conflict_reasons || []).join(", ") || "-" },
          { label: "Warnings", value: r => (r.warnings || []).join(", ") || "-" },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], (matchupConfirmation.rows || []).length ? matchupConfirmation.rows : [{
          final_operational_status: "SIN MATCHUP ACTIVO",
          matchup_status: "PASS",
          matchup_score: "-",
          match: "No hay MLB Moneyline abiertos",
          confirmation_reasons: [],
          conflict_reasons: [],
          warnings: [],
          recommendation: "Esperar siguiente ciclo Real Paper"
        }]);
        renderTable("staleArchiveReport", [
          { label: "Status", value: r => r.status || r.mode || "-" },
          { label: "Count", value: r => r.count ?? r.stale_candidates ?? 0 },
          { label: "Oldest", value: r => fmtDateTime(r.oldest) },
          { label: "Latest", value: r => fmtDateTime(r.latest) },
          { label: "Proposed Action", value: r => r.proposed_action || ("would expire " + (r.would_mark_expired || 0) + " / archive " + (r.would_mark_stale_archived || 0)) },
          { label: "Last Archive Run", value: r => fmtDateTime(r.last_archive_run) },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], [{
          mode: staleArchiveReport.mode || "dry-run",
          stale_candidates: staleArchiveReport.stale_candidates || 0,
          oldest: null,
          latest: null,
          would_mark_expired: staleArchiveReport.would_mark_expired || 0,
          would_mark_stale_archived: staleArchiveReport.would_mark_stale_archived || 0,
          last_archive_run: (staleArchiveReport.rows || []).map(r => r.last_archive_run).filter(Boolean).sort().pop() || null,
          recommendation: staleArchiveReport.recommendation || "-"
        }].concat(staleArchiveReport.rows || []));
        renderTable("pickDecisionEngine", [
          { label: "Decision", value: r => r.decision === "BETTABLE_PAPER" ? "<span class='value'>BETTABLE_PAPER</span>" : (r.decision === "BLOCKED_BY_RISK" || r.decision === "REJECT" ? "<span class='loss'>" + (r.decision || "-") + "</span>" : "<span class='warn'>" + (r.decision || "-") + "</span>") },
          { label: "Grade", value: r => r.grade || "-" },
          { label: "Score", value: r => r.score ?? "-" },
          { label: "Match", value: r => r.match || (matchLabel(r)) },
          { label: "Market", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") + " " + marketLabel(r.market_type) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Odds", value: r => fmtOdds(r.entry_odds) },
          { label: "Model Prob", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
          { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
          { label: "Provider", value: r => r.provider_name || r.bookmaker || "-" },
          { label: "Provider Score", value: r => r.quality_score ?? "-" },
          { label: "CLV 10", value: r => r.recent_clv_10 === null || r.recent_clv_10 === undefined ? "-" : fmtPct(r.recent_clv_10) },
          { label: "CLV 20", value: r => r.recent_clv_20 === null || r.recent_clv_20 === undefined ? "-" : fmtPct(r.recent_clv_20) },
          { label: "Line Age", value: r => r.line_age_seconds === null || r.line_age_seconds === undefined ? "-" : Math.round(Number(r.line_age_seconds) / 60) + "m" },
          { label: "Market Status", value: r => r.market_status || "-" },
          { label: "Risk Status", value: r => r.risk_status || "-" },
          { label: "Passed", value: r => (r.reasons_passed || []).join(", ") || "-" },
          { label: "Blocked", value: r => (r.reasons_blocked || []).join(", ") || "-" },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], (pickDecisions.rows || []).length ? pickDecisions.rows : [{
          decision: "SIN CANDIDATOS",
          grade: "-",
          score: "-",
          match: "No hay picks abiertos",
          market_type: "-",
          reasons_passed: [],
          reasons_blocked: [],
          recommendation: "Esperar siguiente ciclo Real Paper"
        }]);

        renderTable("underdogPlusV2", [
          { label: "Decision", value: r => r.underdog_plus_status === "UNDERDOG_PLUS_PAPER" ? "<span class='value'>UNDERDOG_PLUS_PAPER</span>" : (r.underdog_plus_status === "UNDERDOG_PLUS_BLOCKED" ? "<span class='loss'>UNDERDOG_PLUS_BLOCKED</span>" : "<span class='warn'>" + (r.underdog_plus_status || "-") + "</span>") },
          { label: "Pick Decision", value: r => r.decision || "-" },
          { label: "Match", value: r => r.match || (matchLabel(r)) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Odds", value: r => fmtOdds(r.entry_odds) },
          { label: "Model Prob", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
          { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
          { label: "CLV 10", value: r => r.recent_clv_10 === null || r.recent_clv_10 === undefined ? "-" : fmtPct(r.recent_clv_10) },
          { label: "CLV 20", value: r => r.recent_clv_20 === null || r.recent_clv_20 === undefined ? "-" : fmtPct(r.recent_clv_20) },
          { label: "Provider Score", value: r => r.quality_score ?? "-" },
          { label: "Line Age", value: r => r.line_age_seconds === null || r.line_age_seconds === undefined ? "-" : Math.round(Number(r.line_age_seconds) / 60) + "m" },
          { label: "Exposure", value: r => r.open_exposure_count || 0 },
          { label: "Stale", value: r => r.is_stale ? "<span class='loss'>true</span>" : "false" },
          { label: "Suspicious", value: r => r.suspicious_move ? "<span class='loss'>true</span>" : "false" },
          { label: "Reasons", value: r => ((r.reasons_blocked || []).concat(r.warnings || [])).join(", ") || "clean" },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], (underdogPlusV2.candidates || []).length ? underdogPlusV2.candidates : [{
          underdog_plus_status: "SIN UNDERDOG PLUS V2 ACTUAL",
          decision: "-",
          match: "No hay candidatos frescos",
          reasons_blocked: [],
          warnings: [],
          recommendation: "Esperar siguiente ciclo Real Paper"
        }]);

        renderTable("underdogLab", [
          { label: "Rank", value: r => r.rank || "-" },
          { label: "Rule", value: r => r.rule_key || "-" },
          { label: "Closed", value: r => r.closed || 0 },
          { label: "W/L/P", value: r => (r.wins || 0) + "/" + (r.losses || 0) + "/" + (r.pushes || 0) },
          { label: "Win Rate", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
          { label: "Avg Odds", value: r => fmtOdds(r.avg_entry_odds) },
          { label: "Avg Prob", value: r => r.avg_model_prob === null || r.avg_model_prob === undefined ? "-" : fmtPct(r.avg_model_prob) },
          { label: "EV", value: r => r.avg_ev === null || r.avg_ev === undefined ? "-" : fmtPct(r.avg_ev) },
          { label: "CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "CLV+", value: r => r.clv_positive_rate === null || r.clv_positive_rate === undefined ? "-" : fmtPct(r.clv_positive_rate) },
          { label: "Recent CLV 10", value: r => r.recent_clv_10 === null || r.recent_clv_10 === undefined ? "-" : fmtPct(r.recent_clv_10) },
          { label: "Recent CLV 20", value: r => r.recent_clv_20 === null || r.recent_clv_20 === undefined ? "-" : fmtPct(r.recent_clv_20) },
          { label: "Profit", value: r => (r.profit_units || 0) + "u" },
          { label: "Max DD", value: r => (r.max_drawdown || 0) + "u" },
          { label: "Brier", value: r => r.brier ?? "-" },
          { label: "Score", value: r => r.underdog_score ?? "-" },
          { label: "Status", value: r => r.status === "HOT" || r.status === "READY_FOR_REVIEW" ? "<span class='value'>" + r.status + "</span>" : (r.status === "BLOCKED" || r.status === "COOLING" ? "<span class='loss'>" + (r.status || "-") + "</span>" : "<span class='warn'>" + (r.status || "-") + "</span>") },
          { label: "Recommendation", value: r => r.recommendation || "-" },
          { label: "Upgrade vs Base", value: r => "WR " + fmtPct(r.delta_win_rate || 0) + " | Profit " + (r.delta_profit || 0) + "u | CLV " + fmtPct(r.delta_clv || 0) + " | Score " + (r.delta_score || 0) }
        ], underdogLab.rows || []);

        renderTable("underdogPlusCandidates", [
          { label: "Status", value: r => "<span class='value'>" + (r.audit_status || "UNDERDOG_PLUS_PAPER") + "</span>" },
          { label: "Match", value: r => matchLabel(r) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Book", value: r => r.bookmaker || "-" },
          { label: "Entry", value: r => fmtOdds(r.entry_odds) },
          { label: "Model Prob", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
          { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
          { label: "Provider Score", value: r => r.quality_score ?? "-" },
          { label: "Recent CLV 10", value: r => r.recent_clv_10 === null || r.recent_clv_10 === undefined ? "-" : fmtPct(r.recent_clv_10) },
          { label: "Books", value: r => r.book_count || 0 },
          { label: "Exposure", value: r => r.open_exposure_count || 0 },
          { label: "Blocks", value: r => (r.blocking_rules || []).join(", ") || "-" },
          { label: "Recommendation", value: r => r.recommendation || "REAL_PAPER_ONLY" }
        ], (underdogLab.candidates || []).length ? underdogLab.candidates : [{
          audit_status: "SIN UNDERDOG PLUS ACTUAL",
          home_team_name: "No hay picks estrictos ahora",
          away_team_name: "-",
          pick: "-",
          bookmaker: "-",
          entry_odds: null,
          model_probability: null,
          expected_value: null,
          quality_score: "-",
          recent_clv_10: null,
          book_count: 0,
          open_exposure_count: 0,
          blocking_rules: [],
          recommendation: "Esperar siguiente ciclo Real Paper"
        }]);

        renderTable("mlbAudit", clvColumns, mlbAudit.rows || []);

        renderTable("formalMlbAudit", [
          { label: "Grupo", value: r => r.group_type || "-" },
          { label: "Valor", value: r => r.group_value || "-" },
          { label: "Closed", value: r => r.closed || 0 },
          { label: "W/L/P", value: r => (r.wins || 0) + "/" + (r.losses || 0) + "/" + (r.pushes || 0) },
          { label: "Win Rate", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
          { label: "Entry", value: r => r.avg_entry_odds === null || r.avg_entry_odds === undefined ? "-" : fmtOdds(r.avg_entry_odds) },
          { label: "Close", value: r => r.avg_closing_odds === null || r.avg_closing_odds === undefined ? "-" : fmtOdds(r.avg_closing_odds) },
          { label: "CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "CLV+", value: r => r.positive_clv_rate === null || r.positive_clv_rate === undefined ? "-" : fmtPct(r.positive_clv_rate) },
          { label: "Profit", value: r => (r.profit_units || 0) + "u" },
          { label: "Recomendacion", value: r => String(r.recommendation || "").startsWith("APTO") ? "<span class='value'>" + r.recommendation + "</span>" : "<span class='warn'>" + (r.recommendation || "-") + "</span>" }
        ], formalMlbAudit.rows || []);

        renderTable("marketPromotion", [
          { label: "Rule", value: r => r.rule_key || "-" },
          { label: "Market", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") + " " + marketLabel(r.market_type) },
          { label: "Segment", value: r => r.segment || "-" },
          { label: "Status", value: r => r.status === "READY_FOR_REVIEW" || r.status === "WATCHLIST_READY" ? "<span class='value'>" + r.status + "</span>" : (r.status === "BLOCKED" ? "<span class='loss'>BLOCKED</span>" : "<span class='warn'>" + (r.status || "-") + "</span>") },
          { label: "Closed", value: r => (r.current_closed || 0) + "/" + (r.required_closed || 0) },
          { label: "Profit", value: r => ((r.metrics || {}).profit_units ?? "-") + "u" },
          { label: "CLV", value: r => (r.metrics || {}).avg_clv === null || (r.metrics || {}).avg_clv === undefined ? "-" : fmtPct((r.metrics || {}).avg_clv) },
          { label: "Reason", value: r => r.guardrail_reason || "-" },
          { label: "Recommendation", value: r => r.recommendation || "-" },
          { label: "Updated", value: r => fmtDateTime(r.updated_at) }
        ], marketPromotion.rows || []);

        renderTable("noBetIntelligence", [
          { label: "Reason", value: r => r.reason_label || r.reason_code || "-" },
          { label: "Code", value: r => r.reason_code || "-" },
          { label: "Severity", value: r => r.severity === "block" ? "<span class='loss'>block</span>" : "<span class='warn'>" + (r.severity || "-") + "</span>" },
          { label: "Market", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") + " " + marketLabel(r.market_type) },
          { label: "Occurrences", value: r => r.occurrences || 0 },
          { label: "Sample", value: r => JSON.stringify(r.sample || {}) },
          { label: "Last Seen", value: r => fmtDateTime(r.last_seen_at) }
        ], noBetIntelligence.rows || []);

        renderTable("clvDrift", [
          { label: "Rule", value: r => r.entity_key || "-" },
          { label: "Market", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") + " " + marketLabel(r.market_type) },
          { label: "Status", value: r => r.status === "CLV_COOLING" || r.status === "CLV_NEGATIVE" ? "<span class='loss'>" + r.status + "</span>" : (r.status === "CLV_IMPROVING" ? "<span class='value'>" + r.status + "</span>" : "<span class='warn'>" + (r.status || "-") + "</span>") },
          { label: "Sample", value: r => r.sample_size || 0 },
          { label: "Current CLV", value: r => r.current_avg_clv === null || r.current_avg_clv === undefined ? "-" : fmtPct(r.current_avg_clv) },
          { label: "Prev CLV", value: r => r.previous_avg_clv === null || r.previous_avg_clv === undefined ? "-" : fmtPct(r.previous_avg_clv) },
          { label: "Delta", value: r => r.delta_clv === null || r.delta_clv === undefined ? "-" : fmtPct(r.delta_clv) },
          { label: "Message", value: r => r.message || "-" }
        ], clvDrift.rows || []);

        renderTable("modelErrorExplorer", [
          { label: "Error", value: r => r.error_type || "-" },
          { label: "Match", value: r => matchLabel(r) },
          { label: "Severity", value: r => r.severity === "review" ? "<span class='warn'>review</span>" : "<span class='badge'>" + (r.severity || "watch") + "</span>" },
          { label: "Market", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") + " " + marketLabel(r.market_type) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Reason", value: r => r.error_reason || "-" },
          { label: "Entry", value: r => fmtOdds((r.metrics || {}).entry_odds) },
          { label: "Close", value: r => fmtOdds((r.metrics || {}).closing_odds) },
          { label: "CLV", value: r => (r.metrics || {}).clv === null || (r.metrics || {}).clv === undefined ? "-" : fmtPct((r.metrics || {}).clv) },
          { label: "Model Prob", value: r => (r.metrics || {}).model_probability === null || (r.metrics || {}).model_probability === undefined ? "-" : fmtPct((r.metrics || {}).model_probability) },
          { label: "P/L", value: r => ((r.metrics || {}).profit_loss || 0) + "u" }
        ], modelErrorExplorer.rows || []);

        renderTable("manualAlertReport", [
          { label: "Title", value: r => r.title || "Manual Real Paper Report" },
          { label: "Candidates", value: r => r.count || 0 },
          { label: "Telegram", value: r => r.telegram_mode || "manual_only" },
          { label: "Send Enabled", value: r => String(r.send_enabled) },
          { label: "Real Money", value: r => String(r.real_money_enabled) },
          { label: "Kelly", value: r => String(r.kelly_enabled) },
          { label: "Nota", value: r => "Generado para revision manual, no enviado automatico." }
        ], [manualAlertReport]);

        renderTable("pilotChecklist", [
          { label: "Check", value: r => r.check_name || "-" },
          { label: "Passed", value: r => r.passed ? "<span class='value'>SI</span>" : "<span class='loss'>NO</span>" },
          { label: "Value", value: r => r.value ?? "-" },
          { label: "Requirement", value: r => r.requirement || "-" }
        ], pilotChecklist.rows || []);

        renderTable("pilotReadiness", [
          { label: "Rule", value: r => r.rule_key || "-" },
          { label: "Status", value: r => "<span class='loss'>" + (r.status || "blocked") + "</span>" },
          { label: "Max Daily", value: r => (r.max_daily_stake_units || 0) + "u" },
          { label: "Max Pick", value: r => (r.max_pick_stake_units || 0) + "u" },
          { label: "Kill Switch", value: r => String(r.kill_switch_enabled) },
          { label: "Manual Confirm", value: r => String(r.manual_confirmation_required) },
          { label: "Telegram", value: r => r.telegram_mode || "manual_only" },
          { label: "Real Money", value: r => String(r.real_money_enabled) },
          { label: "Kelly", value: r => String(r.kelly_enabled) },
          { label: "Notes", value: r => r.notes || "-" }
        ], pilotReadiness.rows || []);

        renderTable("marketLab", [
          { label: "Sport", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") },
          { label: "Market", value: r => marketLabel(r.market_type) },
          { label: "Role", value: r => r.snapshot_role || "-" },
          { label: "Snapshots", value: r => r.snapshots || 0 },
          { label: "Matches", value: r => r.matches || 0 },
          { label: "Providers", value: r => r.providers || 0 },
          { label: "Clean", value: r => r.clean_snapshots || 0 },
          { label: "Review", value: r => r.review_snapshots || 0 },
          { label: "Avg Quality", value: r => r.avg_quality_score ?? "-" },
          { label: "Odds Range", value: r => fmtOdds(r.min_odds) + " - " + fmtOdds(r.max_odds) },
          { label: "Latest", value: r => fmtDateTime(r.latest_captured_at) }
        ], marketLab.rows || []);

        renderTable("marketProducts", [
          { label: "Producto", value: r => r.product || "-" },
          { label: "Market", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") + " " + marketLabel(r.market_type) },
          { label: "Segment", value: r => r.segment || "-" },
          { label: "Closed", value: r => (r.current_closed || 0) + "/" + (r.required_closed || 0) },
          { label: "CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "Profit", value: r => (r.profit_units || 0) + "u" },
          { label: "State", value: r => r.state === "READY_FOR_REVIEW" ? "<span class='value'>READY_FOR_REVIEW</span>" : (r.state === "BLOCKED" ? "<span class='loss'>BLOCKED</span>" : "<span class='warn'>" + (r.state || "-") + "</span>") },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], marketProducts.rows || []);

        renderTable("oddsConsensus", [
          { label: "Match", value: r => matchLabel(r) },
          { label: "Sport", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") },
          { label: "Market", value: r => marketLabel(r.market_type) },
          { label: "Line", value: r => r.line === null || r.line === undefined ? "-" : Number(r.line).toFixed(1) },
          { label: "Pick", value: r => pickLabel(r.selection) },
          { label: "Books", value: r => r.provider_count || 0 },
          { label: "Consensus", value: r => fmtOdds(r.consensus_odds) },
          { label: "Range", value: r => fmtOdds(r.min_odds) + " - " + fmtOdds(r.max_odds) },
          { label: "Score", value: r => r.consensus_score ?? "-" },
          { label: "Status", value: r => r.consensus_status === "CLEAN" ? "<span class='value'>CLEAN</span>" : "<span class='warn'>" + (r.consensus_status || "-") + "</span>" },
          { label: "Providers", value: r => (r.providers || []).join(", ") || "-" }
        ], oddsConsensus.rows || []);

        renderTable("backtestLab", [
          { label: "Rule", value: r => "MLB ML prob>=60%, EV>=5%, odds>=2.01" },
          { label: "Closed", value: r => r.closed || 0 },
          { label: "W/L/P", value: r => (r.wins || 0) + "/" + (r.losses || 0) + "/" + (r.pushes || 0) },
          { label: "Win Rate", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
          { label: "Avg Odds", value: r => fmtOdds(r.avg_entry_odds) },
          { label: "Avg EV", value: r => r.avg_expected_value === null || r.avg_expected_value === undefined ? "-" : fmtPct(r.avg_expected_value) },
          { label: "Avg CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "CLV+", value: r => r.positive_clv_rate === null || r.positive_clv_rate === undefined ? "-" : fmtPct(r.positive_clv_rate) },
          { label: "Profit", value: r => (r.profit_units || 0) + "u" },
          { label: "Decision", value: r => r.decision === "RULE_PASSED_REVIEW" ? "<span class='value'>RULE_PASSED_REVIEW</span>" : "<span class='warn'>" + (r.decision || "-") + "</span>" }
        ], [backtestLab.summary || {}]);

        renderTable("ruleExplorer", [
          { label: "Rank", value: (_r, i) => String(Number(i || 0) + 1) },
          { label: "Rule", value: r => r.rule_name || r.rule_key || "-" },
          { label: "Market", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") + " " + marketLabel(r.market_type) },
          { label: "Pick", value: r => r.pick ? pickLabel(r.pick) : "any" },
          { label: "Filters", value: r => "p>=" + fmtPct(r.min_model_probability) + " EV>=" + fmtPct(r.min_ev) + " odds " + fmtOdds(r.min_odds) + (r.max_odds ? "-" + fmtOdds(r.max_odds) : "+") },
          { label: "Closed", value: r => r.closed || 0 },
          { label: "W/L/P", value: r => (r.wins || 0) + "/" + (r.losses || 0) + "/" + (r.pushes || 0) },
          { label: "Win Rate", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
          { label: "CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "CLV+", value: r => r.positive_clv_rate === null || r.positive_clv_rate === undefined ? "-" : fmtPct(r.positive_clv_rate) },
          { label: "Profit", value: r => (r.profit_units || 0) + "u" },
          { label: "Score", value: r => r.rule_score ?? "-" },
          { label: "Decision", value: r => r.decision === "PROMOTE_TO_WATCHLIST" ? "<span class='value'>PROMOTE_TO_WATCHLIST</span>" : "<span class='warn'>" + (r.decision || "-") + "</span>" },
          { label: "Recommendation", value: r => r.recommendation || "-" },
          { label: "Watchlist", value: r => r.watchlist_status ? "<span class='badge real'>" + r.watchlist_status + "</span>" : "-" }
        ], ruleExplorer.rows || []);

        renderTable("ruleWatchlist", [
          { label: "Rule", value: r => r.rule_name || r.rule_key || "-" },
          { label: "Market", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") + " " + marketLabel(r.market_type) },
          { label: "Pick", value: r => r.pick ? pickLabel(r.pick) : "any" },
          { label: "Filters", value: r => "p>=" + fmtPct(r.min_model_probability) + " EV>=" + fmtPct(r.min_ev) + " odds " + fmtOdds(r.min_odds) + (r.max_odds ? "-" + fmtOdds(r.max_odds) : "+") },
          { label: "Closed", value: r => (r.metrics || {}).closed || 0 },
          { label: "W/L/P", value: r => ((r.metrics || {}).wins || 0) + "/" + ((r.metrics || {}).losses || 0) + "/" + ((r.metrics || {}).pushes || 0) },
          { label: "Win Rate", value: r => (r.metrics || {}).win_rate === null || (r.metrics || {}).win_rate === undefined ? "-" : fmtPct((r.metrics || {}).win_rate) },
          { label: "CLV", value: r => (r.metrics || {}).avg_clv === null || (r.metrics || {}).avg_clv === undefined ? "-" : fmtPct((r.metrics || {}).avg_clv) },
          { label: "CLV+", value: r => (r.metrics || {}).positive_clv_rate === null || (r.metrics || {}).positive_clv_rate === undefined ? "-" : fmtPct((r.metrics || {}).positive_clv_rate) },
          { label: "Profit", value: r => ((r.metrics || {}).profit_units || 0) + "u" },
          { label: "Score", value: r => (r.metrics || {}).rule_score ?? "-" },
          { label: "Status", value: r => "<span class='badge real'>" + (r.status || "watch") + "</span>" },
          { label: "Reason", value: r => r.promoted_reason || "-" },
          { label: "Promoted", value: r => fmtDateTime(r.promoted_at) }
        ], ruleWatchlist.rows || []);

        renderTable("backtestRuns", [
          { label: "Run", value: r => r.run_name || "-" },
          { label: "Market", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") + " " + marketLabel(r.market_type) },
          { label: "Closed", value: r => (r.results || {}).closed || 0 },
          { label: "Profit", value: r => ((r.results || {}).profit_units || 0) + "u" },
          { label: "CLV", value: r => (r.results || {}).avg_clv === null || (r.results || {}).avg_clv === undefined ? "-" : fmtPct((r.results || {}).avg_clv) },
          { label: "Decision", value: r => (r.results || {}).decision || "-" },
          { label: "Created", value: r => fmtDateTime(r.created_at) }
        ], backtestRuns.rows || []);

        renderTable("modelRegistry", [
          { label: "Model", value: r => r.model_name },
          { label: "Status", value: r => r.status === "active" ? "<span class='value'>active</span>" : "<span class='badge'>" + (r.status || "-") + "</span>" },
          { label: "Sport", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") },
          { label: "Version", value: r => r.version_label || "-" },
          { label: "Sample", value: r => r.sample_size ?? "-" },
          { label: "Accuracy", value: r => r.accuracy === null || r.accuracy === undefined ? "-" : fmtPct(r.accuracy) },
          { label: "Brier", value: r => r.brier_score ?? "-" },
          { label: "Bias", value: r => r.bias_home ?? "-" },
          { label: "Updated", value: r => fmtDateTime(r.parameters_updated_at || r.updated_at) }
        ], modelRegistry.rows || []);

        renderTable("featureStore", [
          { label: "Sport", value: r => r.sport_slug || "-" },
          { label: "Model", value: r => r.model_name || "-" },
          { label: "Feature Rows", value: r => r.feature_rows || 0 },
          { label: "Matches", value: r => r.matches || 0 },
          { label: "First", value: r => fmtDateTime(r.first_generated_at) },
          { label: "Latest", value: r => fmtDateTime(r.latest_generated_at) }
        ], featureStore.rows || []);

        const riskRows = [{ rule_key: "decision", rule_name: riskEngine.decision, severity: "info", rule_value: riskEngine.recent_clv || {}, is_active: true }].concat(riskEngine.rules || []);
        renderTable("riskEngine", [
          { label: "Rule", value: r => r.rule_key || "-" },
          { label: "Name", value: r => r.rule_name || "-" },
          { label: "Severity", value: r => r.severity === "block" ? "<span class='loss'>block</span>" : "<span class='warn'>" + (r.severity || "-") + "</span>" },
          { label: "Active", value: r => r.is_active === false ? "false" : "true" },
          { label: "Value", value: r => JSON.stringify(r.rule_value || {}) },
          { label: "Notes", value: r => r.notes || "-" }
        ], riskRows);

        renderTable("liveCandidates", [
          { label: "Match", value: r => matchLabel(r) },
          { label: "Sport", value: r => (r.sport_slug || "-") + "/" + (r.league_slug || "-") },
          { label: "Model", value: r => r.model_name || "-" },
          { label: "Market", value: r => marketLabel(r.market_type) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Bookmaker", value: r => r.bookmaker || "-" },
          { label: "Odds", value: r => fmtOdds(r.entry_odds) },
          { label: "Prob", value: r => fmtPct(r.model_probability) },
          { label: "EV", value: r => "<span class='value'>" + fmtPct(r.expected_value) + "</span>" },
          { label: "Status", value: r => r.status || "-" },
          { label: "Entry", value: r => fmtDateTime(r.entry_timestamp) }
        ], liveCandidates.rows || []);

        renderTable("portfolio", [
          { label: "Total", value: r => r.totals.total },
          { label: "Cerradas", value: r => r.totals.closed },
          { label: "Wins", value: r => r.totals.wins },
          { label: "Losses", value: r => r.totals.losses },
          { label: "Win Rate", value: r => r.totals.win_rate === null ? "-" : fmtPct(r.totals.win_rate) },
          { label: "Open", value: r => r.totals.open },
          { label: "Pending Closing", value: r => r.totals.pending_closing },
          { label: "Pending Results", value: r => r.totals.pending_results },
          { label: "Profit", value: r => (r.totals.profit_units || 0) + "u" },
          { label: "Guardrails", value: r => "Kelly: off | Real money: off | Telegram auto: off" }
        ], [portfolio]);

        renderTable("portfolioCalibration", [
          { label: "Flow", value: r => r.flow === "real_paper" ? "Real Paper" : "Shadow Paper" },
          { label: "Sport", value: r => r.sport_slug + "/" + r.league_slug },
          { label: "Market", value: r => marketLabel(r.market_type) },
          { label: "Line", value: r => r.line === null || r.line === undefined ? "-" : Number(r.line).toFixed(1) },
          { label: "Closed", value: r => r.closed },
          { label: "Target", value: r => r.target_closed },
          { label: "Faltan", value: r => r.remaining_to_50 },
          { label: "Decision", value: r => r.ready_for_review ? "<span class='value'>Revisar</span>" : "<span class='warn'>Acumular</span>" }
        ], portfolio.calibration || []);

        renderTable("smart", [
          { label: "AcciÃ³n", value: r => "<span class='action'>" + actionText(r) + "</span>" },
          { label: "Match", value: r => matchLabel(r) },
          { label: "Sport", value: r => r.sport_slug + "/" + r.league_slug },
          { label: "Mercado", value: r => marketLabel(r.market_type) },
          { label: "LÃ­nea", value: r => r.line === null || r.line === undefined ? "-" : Number(r.line).toFixed(1) },
          { label: "Pick", value: r => "<span class='badge'>" + pickLabel(r.market_selection) + "</span>" },
          { label: "EV", value: r => "<span class='value'>" + fmtPct(r.expected_value) + "</span>" },
          { label: "Model Score", value: r => fmtPct(r.confidence) },
          { label: "Fair", value: r => fmtOdds(r.model_fair_odds) },
          { label: "Market", value: r => fmtOdds(r.market_odds) },
          { label: "Age", value: r => (r.market_age_seconds || 0) + "s" }
        ], smart.selections || []);

        const smartRows = smart.selections || [];
        const primarySmartRows = smartRows.filter(r => !isRunLineDiagnostic(r));
        const runLineDiagnosticRows = smartRows.filter(r => isRunLineDiagnostic(r));
        $("mSmart").textContent = primarySmartRows.length;
        const columns = smartColumns();
        renderTable("realPicks", columns, primarySmartRows.filter(r => r.audit_status === "REAL_CANDIDATE"));
        renderTable("realPaperPicks", columns, primarySmartRows.filter(r => r.audit_status === "REAL_PAPER_CANDIDATE"));
        renderTable("radarPicks", columns, primarySmartRows.filter(r => (r.audit_status || "RADAR_ONLY") === "RADAR_ONLY"));
        renderTable("reviewPicks", columns, primarySmartRows.filter(r => r.audit_status === "REVIEW"));
        renderTable("runLineDiagnostics", columns, runLineDiagnosticRows);
        renderTable("noBetPicks", columns, primarySmartRows.filter(r => r.audit_status === "NO_BET"));

        renderTable("parlays", [
          { label: "Tipo", value: r => r.label },
          { label: "Estado", value: r => r.status === "ready" ? "<span class='value'>Listo real</span>" : (r.status === "radar" ? "<span class='badge radar'>Radar</span>" : "<span class='warn'>Faltan piernas</span>") },
          { label: "Legs", value: r => r.legs_count || ((r.available_legs || 0) + "/" + (r.needed_legs || 0)) },
          { label: "Cuota Est.", value: r => r.estimated_odds ? fmtOdds(r.estimated_odds) : "-" },
          { label: "EV Combo", value: r => r.expected_value !== undefined ? "<span class='value'>" + fmtPct(r.expected_value) + "</span>" : "-" },
          { label: "Corr.", value: r => r.correlation_penalty ? fmtPct(r.correlation_penalty) : "-" },
          { label: "Stake", value: r => fmtPct(r.stake_fraction) },
          { label: "Selecciones", value: r => parlayLegsText(r) },
          { label: "Nota", value: r => r.reason || r.note || "Shadow only" }
        ], parlays.parlays || []);

        renderTable("alpha", [
          { label: "AcciÃ³n", value: r => "<span class='action'>" + actionText(r) + "</span>" },
          { label: "Match", value: r => matchLabel(r) },
          { label: "Model", value: r => r.model_name },
          { label: "Provider", value: r => r.provider_name },
          { label: "Mercado", value: r => marketLabel(r.market_type) },
          { label: "LÃ­nea", value: r => r.line === null || r.line === undefined ? "-" : Number(r.line).toFixed(1) },
          { label: "Pick", value: r => pickLabel(r.market_selection) },
          { label: "EV", value: r => "<span class='value'>" + fmtPct(r.expected_value) + "</span>" },
          { label: "Processed", value: r => String(r.processed) }
        ], alpha.opportunities || []);

        renderTable("alpha", [
          { label: "Audit", value: r => auditBadge(r) },
          { label: "Accion", value: r => "<span class='action'>" + actionText(r) + "</span>" },
          { label: "Match", value: r => matchLabel(r) },
          { label: "Model", value: r => r.model_name },
          { label: "Provider", value: r => r.provider_name },
          { label: "Mercado", value: r => marketLabel(r.market_type) },
          { label: "Linea", value: r => r.line === null || r.line === undefined ? "-" : Number(r.line).toFixed(1) },
          { label: "Pick", value: r => pickLabel(r.market_selection) },
          { label: "EV Real", value: r => "<span class='value'>" + fmtPct(r.real_expected_value ?? r.expected_value) + "</span>" },
          { label: "Model Prob", value: r => fmtPct(r.model_probability_audit ?? r.model_probability) },
          { label: "Implied Prob", value: r => fmtPct(r.implied_probability) },
          { label: "Reason", value: r => r.audit_reason || "-" },
          { label: "Processed", value: r => String(r.processed) }
        ], alpha.opportunities || []);

        renderTable("live", [
          { label: "Match", value: r => matchLabel(r) },
          { label: "Sport", value: r => r.sport_slug + "/" + r.league_slug },
          { label: "Mercado", value: r => marketLabel(r.market_type) },
          { label: "LÃ­nea", value: r => r.line === null || r.line === undefined ? "-" : Number(r.line).toFixed(1) },
          { label: "Best", value: r => "<span class='badge'>" + pickLabel(r.best_selection) + "</span>" },
          { label: "Fair", value: r => fmtOdds(r.best_fair_odds) },
          { label: "Model Score", value: r => fmtPct(r.confidence) },
          { label: "Status", value: r => r.status }
        ], live.board || []);

        renderTable("performance", [
          { label: "Model", value: r => r.model_name },
          { label: "Sport", value: r => r.sport_slug + "/" + r.league_slug },
          { label: "Market", value: r => marketLabel(r.market_type) },
          { label: "Group", value: r => r.market_group || "-" },
          { label: "Line", value: r => r.line === null || r.line === undefined ? "-" : Number(r.line).toFixed(1) },
          { label: "N", value: r => r.total_predictions },
          { label: "Push", value: r => r.pushes || 0 },
          { label: "Accuracy", value: r => r.accuracy_pct + "%" },
          { label: "Brier", value: r => r.avg_brier_score },
          { label: "Flat Profit", value: r => r.theoretical_flat_profit_units + "u" }
        ], perf.performance || []);

        renderTable("paper", [
          { label: "Banco", value: r => r.banco_control_actual_mxn },
          { label: "Balance", value: r => r.balance_neto_mxn },
          { label: "ROI", value: r => r.auditoria.roi_percentage + "%" },
          { label: "Yield", value: r => r.auditoria.yield_percentage + "%" },
          { label: "Picks", value: r => r.auditoria.total_picks }
        ], [paper]);

        renderTable("realPerformance", [
          { label: "Model", value: r => r.model_name || "-" },
          { label: "Sport", value: r => r.sport_slug ? r.sport_slug + "/" + r.league_slug : "Sin datos reales" },
          { label: "Market", value: r => r.market_type ? marketLabel(r.market_type) : "-" },
          { label: "Line", value: r => r.line === null || r.line === undefined ? "-" : Number(r.line).toFixed(1) },
          { label: "Total", value: r => r.total || 0 },
          { label: "Open", value: r => r.open || 0 },
          { label: "Settled", value: r => r.settled || 0 },
          { label: "Avg EV", value: r => r.avg_expected_value === undefined ? "-" : fmtPct(r.avg_expected_value) },
          { label: "Avg CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "P/L", value: r => (r.profit_loss_units || 0) + "u" }
        ], (realPaper.real_paper || []).length ? realPaper.real_paper : [{
          model_name: "-",
          sport_slug: null,
          market_type: null,
          total: 0,
          open: 0,
          settled: 0,
          profit_loss_units: 0
        }]);

        renderTable("markets", [
          { label: "Deporte", value: r => r.sport },
          { label: "Listo ahora", value: r => r.ready },
          { label: "Siguiente expansiÃƒÂ³n", value: r => r.next },
          { label: "Nota", value: r => r.note }
        ], [
          { sport: "FÃƒÂºtbol", ready: "1X2, DNB, Over/Under 2.5, BTTS", next: "Doble oportunidad, hÃƒÂ¡ndicap asiÃƒÂ¡tico", note: "Poisson alimenta goles esperados y mercados derivados." },
          { sport: "MLB", ready: "Moneyline 2 vÃ­as, total carreras. Run line solo diagnÃƒÂ³stico.", next: "Run line real con enable_real_runline=true, team totals, pitcher props", note: "Run line real queda bloqueado por defecto hasta revisiÃƒÂ³n manual." },
          { sport: "NBA", ready: "Moneyline 2 vÃ­as", next: "Spread, total puntos, team totals, player props", note: "Requiere margen proyectado y pace/eficiencia." },
          { sport: "Tenis", ready: "Pendiente", next: "Ganador partido, hÃƒÂ¡ndicap games/sets, total games, correct score", note: "Primero hay que crear fetcher y engine 2 vÃ­as." }
        ]);

        $("status").textContent = "OK " + new Date().toLocaleTimeString();
      } catch (err) {
        const msg = err.message || "";
        $("status").textContent = msg.includes("401")
          ? "Error 401: pega la X-Internal-API-Key correcta, guarda y actualiza."
          : "Error: " + msg;
      }
    }
    load();
  </script>
</body>
</html>`;

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/dashboard/trading", async (_request, reply) => {
    return reply.type("text/html").send(dashboardHtml);
  });
}


























