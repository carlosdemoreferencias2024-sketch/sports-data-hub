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
    .status-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 18px;
      padding: 10px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .status-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 30px;
      padding: 5px 9px;
      border-radius: 999px;
      background: #eef0f5;
      color: #3d4658;
      font-size: 12px;
      font-weight: 850;
      white-space: nowrap;
    }
    .status-chip strong { color: var(--ink); }
    .status-chip.ok { background: #e8f7ef; color: #0f6a3b; }
    .status-chip.warn { background: #fff3d8; color: #7a4b00; }
    .status-chip.bad { background: #ffe8e5; color: #9f1d16; }
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
    section h2 small {
      font-size: 12px;
      font-weight: 600;
    }
    .section-note {
      margin: 0;
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      background: #fff;
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
    .executive-decision {
      border-color: #c9d6fb;
      background: #fff;
    }
    .executive-decision.state-confirmed { border-color: #9bd7b4; }
    .executive-decision.state-near { border-color: #f3d08b; }
    .executive-decision.state-review { border-color: #c9d6fb; }
    .executive-decision.state-no-bet { border-color: #d8deea; }
    .exec-top {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(170px, 240px);
      gap: 14px;
      padding: 16px;
      align-items: stretch;
    }
    .executive-decision h2 {
      margin: 8px 0 6px;
      padding: 0;
      border: 0;
      background: transparent;
      font-size: 28px;
      line-height: 1.1;
    }
    .exec-summary {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.45;
    }
    .exec-badge {
      display: inline-block;
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 12px;
      font-weight: 900;
      background: #eef0f5;
      color: #3d4658;
    }
    .exec-badge.confirmed { background: #e8f7ef; color: #0f6a3b; }
    .exec-badge.near { background: #fff3d8; color: #7a4b00; }
    .exec-badge.review { background: #eef3ff; color: #183e91; }
    .exec-badge.no-bet { background: #eef0f5; color: #3d4658; }
    .exec-action {
      border: 1px solid #edf0f6;
      border-radius: 8px;
      background: #fbfcff;
      padding: 12px;
      min-height: 112px;
    }
    .exec-action span,
    .exec-kpi span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .exec-action strong {
      display: block;
      margin-top: 8px;
      font-size: 22px;
      color: var(--red);
      line-height: 1.1;
    }
    .exec-action p {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .exec-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      padding: 0 16px 14px;
    }
    .exec-kpi {
      border: 1px solid #edf0f6;
      border-radius: 8px;
      background: #fff;
      padding: 10px;
      min-height: 72px;
    }
    .exec-kpi strong { display: block; margin-top: 5px; font-size: 18px; }
    .exec-reason-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 10px;
      padding: 0 16px 16px;
    }
    .exec-reason {
      border: 1px solid #edf0f6;
      border-radius: 8px;
      background: #fbfcff;
      padding: 10px;
      min-height: 84px;
    }
    .exec-reason strong { display: block; font-size: 13px; margin-bottom: 4px; }
    .exec-reason p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.35; }
    .pick-card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 12px; }
    .pick-card { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 14px; }
    .pick-card h3 { margin: 0 0 8px; font-size: 16px; }
    .live-board-shell {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
      gap: 12px;
      padding: 14px;
      background: #fbfcff;
    }
    .live-sidebar, .live-detail {
      border: 1px solid #edf0f6;
      border-radius: 8px;
      background: #fff;
      padding: 12px;
    }
    .live-alerts {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
      background: #fff;
    }
    .live-alert {
      flex: 0 0 auto;
      border: 1px solid #edf0f6;
      border-radius: 999px;
      padding: 6px 10px;
      background: #fbfcff;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .live-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: #fff;
    }
    .live-pill {
      border: 1px solid #d8deea;
      border-radius: 999px;
      padding: 6px 10px;
      background: #fff;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }
    .live-pill strong { color: var(--ink); }
    .live-league-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid #edf0f6;
      font-size: 13px;
    }
    .live-league-row:last-child { border-bottom: 0; }
    .live-card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 10px;
    }
    .live-match-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 12px;
      cursor: pointer;
    }
    .live-match-card:hover { border-color: #b9c8f3; box-shadow: 0 4px 14px rgba(23, 32, 51, .06); }
    .live-match-card header {
      position: static;
      padding: 0;
      border: 0;
      background: transparent;
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }
    .live-match-card h3 { margin: 0; font-size: 15px; line-height: 1.25; }
    .live-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 8px 0 0;
    }
    .live-status {
      display: inline-block;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 850;
      background: #eef0f5;
      color: #3d4658;
    }
    .live-status.confirmed { background: #e8f7ef; color: #0f6a3b; }
    .live-status.review { background: #fff3d8; color: #7a4b00; }
    .live-status.blocked { background: #ffe8e5; color: #9f1d16; }
    .live-status.shadow { background: #eef3ff; color: #183e91; }
    .live-detail h3 { margin: 0 0 8px; }
    .live-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .live-detail-grid div { border: 1px solid #edf0f6; border-radius: 6px; padding: 8px; background: #fbfcff; }
    .live-detail-grid span { display: block; color: var(--muted); font-size: 11px; }
    .live-detail-grid strong { display: block; margin-top: 3px; font-size: 13px; }
    .manual-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
      padding: 14px;
    }
    .manual-item {
      border: 1px solid #edf0f6;
      border-radius: 8px;
      padding: 12px;
      background: #fff;
      min-height: 84px;
    }
    .manual-item strong { display: block; font-size: 13px; margin-bottom: 5px; }
    .manual-item p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.35; }
    .quality-strip { margin: 10px 0; }
    .quality-strip label {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      margin-bottom: 5px;
    }
    .quality-track {
      height: 10px;
      border-radius: 999px;
      background: #edf0f6;
      overflow: hidden;
    }
    .quality-fill { height: 100%; width: 0%; background: var(--red); }
    .quality-fill.weak { background: var(--red); }
    .quality-fill.incomplete { background: var(--yellow); }
    .quality-fill.reviewable { background: var(--blue); }
    .quality-fill.strong { background: var(--green); }
    .checklist-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 8px;
      margin: 10px 0;
    }
    .check-item {
      border: 1px solid #edf0f6;
      border-radius: 8px;
      padding: 8px;
      background: #fbfcff;
      min-height: 62px;
    }
    .check-item.pass { border-color: #bfe8d0; background: #f4fbf7; }
    .check-item.wait { border-color: #f3d9a2; background: #fff9ec; }
    .check-item.fail { border-color: #fac7c1; background: #fff6f4; }
    .check-item strong { display: block; font-size: 12px; margin-bottom: 3px; }
    .check-item span { display: block; color: var(--muted); font-size: 11px; line-height: 1.25; }
    .why-box {
      border: 1px solid #f3d9a2;
      border-radius: 8px;
      padding: 10px;
      margin: 10px 0;
      background: #fff9ec;
    }
    .why-box strong { display: block; margin-bottom: 4px; }
    .why-box p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.4; }
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
      .exec-top { grid-template-columns: 1fr; }
      .exec-grid { grid-template-columns: 1fr 1fr; }
      .live-board-shell { grid-template-columns: 1fr; }
      .live-detail-grid { grid-template-columns: 1fr; }
      .pick-meta { grid-template-columns: 1fr; }
      .steps { grid-template-columns: 1fr; }
    }
    @media (max-width: 560px) {
      header, main { padding-left: 14px; padding-right: 14px; }
      .controls, .metrics, .playbook, .command-grid { grid-template-columns: 1fr; }
      .exec-grid { grid-template-columns: 1fr; }
      .executive-decision h2 { font-size: 22px; }
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
    <div id="dashboardStatusBar" class="status-bar">
      <span class="status-chip ok">Modo <strong id="sbCommandState">REVIEW_ONLY</strong></span>
      <span class="status-chip ok">REAL_CANDIDATE <strong id="sbRealCandidate">0</strong></span>
      <span class="status-chip ok">Dinero real <strong id="sbRealMoney">OFF</strong></span>
      <span class="status-chip ok">Kelly <strong id="sbKelly">OFF</strong></span>
      <span class="status-chip ok">Telegram <strong id="sbTelegram">OFF</strong></span>
      <span class="status-chip">Confirmed <strong id="sbConfirmed">0</strong></span>
      <span class="status-chip">Bettable <strong id="sbBettable">0</strong></span>
      <span class="status-chip warn">Closing ahora <strong id="sbClosingNow">0</strong></span>
      <span class="status-chip warn">Near-start <strong id="sbNearStart">0</strong></span>
      <span class="status-chip warn">Missed <strong id="sbMissed">0</strong></span>
      <span class="status-chip">On-time <strong id="sbOnTime">0</strong></span>
      <span class="status-chip">Settlement <strong id="sbReadySettlement">0</strong></span>
      <span class="status-chip">Source pending <strong id="sbSourcePending">0</strong></span>
      <span class="status-chip">Evidence <strong id="sbEvidence">0</strong></span>
      <span class="status-chip warn">Stale odds <strong id="sbStaleOdds">0</strong></span>
    </div>
    <div class="metrics">
      <div class="metric"><span>Live Board</span><strong id="mLive">0</strong></div>
      <div class="metric"><span>Smart EV+</span><strong id="mSmart">0</strong></div>
      <div class="metric"><span>Alpha Pendiente</span><strong id="mAlpha">0</strong></div>
      <div class="metric"><span>Profit Teórico Simulado / Lab</span><strong id="mProfit">0u</strong><small class="muted">No representa dinero real ni profit confirmado.</small></div>
    </div>
    <section id="safetySuiteHeader" class="executive-decision state-review">
      <div class="exec-top">
        <div>
          <span id="safetySuiteBadge" class="exec-badge review">CARGANDO</span>
          <h2 id="safetySuiteHeadline">Cargando Safety Suite</h2>
          <p id="safetySuiteSummary" class="exec-summary">Revisando typecheck, guardrails, closing window, Source Capture y health.</p>
        </div>
        <div class="exec-action">
          <span>Semáforo operativo</span>
          <strong id="safetySuiteAction">ESPERAR</strong>
          <p id="safetySuiteReason">No usar slate hasta validar modo seguro.</p>
        </div>
      </div>
      <div class="exec-grid">
        <div class="exec-kpi"><span>Último check</span><strong id="safetySuiteCheckedAt">-</strong></div>
        <div class="exec-kpi"><span>Guardrails</span><strong id="safetySuiteGuardrails">-</strong></div>
        <div class="exec-kpi"><span>Reporte</span><strong id="safetySuiteReport">-</strong></div>
        <div class="exec-kpi"><span>Pasos</span><strong id="safetySuiteSteps">-</strong></div>
      </div>
      <div id="safetySuiteDetails" class="exec-reason-list"></div>
    </section>
    <section id="executiveDecisionHeader" class="executive-decision state-no-bet">
      <div class="exec-top">
        <div>
          <span id="execStateBadge" class="exec-badge no-bet">CARGANDO</span>
          <h2 id="execHeadline">Cargando decisión diaria</h2>
          <p id="execSummary" class="exec-summary">Leyendo Command Center, cadena confirmada y calidad de datos.</p>
        </div>
        <div class="exec-action">
          <span>Acción de hoy</span>
          <strong id="execAction">ESPERAR</strong>
          <p id="execActionReason">No hay autorización para dinero real.</p>
        </div>
      </div>
      <div class="exec-grid">
        <div class="exec-kpi"><span>Confirmados paper</span><strong id="execConfirmedPaper">0</strong></div>
        <div class="exec-kpi"><span>Candidatos activos</span><strong id="execActivePicks">0</strong></div>
        <div class="exec-kpi"><span>Data fuerte</span><strong id="execStrongData">0</strong></div>
        <div class="exec-kpi"><span>Guardrails</span><strong id="execGuardrails">ON</strong></div>
      </div>
      <div id="execReasonList" class="exec-reason-list"></div>
    </section>
    <section id="nextOperationalAction" class="executive-decision state-review">
      <div class="exec-top">
        <div>
          <span id="noaBadge" class="exec-badge review">CARGANDO</span>
          <h2 id="noaHeadline">Cargando próxima acción</h2>
          <p id="noaSummary" class="exec-summary">Leyendo Operational Window Queue.</p>
        </div>
        <div class="exec-action">
          <span>Comando sugerido</span>
          <strong id="noaAction">ESPERAR</strong>
          <p id="noaCommand">No ejecutar comando todavía.</p>
        </div>
      </div>
      <div class="exec-grid">
        <div class="exec-kpi"><span>Partido</span><strong id="noaMatch">-</strong></div>
        <div class="exec-kpi"><span>Ventana</span><strong id="noaWindow">-</strong></div>
        <div class="exec-kpi"><span>Tiempo</span><strong id="noaTimeLeft">-</strong></div>
        <div class="exec-kpi"><span>Riesgo</span><strong id="noaRisk">-</strong></div>
      </div>
      <div id="noaNextStep" class="exec-reason-list"></div>
    </section>
    <section id="whyNoPickToday">
      <h2>Why No Pick Today? <small class="muted">(español simple)</small></h2>
      <p id="whyNoPickTodaySummary" class="section-note">Cargando razones principales.</p>
      <div id="whyNoPickTodayList" class="exec-reason-list"></div>
    </section>
    <section id="picksToFollow"><h2>Picks a seguir <small class="muted">(watchlist operativo, no dinero real)</small></h2>
      <p id="picksToFollowRecommendation" class="section-note">Cargando candidatos para monitorear. Esta lista no sale de Paper Performance histórico.</p>
      <div class="command-grid">
        <div class="command-card"><span>Seguir ahora</span><strong id="ptfTotal">0</strong><p>Candidatos con lectura actual.</p></div>
        <div class="command-card"><span>Prioridad alta</span><strong id="ptfHigh">0</strong><p>Bettable/waiting closing.</p></div>
        <div class="command-card"><span>Esperar closing</span><strong id="ptfClosing">0</strong><p>Ventana 10 a 3 min.</p></div>
        <div class="command-card"><span>Dinero real</span><strong id="ptfRealMoney">OFF</strong><p>Guardrail fijo.</p></div>
      </div>
      <div class="table-wrap"><table id="picksToFollowTable"></table></div>
    </section>
    <section id="dashboardManual"><h2>Cómo leer este tablero <small class="muted">(semáforos rápidos)</small></h2>
      <p class="section-note">Esto no es una pantalla de apuestas reales. Es una mesa de control: primero observa, luego revisa contexto, después confirma solo en paper.</p>
      <div class="manual-grid">
        <div class="manual-item"><strong><span class="live-status shadow">OBSERVATION_ONLY</span></strong><p>Solo dato de calendario/mercado. Sirve para alimentar el universo, no es pick.</p></div>
        <div class="manual-item"><strong><span class="live-status review">CONTEXT_GAPS</span></strong><p>Interesante, pero faltan datos como lineup, team intelligence o consenso.</p></div>
        <div class="manual-item"><strong><span class="live-status review">PARTIAL_CONTEXT_REVIEW</span></strong><p>Ya tiene parte del contexto; sigue en revisión, sin confirmar.</p></div>
        <div class="manual-item"><strong><span class="live-status confirmed">MATCHUP_CONTEXT_SUPPORTS</span></strong><p>El contexto apoya la lectura del modelo. Todavía es paper.</p></div>
        <div class="manual-item"><strong><span class="live-status confirmed">CONFIRMED_PAPER</span></strong><p>Candidato paper serio con cadena completa. No activa dinero real.</p></div>
        <div class="manual-item"><strong><span class="live-status blocked">REAL_CANDIDATE</span></strong><p>Debe seguir bloqueado hasta autorización explícita. Kelly y dinero real apagados.</p></div>
      </div>
    </section>
    <section id="sportsLiveBoard"><h2>Match Center <small class="muted">(LiveScore + mesa de decision)</small></h2>
      <p id="liveBoardRecommendation" class="section-note">Cargando Match Center. Vista por partido, sin activar dinero real.</p>
      <div id="liveBoardAlerts" class="live-alerts"></div>
      <div class="live-toolbar">
        <span class="live-pill">Fecha <strong id="liveBoardDate">-</strong></span><input id="matchCenterDate" type="date" style="height:30px;max-width:150px;" /><button id="matchCenterToday" type="button" style="height:30px;">Hoy</button><button id="matchCenterTomorrow" type="button" style="height:30px;">Mañana</button>
        <span class="live-pill">Partidos <strong id="liveGamesToday">0</strong></span>
        <span class="live-pill">Confirmed Paper <strong id="liveConfirmedPaper">0</strong></span>
        <span class="live-pill">Review <strong id="liveReview">0</strong></span>
        <span class="live-pill">Blocked <strong id="liveBlocked">0</strong></span>
        <span class="live-pill">Settlement <strong id="livePendingSettlement">0</strong></span>
      </div>
      <div class="live-board-shell">
        <aside class="live-sidebar">
          <strong>Ligas activas</strong>
          <div id="liveLeagueList"></div>
        </aside>
        <div>
          <div id="liveMatchCards" class="live-card-grid"></div>
          <div id="liveMatchDetail" class="live-detail" style="margin-top:12px;"></div>
        </div>
      </div>
    </section>
    <section id="bestBetsPerMatch"><h2>Best Bet Per Match <small class="muted">(fair odds -> mercado -> EV -> cadena paper)</small></h2>
      <p id="bestBetsPerMatchRecommendation" class="section-note">Cargando mejores lecturas por partido. Nuestra API calcula fair odds; solo hay EV cuando existe cuota real verificable.</p>
      <div class="command-grid">
        <div class="command-card"><span>Partidos</span><strong id="bbmMatches">0</strong><p>Con lectura disponible.</p></div>
        <div class="command-card"><span>Confirmed Paper</span><strong id="bbmConfirmed">0</strong><p>Solo paper.</p></div>
        <div class="command-card"><span>Bettable Paper</span><strong id="bbmBettable">0</strong><p>Candidatos paper, no real.</p></div>
        <div class="command-card"><span>Shadow Ticket</span><strong id="bbmShadowTicket">0</strong><p>Ticket auditable con odds/modelo/EV.</p></div>
        <div class="command-card"><span>Calibrating</span><strong id="bbmCalibrating">0</strong><p>Futbol con EV, modelo en gate.</p></div>
        <div class="command-card"><span>Waiting closing</span><strong id="bbmWaitingClosing">0</strong><p>Falta cierre valido.</p></div>
        <div class="command-card"><span>Sin capa financiera</span><strong id="bbmNoFinancial">0</strong><p>Faltan odds/modelo/EV.</p></div>
        <div class="command-card"><span>Near-start update</span><strong id="bbmNearStart">-</strong><p id="bbmNearStartMeta">Sin corrida near-start.</p></div>
      </div>
      <div class="table-wrap"><table id="bestBetsPerMatchTable"></table></div>
    </section>
    <section id="bottleneckBySource"><h2>Bottleneck by Source <small class="muted">(campo -> fuente -> modulo -> ventana)</small></h2>
      <p id="bottleneckBySourceRecommendation" class="section-note">Cargando pared de informacion. No crea picks ni escribe datos.</p>
      <div class="command-grid">
        <div class="command-card"><span>Por que no avanzamos</span><strong id="bbsMainBlock">-</strong><p id="bbsMainAction">Esperando diagnostico.</p></div>
        <div class="command-card"><span>Futbol bloqueo principal</span><strong id="bbsFootballBlock">-</strong><p>Fuente/modulo que mas urge.</p></div>
        <div class="command-card"><span>MLB bloqueo principal</span><strong id="bbsMlbBlock">-</strong><p>Fuente/modulo que mas urge.</p></div>
        <div class="command-card"><span>Tickets waiting closing</span><strong id="bbsWaitingClosing">0</strong><p>Necesitan closing valido.</p></div>
        <div class="command-card"><span>MLB post-kickoff</span><strong id="bbsMlbPostKickoff">0</strong><p>Ya no aceptan captura pregame.</p></div>
        <div class="command-card"><span>Fuente externa</span><strong id="bbsExternalSource">0</strong><p>Campos que requieren proveedor/manual.</p></div>
      </div>
      <div class="table-wrap"><table id="bottleneckBySourceTable"></table></div>
    </section>
    <section id="closingWindowWatch"><h2>Closing Window Watch <small class="muted">(10 a 3 min antes del inicio)</small></h2>
      <p id="closingWindowWatchRecommendation" class="section-note">Cargando ventanas de closing. No captura ni aplica cuotas.</p>
      <div class="command-grid">
        <div class="command-card"><span>En ventana valida</span><strong id="cwwValid">0</strong><p>Capturable ahora si hay cuota verificable.</p></div>
        <div class="command-card"><span>Esperando ventana</span><strong id="cwwWaiting">0</strong><p>Aun no es closing.</p></div>
        <div class="command-card"><span>Ventana perdida</span><strong id="cwwMissed">0</strong><p>Solo auditoria post-kickoff.</p></div>
        <div class="command-card"><span>Captured on-time</span><strong id="cwwOnTime">0</strong><p>Sirve para CLV/segmentos.</p></div>
        <div class="command-card"><span>Football waiting</span><strong id="cwwFootballWaiting">0</strong><p>Shadow tickets antes de kickoff.</p></div>
        <div class="command-card"><span>MLB missed/waiting</span><strong id="cwwMlbWaiting">0</strong><p>Separado para no mezclar los 11.</p></div>
      </div>
      <div class="table-wrap"><table id="closingWindowWatchTable"></table></div>
    </section>
    <section id="closingCaptureDraft"><h2>Closing Capture Draft <small class="muted">(payload listo, no se envía automático)</small></h2>
      <p id="closingCaptureDraftRecommendation" class="section-note">Cargando borradores de captura. Completa solo cuota real y timestamp cuando diga CAPTURE_CLOSING_NOW.</p>
      <div class="command-grid">
        <div class="command-card"><span>Drafts</span><strong id="ccdScanned">0</strong><p>Tickets con payload preparado.</p></div>
        <div class="command-card"><span>Capturar ahora</span><strong id="ccdNow">0</strong><p>Seguro para POST manual si hay fuente visible.</p></div>
        <div class="command-card"><span>Esperando</span><strong id="ccdWaiting">0</strong><p>No enviar todavía.</p></div>
        <div class="command-card"><span>Perdidos</span><strong id="ccdMissed">0</strong><p>Solo auditoría post-kickoff.</p></div>
        <div class="command-card"><span>Dinero real</span><strong>OFF</strong><p>Solo paper/shadow audit.</p></div>
      </div>
      <div class="table-wrap"><table id="closingCaptureDraftTable"></table></div>
    </section>
    <section id="sourceCaptureAssistant"><h2>Source Capture Assistant <small class="muted">(evidencia + draft, sin autopost)</small></h2>
      <p id="sourceCaptureAssistantRecommendation" class="section-note">Cargando asistente de captura. Nothing Browser/Piggy solo puede asistir visualmente: no scraping, no login, no apuestas.</p>
      <div class="command-grid">
        <div class="command-card"><span>Drafts</span><strong id="scaDrafts">0</strong><p>Payloads listos para revisión.</p></div>
        <div class="command-card"><span>Evidencia</span><strong id="scaEvidence">0</strong><p>Screenshot/texto guardado.</p></div>
        <div class="command-card"><span>Safe to post</span><strong id="scaSafe">0</strong><p>Solo con confirmación humana.</p></div>
        <div class="command-card"><span>Rejected</span><strong id="scaRejected">0</strong><p>Fuente/tipo inseguro.</p></div>
        <div class="command-card"><span>Autopost</span><strong>OFF</strong><p>Manual verified separado.</p></div>
        <div class="command-card"><span>Piggy</span><strong>LOCAL</strong><p>127.0.0.1, sin proxy/bypass.</p></div>
      </div>
      <div class="table-wrap"><table id="sourceCaptureAssistantTable"></table></div>
    </section>
    <section id="oddsSnapshotCache"><h2>Odds Snapshot Cache <small class="muted">(entry/current/closing con stale y evidencia)</small></h2>
      <p id="oddsSnapshotCacheRecommendation" class="section-note">Cargando cache de cuotas. Guarda historico; no crea picks ni reemplaza closing valido.</p>
      <div class="command-grid">
        <div class="command-card"><span>Snapshots</span><strong id="oscScanned">0</strong><p>Cuotas vistas hoy.</p></div>
        <div class="command-card"><span>Fresh</span><strong id="oscFresh">0</strong><p>Dentro de vigencia.</p></div>
        <div class="command-card"><span>Stale</span><strong id="oscStale">0</strong><p>No usar sin recaptura.</p></div>
        <div class="command-card"><span>Safe entry</span><strong id="oscEntry">0</strong><p>Antes del inicio.</p></div>
        <div class="command-card"><span>Safe closing</span><strong id="oscClosing">0</strong><p>Solo CAPTURED_ON_TIME.</p></div>
        <div class="command-card"><span>Audit only</span><strong id="oscAudit">0</strong><p>Visible, excluido de CLV formal.</p></div>
      </div>
      <div class="table-wrap"><table id="oddsSnapshotCacheTable"></table></div>
    </section>
    <section id="cleanChainProgress"><h2>Clean Chain Progress <small class="muted">(entry -> closing -> settlement -> CLV)</small></h2>
      <p id="cleanChainProgressRecommendation" class="section-note">Cargando progreso verificable. Los historicos legacy y duplicados quedan excluidos.</p>
      <div class="command-grid">
        <div class="command-card"><span>Entry valid hoy</span><strong id="ccpValidEntries">0</strong><p>Cuota pregame fresca con evidencia.</p></div>
        <div class="command-card"><span>Entry sin evidencia</span><strong id="ccpMissingEntryEvidence">0</strong><p>Bloquea la cadena limpia.</p></div>
        <div class="command-card"><span>Closing valid hoy</span><strong id="ccpValidClosings">0</strong><p>CAPTURED_ON_TIME con evidencia.</p></div>
        <div class="command-card"><span>Settlement clean hoy</span><strong id="ccpSettlementsClean">0</strong><p>Resultado verificado y final.</p></div>
        <div class="command-card"><span>CLV valid hoy</span><strong id="ccpClvValid">0</strong><p>Solo cadena completa.</p></div>
        <div class="command-card"><span>MLB clean v2</span><strong id="ccpMlbProgress">0/150</strong><p>Meta minima antes de real.</p></div>
        <div class="command-card"><span>Football clean</span><strong id="ccpFootballProgress">0/50</strong><p>Calibracion con muestra limpia.</p></div>
        <div class="command-card"><span>Legacy excluido</span><strong id="ccpLegacyExcluded">0</strong><p>No desbloquea dinero real.</p></div>
        <div class="command-card"><span>Duplicados excluidos</span><strong id="ccpDuplicateExcluded">0</strong><p>No cuentan en metricas.</p></div>
      </div>
      <p id="cleanChainNextAction" class="section-note">Siguiente accion: preparar un entry verificable.</p>
    </section>
    <section id="cleanSampleQueue"><h2>Clean Sample Queue <small class="muted">(2-4 partidos foco para completar cadena limpia)</small></h2>
      <p id="cleanSampleQueueRecommendation" class="section-note">Cargando rutina diaria. Solo prioriza acciones; no crea picks, no captura cuotas y no liquida.</p>
      <div class="command-grid">
        <div class="command-card"><span>Foco hoy</span><strong id="csqFocus">0</strong><p>Maximo 2-4 partidos.</p></div>
        <div class="command-card"><span>Football clean</span><strong id="csqFootballSample">0/50</strong><p>Meta minima antes de promover.</p></div>
        <div class="command-card"><span>MLB clean v2</span><strong id="csqMlbSample">0/150</strong><p>Cadena verificada nueva.</p></div>
        <div class="command-card"><span>MLB pilot hist</span><strong id="csqMlbLegacy">0</strong><p>Orientacion; no desbloquea real.</p></div>
        <div class="command-card"><span>Closing ahora</span><strong id="csqClosingNow">0</strong><p>Accion inmediata.</p></div>
        <div class="command-card"><span>Near-start</span><strong id="csqNearStart">0</strong><p>Lineup/pitcher/portero.</p></div>
        <div class="command-card"><span>Entry missing</span><strong id="csqEntryMissing">0</strong><p>Faltan cuotas verificadas.</p></div>
        <div class="command-card"><span>Fair odds listas</span><strong id="csqFairReady">0/0</strong><p>Modelo propio cargado.</p></div>
        <div class="command-card"><span>Fair odds missing</span><strong id="csqFairMissing">0</strong><p>Falta modelo/fair odds.</p></div>
        <div class="command-card"><span>Fixture time</span><strong id="csqFixtureTime">0</strong><p>Hora no verificada.</p></div>
        <div class="command-card"><span>Post-kickoff</span><strong id="csqPostKickoff">0</strong><p>Solo auditoria.</p></div>
      </div>
      <div class="table-wrap"><table id="cleanSampleQueueTable"></table></div>
    </section>
    <section id="shadowTicketChain"><h2>Shadow Ticket Chain <small class="muted">(ticket -> entry -> closing -> evidencia -> CLV)</small></h2>
      <p id="shadowTicketChainRecommendation" class="section-note">Cargando cadena auditable. Solo lectura: no crea picks, no liquida y no activa dinero real.</p>
      <div class="command-grid">
        <div class="command-card"><span>Tickets</span><strong id="stcScanned">0</strong><p>Paper/shadow revisados.</p></div>
        <div class="command-card"><span>Waiting closing</span><strong id="stcWaitingClosing">0</strong><p>Entry existe; falta cierre valido.</p></div>
        <div class="command-card"><span>Ready settlement</span><strong id="stcReadySettlement">0</strong><p>Closing + resultado.</p></div>
        <div class="command-card"><span>Waiting result</span><strong id="stcWaitingResult">0</strong><p>Closing valido, falta final.</p></div>
        <div class="command-card"><span>Closing review</span><strong id="stcClosingReview">0</strong><p>Cierre temprano/tarde/invalido.</p></div>
        <div class="command-card"><span>Settled audit</span><strong id="stcSettled">0</strong><p>Ya aporta lectura de laboratorio.</p></div>
      </div>
      <div class="table-wrap"><table id="shadowTicketChainTable"></table></div>
    </section>
    <section id="operationalWindowQueue"><h2>Operational Window Queue <small class="muted">(que toca hacer y cuando)</small></h2>
      <p id="operationalWindowQueueRecommendation" class="section-note">Cargando agenda operativa. Es lectura segura: no ejecuta scripts, no captura cuotas y no liquida partidos.</p>
      <div class="command-grid">
        <div class="command-card"><span>Near-start ahora</span><strong id="owqNearStart">0</strong><p>Contexto lineup/pitcher por correr.</p></div>
        <div class="command-card"><span>Closing ahora</span><strong id="owqClosingNow">0</strong><p>Ventana 10-3 abierta.</p></div>
        <div class="command-card"><span>Esperando ventana</span><strong id="owqWaiting">0</strong><p>No correr todavia.</p></div>
        <div class="command-card"><span>Ventana perdida</span><strong id="owqMissed">0</strong><p>Solo auditoria.</p></div>
        <div class="command-card"><span>Ready settlement</span><strong id="owqReadySettlement">0</strong><p>Exige resultado verificado.</p></div>
        <div class="command-card"><span>Manual verified</span><strong id="owqManual">0</strong><p>Puede resolverse con fuente confiable.</p></div>
        <div class="command-card"><span>Fuente externa</span><strong id="owqExternal">0</strong><p>Bloqueado por proveedor/manual.</p></div>
      </div>
      <div class="table-wrap"><table id="operationalWindowQueueTable"></table></div>
    </section>
    <section id="operationalAlerts"><h2>Operational Alerts <small class="muted">(radar de ventanas, no picks)</small></h2>
      <p id="operationalAlertsRecommendation" class="section-note">Cargando alertas operativas. Solo avisa ventanas: no crea picks, no autopost, no apuestas.</p>
      <div class="command-grid">
        <div class="command-card"><span>Alertas ahora</span><strong id="opaNow">0</strong><p>Acciones operativas inmediatas.</p></div>
        <div class="command-card"><span>Closing now</span><strong id="opaClosingNow">0</strong><p>Solo captura con fuente/evidencia.</p></div>
        <div class="command-card"><span>Preparar fuente</span><strong id="opaPrepare">0</strong><p>30/15/10 min antes.</p></div>
        <div class="command-card"><span>Safe to post</span><strong id="opaSafeToPost">0</strong><p>Manual verified, nunca autopost.</p></div>
        <div class="command-card"><span>Missed</span><strong id="opaMissed">0</strong><p>Solo auditoria.</p></div>
        <div class="command-card"><span>Telegram</span><strong id="opaTelegram">OFF</strong><p>Opcional alerts-only.</p></div>
        <div class="command-card"><span>Dinero real</span><strong>OFF</strong><p>Guardrail fijo.</p></div>
      </div>
      <div class="table-wrap"><table id="operationalAlertsTable"></table></div>
    </section>
    <section id="sourceCaptureQueue"><h2>Source Capture Queue <small class="muted">(que fuente hay que traer ahora)</small></h2>
      <p id="sourceCaptureQueueRecommendation" class="section-note">Cargando cola de captura. Usa Bottleneck by Source como base.</p>
      <div class="table-wrap"><table id="sourceCaptureQueueTable"></table></div>
    </section>
    <section id="manualVerifiedSourceCaptures"><h2>Manual Verified Source Captures <small class="muted">(fuente visible, audit trail, sin scraping)</small></h2>
      <p id="manualVerifiedSourceCapturesRecommendation" class="section-note">Cargando capturas manual_verified. Solo CAPTURED_ON_TIME alimenta CLV/segmentos.</p>
      <div class="command-grid">
        <div class="command-card"><span>Capturas</span><strong id="mvscScanned">0</strong><p>Registros visibles para auditoría.</p></div>
        <div class="command-card"><span>Accepted</span><strong id="mvscAccepted">0</strong><p>Puede apoyar preflight.</p></div>
        <div class="command-card"><span>Partial</span><strong id="mvscPartial">0</strong><p>Dato incompleto, no confirma.</p></div>
        <div class="command-card"><span>Audit only</span><strong id="mvscAuditOnly">0</strong><p>No alimenta decisión formal.</p></div>
        <div class="command-card"><span>Closing on-time</span><strong id="mvscOnTime">0</strong><p>Sirve para CLV formal.</p></div>
        <div class="command-card"><span>Early/Late</span><strong id="mvscBadClosing">0</strong><p>Visible, excluido de segmentos.</p></div>
      </div>
      <div class="table-wrap"><table id="manualVerifiedSourceCapturesTable"></table></div>
    </section>
    <section id="candidatePreflightQueue"><h2>Candidate Preflight</h2>
      <p id="candidatePreflightRecommendation" class="section-note">Cargando candidatos.</p>
      <div class="command-grid">
        <div class="command-card"><span>Evaluados</span><strong id="cpfScanned">0</strong></div>
        <div class="command-card"><span>PASS</span><strong id="cpfPassed">0</strong></div>
        <div class="command-card"><span>FAIL</span><strong id="cpfFailed">0</strong></div>
        <div class="command-card"><span>REAL_CANDIDATE</span><strong id="cpfRealCandidate">0</strong></div>
      </div>
      <div class="table-wrap"><table id="candidatePreflightTable"></table></div>
    </section>
    <section id="matchPreflightQueue"><h2>Chain Preflight Queue <small class="muted">(closing, resultado, settlement y CLV)</small></h2>
      <p id="matchPreflightQueueRecommendation" class="section-note">Cargando preflight. No crea picks; ordena partidos por accion pendiente.</p>
      <div class="command-grid">
        <div class="command-card"><span>Scanned</span><strong id="mpfScanned">0</strong><p>Partidos/tickets revisados.</p></div>
        <div class="command-card"><span>Financial ready</span><strong id="mpfFinancial">0</strong><p>Odds + modelo + EV.</p></div>
        <div class="command-card"><span>Context gaps</span><strong id="mpfContextGaps">0</strong><p>Falta lineup/pitcher/contexto.</p></div>
        <div class="command-card"><span>Hard context</span><strong id="mpfHardContext">0</strong><p>Bloqueo duro de contexto.</p></div>
        <div class="command-card"><span>Soft context</span><strong id="mpfSoftContext">0</strong><p>Gaps revisables.</p></div>
        <div class="command-card"><span>Source missing</span><strong id="mpfSourceMissing">0</strong><p>Falta fuente verificable.</p></div>
        <div class="command-card"><span>Lineup gaps</span><strong id="mpfLineupGaps">0</strong><p>Alineacion/batting order.</p></div>
        <div class="command-card"><span>Goalkeeper gaps</span><strong id="mpfGoalkeeperGaps">0</strong><p>Portero sin verificar.</p></div>
        <div class="command-card"><span>Waiting closing</span><strong id="mpfWaitingClosing">0</strong><p>Necesita closing valido.</p></div>
        <div class="command-card"><span>Ready settlement</span><strong id="mpfReadySettlement">0</strong><p>Closing + resultado.</p></div>
        <div class="command-card"><span>Post-kickoff audit</span><strong id="mpfPostKickoff">0</strong><p>Solo auditoria.</p></div>
        <div class="command-card"><span>Shadow settled</span><strong id="mpfSettled">0</strong><p>Tickets cerrados.</p></div>
        <div class="command-card"><span>Confirmed Paper</span><strong id="mpfConfirmed">0</strong><p>No dinero real.</p></div>
        <div class="command-card"><span>REAL_CANDIDATE</span><strong id="mpfRealCandidate">0</strong><p>Debe seguir en cero.</p></div>
        <div class="command-card"><span>MLB Pitchers</span><strong id="mpfMlbPitcher">0</strong><p>Pitcher + stats listos.</p></div>
        <div class="command-card"><span>MLB Lineups</span><strong id="mpfMlbLineup">0</strong><p>Lineup + batting order.</p></div>
        <div class="command-card"><span>MLB Park/Wx</span><strong id="mpfMlbParkWeather">0</strong><p>Parque + clima verificable.</p></div>
      </div>
      <div class="table-wrap"><table id="matchPreflightQueueTable"></table></div>
    </section>
    <section id="footballOwnedFairOdds"><h2>Football Market Odds Audit <small class="muted">(owned fair odds vs cuotas reales)</small></h2>
      <p id="footballOwnedFairOddsRecommendation" class="section-note">Cargando odds propias. Son precios justos del modelo, no cuotas reales.</p>
      <div class="command-grid">
        <div class="command-card"><span>Model quotes</span><strong id="fofoCount">0</strong><p>Fair odds propias recientes.</p></div>
        <div class="command-card"><span>Market odds found</span><strong id="fofoWithMarket">0</strong><p>Cuotas reales detectadas.</p></div>
        <div class="command-card"><span>Fresh odds</span><strong id="fofoFresh">0</strong><p>Cuotas usables por timestamp.</p></div>
        <div class="command-card"><span>Stale odds</span><strong id="fofoStale">0</strong><p>Existen, pero están viejas.</p></div>
        <div class="command-card"><span>Manual unverified</span><strong id="fofoManualUnverified">0</strong><p>Falta verified_by.</p></div>
        <div class="command-card"><span>Price too low</span><strong id="fofoPriceTooLow">0</strong><p>No alcanza EV mínimo.</p></div>
        <div class="command-card"><span>Ready Shadow</span><strong id="fofoReady">0</strong><p>EV real + fuente fresca.</p></div>
        <div class="command-card"><span>Calibrating</span><strong id="fofoCalibrating">0</strong><p>EV positivo, modelo aun en gate.</p></div>
        <div class="command-card"><span>Falta mercado</span><strong id="fofoMissing">0</strong><p>Falta cuota real.</p></div>
        <div class="command-card"><span>EV Audit</span><strong id="fofoAggressiveAudit">0</strong><p>EV alto; revisar closing/CLV.</p></div>
        <div class="command-card"><span>Gap alto</span><strong id="fofoMarketGap">0</strong><p>Modelo muy lejos del no-vig.</p></div>
      </div>
      <div class="table-wrap"><table id="footballOwnedFairOddsTable"></table></div>
    </section>
    <section id="footballShadowSegments"><h2>Football Shadow Segments <small class="muted">(CLV/settlement por tipo de señal)</small></h2>
      <p id="footballShadowSegmentsRecommendation" class="section-note">Cargando segmentos shadow. Decision v2: CLV + Brier + ROI CI 95% + dependencia. Sirve para calibrar, no para apostar.</p>
      <div class="command-grid">
        <div class="command-card"><span>Closing valido</span><strong id="fssClosingValid">0</strong><p>CAPTURED_ON_TIME.</p></div>
        <div class="command-card"><span>Closing review</span><strong id="fssClosingReview">0</strong><p>Temprano/tarde/invalido.</p></div>
        <div class="command-card"><span>CLV valido</span><strong id="fssClvValid">0</strong><p>Cuenta para segmentos.</p></div>
        <div class="command-card"><span>Capture rate</span><strong id="fssCaptureRate">0%</strong><p>Closing valido / closed.</p></div>
        <div class="command-card"><span>Metric gate</span><strong id="fssMetricGate">WAIT</strong><p>Brier/log loss con muestra minima.</p></div>
        <div class="command-card"><span>Dixon-Coles</span><strong id="fssDixonColes">NOT_READY</strong><p>Trainer research/offline.</p></div>
      </div>
      <div class="table-wrap"><table id="footballShadowSegmentsTable"></table></div>
    </section>
    <section id="footballContextInbox"><h2>Context Readiness Queue <small class="muted">(qué falta para subir de nivel)</small></h2>
      <p id="footballContextInboxRecommendation" class="section-note">Cargando bandeja de contexto. Prioriza lineup, team intelligence, odds/modelo y settlement.</p>
      <div class="command-grid">
        <div class="command-card"><span>Lineup pendiente</span><strong id="fciLineup">0</strong><p>Alineación o jugadores clave faltantes.</p></div>
        <div class="command-card"><span>Kickoff sin consenso</span><strong id="fciKickoff">0</strong><p>Horario/fuente todavía débil.</p></div>
        <div class="command-card"><span>Odds sin modelo</span><strong id="fciOddsNoModel">0</strong><p>Hay cuota, pero falta probabilidad/EV.</p></div>
        <div class="command-card"><span>Listos para revisar</span><strong id="fciReviewable">0</strong><p>Podrían subir si llega contexto.</p></div>
        <div class="command-card"><span>Team/Player gaps</span><strong id="fciTeamPlayer">0</strong><p>Falta contexto de equipo o jugadores.</p></div>
        <div class="command-card"><span>Data fuerte</span><strong id="fciStrong">0</strong><p>Score 81+; revisar si toda la cadena acompaña.</p></div>
      </div>
      <div class="table-wrap"><table id="footballContextInboxTable"></table></div>
    </section>
    <section id="footballReadinessGate"><h2>Football Readiness Gate <small class="muted">(observado -> candidato serio)</small></h2>
      <p id="footballReadinessGateRecommendation" class="section-note">Cargando gate de futbol. No crea picks; solo explica que falta.</p>
      <div class="command-grid">
        <div class="command-card"><span>Decision futbol</span><strong id="frgDecision">COLLECT_DATA</strong><p id="frgDominantGap">Gap dominante: -</p></div>
        <div class="command-card"><span>Observados</span><strong id="frgObserved">0</strong><p id="frgActive">0 candidatos activos.</p></div>
        <div class="command-card"><span>Odds + Modelo</span><strong id="frgOddsModel">0 / 0</strong><p>Cuota, timestamp, probabilidad y EV.</p></div>
        <div class="command-card"><span>Contexto</span><strong id="frgContext">0 / 0</strong><p>Equipo + jugadores/lineup.</p></div>
        <div class="command-card"><span>Listos review</span><strong id="frgReady">0</strong><p>Antes de Shadow Candidate.</p></div>
        <div class="command-card"><span>Shadow tickets</span><strong id="frgShadowTickets">0</strong><p>Registrados para closing/settlement.</p></div>
        <div class="command-card"><span>Pending closing</span><strong id="frgPendingClosing">0</strong><p>Falta cuota de cierre.</p></div>
        <div class="command-card"><span>Pending settlement</span><strong id="frgPendingSettlement">0</strong><p>Falta resultado final.</p></div>
        <div class="command-card"><span>Confirmed Paper</span><strong id="frgConfirmed">0</strong><p>Solo Shadow Paper, no dinero real.</p></div>
      </div>
      <div class="table-wrap"><table id="footballReadinessGateTable"></table></div>
    </section>
    <section id="pilotReadinessGate"><h2>Pilot Readiness Gate <small class="muted">(bloqueado / review only)</small></h2><p id="pilotReadinessGateRecommendation" class="section-note">Cargando semáforo ejecutivo.</p><div class="table-wrap"><table id="pilotReadinessGateTable"></table></div></section>
    <section id="freshVsArchive"><h2>Fresh vs Archive <small class="muted">(base limpia para métricas)</small></h2><p id="freshVsArchiveRecommendation" class="section-note">Cargando estados de frescura. Dry-run: no mueve datos.</p><div class="table-wrap"><table id="freshVsArchiveTable"></table></div></section>
    <section id="dataQualityScores"><h2>Data Quality Score <small class="muted">(calidad de información, no apuesta)</small></h2><p id="dataQualityScoresRecommendation" class="section-note">Cargando score auditable. No crea picks.</p><div class="table-wrap"><table id="dataQualityScoresTable"></table></div></section>
    <section id="evOutlierGuardrail"><h2>EV Outlier Guardrail <small class="muted">(demasiado bueno requiere review)</small></h2><p id="evOutlierGuardrailRecommendation" class="section-note">Cargando umbral rolling de EV extremo.</p><div class="table-wrap"><table id="evOutlierGuardrailTable"></table></div></section>
    <section id="confirmedVsEvBacktest"><h2>Confirmed vs EV Backtest <small class="muted">(contexto confirmado contra EV-only)</small></h2><p id="confirmedVsEvBacktestRecommendation" class="section-note">Cargando comparación. Solo lectura.</p><div class="table-wrap"><table id="confirmedVsEvBacktestTable"></table></div></section>
    <section id="formalPilotReadiness"><h2>Formal Pilot Readiness <small class="muted">(gate estadístico bloqueado)</small></h2><p id="formalPilotReadinessRecommendation" class="section-note">Cargando checklist formal. No desbloquea dinero real.</p><div class="table-wrap"><table id="formalPilotReadinessTable"></table></div></section>
    <section id="freshCandidateInbox"><h2>Fresh Candidate Inbox <small class="muted">(solo líneas frescas)</small></h2><p id="freshCandidateInboxRecommendation" class="section-note">Cargando candidatos frescos.</p><div class="table-wrap"><table id="freshCandidateInboxTable"></table></div></section>
    <section id="ruleConfidence"><h2>Rule Confidence <small class="muted">(Underdog Plus / estabilidad)</small></h2><p id="ruleConfidenceRecommendation" class="section-note">Cargando confianza de reglas.</p><div class="table-wrap"><table id="ruleConfidenceTable"></table></div></section>
    <section id="walkForwardBacktest"><h2>Walk-Forward Backtest <small class="muted">(discovery vs validation)</small></h2><p id="walkForwardBacktestRecommendation" class="section-note">Cargando validación posterior.</p><div class="table-wrap"><table id="walkForwardBacktestTable"></table></div></section>
    <section id="realPilotSimulator"><h2>Real Pilot Simulator <small class="muted">(simulación bloqueada)</small></h2><p id="realPilotSimulatorRecommendation" class="section-note">Cargando simulador. No ejecuta dinero real.</p><div class="table-wrap"><table id="realPilotSimulatorTable"></table></div></section>
    <section id="confirmedPickChain"><h2>Confirmed Pick Chain <small class="muted">(cadena completa paper)</small></h2><p id="confirmedPickChainRecommendation" class="section-note">Cargando cadena de confirmación. No activa dinero real.</p><div class="command-grid">
      <div class="command-card"><span>BETTABLE_PAPER_CONFIRMED</span><strong id="cpcConfirmed">0</strong><p>Confirmado solo para paper.</p></div>
      <div class="command-card"><span>Blocked by Intelligence</span><strong id="cpcIntel">0</strong><p>Pitcher, lineup o jugador bloquea.</p></div>
      <div class="command-card"><span>High EV Review</span><strong id="cpcHighEv">0</strong><p>EV extremo o auditoría pendiente.</p></div>
      <div class="command-card"><span>Stale / Duplicate</span><strong id="cpcRisk">0</strong><p>Línea vieja o exposición duplicada.</p></div>
    </div><div class="table-wrap"><table id="confirmedPickChainTable"></table></div></section>
    <section id="timestampMismatchAudit"><h2>Timestamp Mismatch Audit <small class="muted">(EV con datos frescos)</small></h2>
      <p id="timestampMismatchAuditRecommendation" class="section-note">Cargando auditoría de sincronía entre modelo, cuota y contexto. No confirma picks.</p>
      <div class="command-grid">
        <div class="command-card"><span>Picks auditados</span><strong id="tmaCount">0</strong><p>Activos FRESH revisados.</p></div>
        <div class="command-card"><span>Mismatches</span><strong id="tmaMismatch">0</strong><p>Modelo y cuota fuera de ventana.</p></div>
        <div class="command-card"><span>EV sobrevive</span><strong id="tmaSurvives">0</strong><p>EV sigue positivo con datos recientes.</p></div>
        <div class="command-card"><span>Confirmación</span><strong id="tmaBlocks">BLOCKED</strong><p>Sigue review only.</p></div>
      </div>
      <div class="table-wrap"><table id="timestampMismatchAuditTable"></table></div>
    </section>
    <section id="mlbContextWatch"><h2>MLB Context Watch <small class="muted">(pitchers, lineups y bloqueos)</small></h2>
      <p id="mlbContextWatchRecommendation" class="section-note">Cargando vigilancia MLB. No confirma picks: solo muestra qué contexto falta.</p>
      <div class="command-grid">
        <div class="command-card"><span>Partidos vigilados</span><strong id="mcwMatches">0</strong><p>Con Player Intelligence reciente.</p></div>
        <div class="command-card"><span>Pitchers probables</span><strong id="mcwPitchers">0</strong><p>Abridores detectados por fuente.</p></div>
        <div class="command-card"><span>Lineups faltantes</span><strong id="mcwLineups">0</strong><p>Bloquean o mandan a revisión.</p></div>
        <div class="command-card"><span>Conflictos</span><strong id="mcwConflicts">0</strong><p>Bullpen/contexto contra el pick.</p></div>
      </div>
      <div class="table-wrap"><table id="mlbContextWatchTable"></table></div>
    </section>
    <section id="tradingCommandCenter"><h2>Trading Command Center</h2><div class="command-grid">
      <div class="command-card"><span>Estado del sistema</span><strong id="ccSystemStatus">SAFE</strong><p id="ccGuardrails">Real Paper only</p></div>
      <div class="command-card"><span>Acción recomendada hoy</span><strong id="ccAction">REVIEW_ONLY</strong><p id="ccActionReason">Esperando diagnóstico.</p></div>
      <div class="command-card"><span>Picks activos</span><strong id="ccPicks">0</strong><p id="ccPickBreakdown">Sin picks activos.</p></div>
      <div class="command-card"><span>Mercado fuerte</span><strong id="ccMarket">MLB ML</strong><p id="ccMarketHealth">Cargando salud de mercado.</p></div>
    </div></section>
    <section id="todaysPicks"><h2>Today's Picks - Simple View</h2><div id="todayPickCards" class="pick-card-grid"></div></section>
    <section id="whyThisPick"><h2>Why This Pick?</h2><div class="table-wrap"><table id="whyThisPickTable"></table></div></section>
    <section id="mlbNoBetSummary"><h2>MLB No-Bet Intelligence <small class="muted">(por qué no aparece pick)</small></h2>
      <p id="mlbNoBetSummaryRecommendation" class="section-note">Cargando motivos de no-bet. Esto ayuda a mejorar el modelo sin forzar apuestas.</p>
      <div class="table-wrap"><table id="mlbNoBetSummaryTable"></table></div>
    </section>
    <section id="simpleMarketHealth"><h2>Simple Market Health <small class="muted">(MLB Real Paper Audit)</small></h2><p class="section-note">Fuente: snapshots Real Paper MLB con closing/settlement. No mezcla Radar Picks ni performance histórico.</p><div class="table-wrap"><table id="simpleMarketHealthTable"></table></div></section>
    <section id="pendingSettlement"><h2>Pending Settlement Monitor</h2><p id="pendingSettlementRecommendation" class="muted">Cargando estado de settlement.</p><div class="table-wrap"><table id="pendingSettlementMonitor"></table></div></section>
    <section id="footballCompetitionRegistry"><h2>Football Competition Registry <small class="muted">(LiveScore/Futbol24 map)</small></h2><p id="footballCompetitionRegistryRecommendation" class="section-note">Cargando catálogo maestro de ligas.</p><div class="command-grid">
      <div class="command-card"><span>Competiciones</span><strong id="fcrTotal">0</strong><p id="fcrStatusMeta">Trust por liga.</p></div>
      <div class="command-card"><span>TRUSTED/WATCH</span><strong id="fcrTrustedWatch">0</strong><p>Puede acumular si trae consenso.</p></div>
      <div class="command-card"><span>Manual/Bloqueadas</span><strong id="fcrManualBlocked">0</strong><p>Sin picks automáticos.</p></div>
      <div class="command-card"><span>Favoritas</span><strong id="fcrFavorites">0</strong><p id="fcrFavoriteNames">Mundial, Liga MX, MLS...</p></div>
    </div><div class="table-wrap"><table id="footballCompetitionRegistryTable"></table></div></section>
    <section id="footballCommandCenter"><h2>Football Command Center</h2><div class="command-grid">
      <div class="command-card"><span>Estado fútbol</span><strong id="footballSystemStatus">SHADOW</strong><p id="footballGuardrails">Shadow Paper only</p></div>
      <div class="command-card"><span>Ligas favoritas</span><strong id="footballFavoriteCount">0</strong><p id="footballFavorites">Cargando ligas.</p></div>
      <div class="command-card"><span>Mejor mercado</span><strong id="footballBestMarket">-</strong><p id="footballBestMarketMeta">Sin datos.</p></div>
      <div class="command-card"><span>Acción recomendada</span><strong id="footballAction">ACCUMULATE</strong><p id="footballNextGoal">20 cerradas por mercado.</p></div>
    </div><div class="table-wrap"><table id="footballCommandTable"></table></div></section>
    <section id="footballTodayUniverse"><h2>Football Today Universe <small class="muted">(fixtures observados)</small></h2><div class="command-grid">
      <div class="command-card"><span>Partidos observados</span><strong id="ftuObserved">0</strong><p id="ftuLeagues">0 ligas observadas</p></div>
      <div class="command-card"><span>Market snapshots</span><strong id="ftuSnapshots">0</strong><p>Cuotas guardadas sin contar como pick.</p></div>
      <div class="command-card"><span>Shadow candidates</span><strong id="ftuCandidates">0</strong><p id="ftuConversion">Conversion 0%</p></div>
      <div class="command-card"><span>Shadow paper</span><strong id="ftuShadowPaper">0</strong><p>Performance solo cuando cierre.</p></div>
    </div><p id="footballTodayUniverseRecommendation" class="muted">Cargando universo de fútbol.</p><div class="table-wrap"><table id="footballTodayUniverseTable"></table></div></section>
    <section id="footballDataGateway"><h2>Football Data Gateway <small class="muted">(our API -> cache -> API-Football)</small></h2><p id="footballDataGatewayRecommendation" class="section-note">Cargando gateway de datos. Shadow Paper only.</p><div class="command-grid">
      <div class="command-card"><span>API Provider</span><strong id="fdgProvider">api_football</strong><p id="fdgProviderMeta">Quota/cache seguro.</p></div>
      <div class="command-card"><span>Cache válido</span><strong id="fdgCacheValid">0</strong><p id="fdgCacheMeta">0 cache entries.</p></div>
      <div class="command-card"><span>Consenso verificado</span><strong id="fdgConsensusVerified">0</strong><p id="fdgConsensusMeta">0 total.</p></div>
      <div class="command-card"><span>Quota restante</span><strong id="fdgQuotaRemaining">0</strong><p>Dry-run primero, apply manual.</p></div>
      <div class="command-card"><span>FOOTBALL_DATA_URL</span><strong id="fdgFootballDataUrl">-</strong><p id="fdgFootballDataUrlMeta">SOURCE_MISSING si no está configurado.</p></div>
    </div><div class="table-wrap"><table id="footballDataGatewayTable"></table></div></section>
    <section id="sportsIntelligenceCore"><h2>Sports Intelligence Core <small class="muted">(cerebro multi-fuente)</small></h2><p id="sportsIntelligenceCoreRecommendation" class="section-note">Cargando núcleo de inteligencia. Providers son fuentes; sports-data-hub decide.</p><div class="command-grid">
      <div class="command-card"><span>Providers available</span><strong id="sicProvidersAvailable">0</strong><p id="sicProviderMeta">Capacidades por fuente.</p></div>
      <div class="command-card"><span>Providers blocked</span><strong id="sicProvidersBlocked">0</strong><p id="sicBlockedMeta">Plan, rate limit o key.</p></div>
      <div class="command-card"><span>Consensus verified</span><strong id="sicConsensusVerified">0</strong><p id="sicConsensusMeta">Fuente cruzada por match.</p></div>
      <div class="command-card"><span>Context gaps</span><strong id="sicContextGaps">0</strong><p id="sicContextMeta">Falta lineup, score o consenso.</p></div>
    </div><div class="table-wrap"><table id="sportsIntelligenceCoreTable"></table></div></section>
    <section id="expectedLineupEngine"><h2>Expected Lineup Engine <small class="muted">(resguardo historico/proyectado)</small></h2><p id="expectedLineupEngineRecommendation" class="section-note">Cargando resguardo de alineaciones. Lo esperado ayuda al preview; lo oficial confirma contexto.</p><div class="command-grid">
      <div class="command-card"><span>Expected / Projected</span><strong id="eleExpected">0</strong><p>Preview antes del once oficial.</p></div>
      <div class="command-card"><span>Confirmed</span><strong id="eleConfirmed">0</strong><p>Lineup oficial disponible.</p></div>
      <div class="command-card"><span>Changed / Conflict</span><strong id="eleChanged">0</strong><p>Cambio contra lo esperado.</p></div>
      <div class="command-card"><span>Needs official</span><strong id="eleNeedsOfficial">0</strong><p>Esperar confirmacion oficial.</p></div>
    </div><div class="table-wrap"><table id="expectedLineupEngineTable"></table></div></section>
    <section id="footballIntelligence"><h2>Football Intelligence v1 <small class="muted">(LiveScore-style decision layer)</small></h2><p id="footballIntelligenceRecommendation" class="section-note">Cargando inteligencia de fútbol. Shadow Paper only.</p><div class="command-grid">
      <div class="command-card"><span>Trusted leagues</span><strong id="fiTrustedLeagues">0</strong><p id="fiTrustMeta">League Trust Score activo.</p></div>
      <div class="command-card"><span>Team contexts</span><strong id="fiTeamContexts">0</strong><p id="fiTeamMeta">Forma, localía y contexto de equipo.</p></div>
      <div class="command-card"><span>Player contexts</span><strong id="fiPlayerContexts">0</strong><p id="fiPlayerMeta">Lineups, ausencias y player news.</p></div>
      <div class="command-card"><span>Football confirmed</span><strong id="fiConfirmedPaper">0</strong><p id="fiChainMeta">Confirmado solo para Shadow Paper.</p></div>
    </div><div class="table-wrap"><table id="footballConfirmedPickChainTable"></table></div><div class="table-wrap"><table id="footballLeagueTrustTable"></table></div><div class="table-wrap"><table id="footballTeamIntelligenceTable"></table></div><div class="table-wrap"><table id="footballPlayerIntelligenceTable"></table></div></section>
    <section id="footballMarketLab"><h2>Football Market Lab <small class="muted">(Shadow Paper por liga/mercado)</small></h2><p id="footballMarketLabRecommendation" class="muted">Cargando laboratorio de fútbol.</p><div class="table-wrap"><table id="footballMarketLabTable"></table></div></section>
    <section id="footballPendingSettlement"><h2>Football Pending Settlement Monitor</h2><p id="footballPendingSettlementRecommendation" class="muted">Cargando pendientes de fútbol.</p><div class="table-wrap"><table id="footballPendingSettlementTable"></table></div></section>
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
      <button data-scroll="pilotReadinessGate">Pilot Gate</button>
      <button data-scroll="freshVsArchive">Fresh/Archive</button>
      <button data-scroll="dataQualityScores">Data Quality</button>
      <button data-scroll="evOutlierGuardrail">EV Outlier</button>
      <button data-scroll="confirmedVsEvBacktest">Confirmed vs EV</button>
      <button data-scroll="formalPilotReadiness">Formal Gate</button>
      <button data-scroll="freshCandidateInbox">Fresh Inbox</button>
      <button data-scroll="confirmedPickChain">Confirmed Chain</button>
      <button data-scroll="bestBetsPerMatch">Best Bets</button>
      <button data-scroll="footballOwnedFairOdds">Owned Fair Odds</button>
      <button data-scroll="oddsSnapshotCache">Odds Cache</button>
      <button data-scroll="cleanChainProgress">Clean Progress</button>
      <button data-scroll="cleanSampleQueue">Clean Sample</button>
      <button data-scroll="shadowTicketChain">Ticket Chain</button>
      <button data-scroll="footballShadowSegments">Football Segments</button>
      <button data-scroll="manualVerifiedSourceCaptures">Manual Verified</button>
      <button data-scroll="timestampMismatchAudit">Timestamp Audit</button>
      <button data-scroll="ruleConfidence">Rule Confidence</button>
      <button data-scroll="walkForwardBacktest">Walk Forward</button>
      <button data-scroll="whyNoBettablePaper">Why no Bettable</button>
      <button data-scroll="highEvAudit">High EV Audit</button>
      <button data-scroll="matchupConfirmation">Matchup</button>
      <button data-scroll="teamIntelligence">Team Intel</button>
      <button data-scroll="intelligenceScout">Intel Scout</button>
      <button data-scroll="playerIntelligence">Player Intel</button>
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
      <button data-scroll="footballCompetitionRegistry">Football Registry</button>
      <button data-scroll="footballTodayUniverse">Football Today</button>
      <button data-scroll="footballReadinessGate">Football Readiness</button>
      <button data-scroll="operationalWindowQueue">Window Queue</button>
      <button data-scroll="matchPreflightQueue">Match Preflight</button>
      <button data-scroll="footballOwnedFairOdds">Football Fair Odds</button>
      <button data-scroll="shadowTicketChain">Ticket Chain</button>
      <button data-scroll="footballShadowSegments">Football Segments</button>
      <button data-scroll="footballDataGateway">Football Gateway</button>
      <button data-scroll="sportsIntelligenceCore">Sports Core</button>
      <button data-scroll="expectedLineupEngine">Expected Lineups</button>
      <button data-scroll="footballIntelligence">Football Intel</button>
      <button data-scroll="footballMarketLab">Football Lab</button>
    </div>
    <div class="reader-grid">
      <div class="reader-card">
        <h2>Lectura rapida del tablero</h2>
        <p id="readerSummary">Carga el dashboard para ver el diagnóstico operativo.</p>
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
          <li>CLV Lab: si CLV y profit son positivos, el mercado merece revisión.</li>
          <li>Edge Quality: A/B son candidatos fuertes, pero solo Real Paper.</li>
          <li>Pilot Checklist: si dice locked, no hay dinero real todavía.</li>
        </ul>
      </div>
    </div>
    <div class="playbook">
      <div class="playbook-card"><strong>REAL_CANDIDATE</strong><p>Reservado para dinero real futuro. Debe estar en 0 hasta autorización explícita.</p></div>
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
    <section><h2>Closing Supported Edge</h2><div class="table-wrap"><table id="closingSupportedEdge"></table></div></section>
    <section><h2>Extreme EV Closing Audit</h2><div class="table-wrap"><table id="extremeEvClosingAudit"></table></div></section>
    <section><h2>Extreme EV Closing Details</h2><div class="table-wrap"><table id="extremeEvClosingDetails"></table></div></section>
    <section><h2>Matchup Confirmation</h2><div class="table-wrap"><table id="matchupConfirmation"></table></div></section>
    <section id="teamIntelligence"><h2>Team Intelligence <small class="muted">(MLB Moneyline read-only)</small></h2><p id="teamIntelligenceRecommendation" class="section-note">Cargando contexto de equipos. No activa dinero real ni cambia picks.</p><div class="table-wrap"><table id="teamIntelligenceTable"></table></div></section>
    <section id="intelligenceScout"><h2>Intelligence Scout <small class="muted">(señales contextuales)</small></h2><p id="intelligenceScoutRecommendation" class="section-note">Cargando señales de pitchers, lineups, bullpen y jugadores. No activa dinero real.</p><div class="table-wrap"><table id="intelligenceScoutTable"></table></div></section>
    <section id="playerIntelligence"><h2>Player Intelligence <small class="muted">(jugadores clave)</small></h2><p id="playerIntelligenceRecommendation" class="section-note">Cargando disponibilidad e impacto de jugadores. No activa dinero real.</p><div class="table-wrap"><table id="playerIntelligenceTable"></table></div></section>
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
        <h2>Cómo leer una apuesta</h2>
        <p>Opera solo desde Smart Selection o Alpha Opportunities. Live Board muestra el precio justo del modelo, pero no confirma EV+ por sí solo.</p>
        <div class="steps">
          <div class="step"><strong>1. Pick</strong><span class="muted">Local, Empate o Visitante.</span></div>
          <div class="step"><strong>2. EV</strong><span class="muted">Debe ser positivo y pasar tu umbral.</span></div>
          <div class="step"><strong>3. Stake</strong><span class="muted">Shadow: flat 1%. Kelly queda apagado.</span></div>
        </div>
      </div>
      <div class="guide-card">
        <h2>Modo actual</h2>
        <p><strong>Shadow Trading.</strong> El tablero sirve para validar señales, no para ejecutar dinero real.</p>
        <p>Regla activa: flat 1%, settlement al terminar partidos, sin Kelly hasta tener 20-50 cerradas por deporte.</p>
      </div>
    </div>
    <section><h2>Real Picks</h2><div class="table-wrap"><table id="realPicks"></table></div></section>
    <section><h2>Real Paper Candidates</h2><div class="table-wrap"><table id="realPaperPicks"></table></div></section>
    <section><h2>Radar Picks <small class="muted">(señales actuales; no performance)</small></h2><p class="section-note">Fuente: señales radar/shadow/manual. Sirve para observar candidatos, no para contar cerradas ni W/L.</p><div class="table-wrap"><table id="radarPicks"></table></div></section>
    <section><h2>Review Diagnostics</h2><div class="table-wrap"><table id="reviewPicks"></table></div></section>
    <section><h2>Run Line Diagnostics</h2><div class="table-wrap"><table id="runLineDiagnostics"></table></div></section>
    <section><h2>No Bet</h2><div class="table-wrap"><table id="noBetPicks"></table></div></section>
    <table id="smart" style="display:none"></table>
    <section><h2>Estrategia de Parlays</h2><div class="table-wrap"><table id="parlays"></table></div></section>
    <section><h2>Alpha Opportunities</h2><div class="table-wrap"><table id="alpha"></table></div></section>
    <section><h2>Live Board</h2><div class="table-wrap"><table id="live"></table></div></section>
    <section><h2>Model Performance <small class="muted">(histórico por modelo)</small></h2><p class="section-note">Fuente: performance histórico/modelos; no es el mismo universo que Radar Picks ni Market Lab.</p><div class="table-wrap"><table id="performance"></table></div></section>
    <section><h2>Paper Performance <small class="muted">(portfolio shadow/manual)</small></h2><p class="section-note">Fuente: paper_trades agregados; úsalo como performance de laboratorio, no como picks actuales.</p><div class="table-wrap"><table id="paper"></table></div></section>
    <section><h2>Real Performance <small class="muted">(MLB Real Paper)</small></h2><p class="section-note">Fuente: cuotas reales simuladas, entry/closing/settlement; sigue sin dinero real.</p><div class="table-wrap"><table id="realPerformance"></table></div></section>
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

    function asArray(value) {
      if (Array.isArray(value)) return value;
      if (value === null || value === undefined || value === "") return [];
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? Object.keys(parsed).filter(key => parsed[key]) : [value]);
        } catch (_) {
          return value.split(",").map(item => item.trim()).filter(Boolean);
        }
      }
      if (typeof value === "object") return Object.keys(value).filter(key => value[key]);
      return [value];
    }
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
      return ({ home: "Local", draw: "Empate", away: "Visitante", over: "Over", under: "Under", yes: "Sí", no: "No", home_draw: "1X Local/Empate", home_or_draw: "1X Local/Empate", "1x": "1X Local/Empate", home_away: "12 Local/Visitante", home_or_away: "12 Local/Visitante", "12": "12 Local/Visitante", draw_away: "X2 Empate/Visitante", draw_or_away: "X2 Empate/Visitante", x2: "X2 Empate/Visitante" })[value] || value || "-";
    }
    function marketLabel(value) {
      return ({
        moneyline_2way: "Ganador 2 vías",
        moneyline_3way: "1X2",
        draw_no_bet: "Empate no acción",
        double_chance: "Doble oportunidad",
        total_goals_2_5: "Over/Under goles",
        btts: "Ambos anotan",
        total_runs: "Total carreras",
        total_points: "Total puntos",
        spread: "Hándicap / Run line",
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
    async function getJsonBatch(requests) {
      const settled = await Promise.allSettled(requests);
      return settled.map((result, index) => result.status === "fulfilled"
        ? result.value
        : {
            system_status: "ENDPOINT_UNAVAILABLE",
            endpoint_index: index,
            error: String(result.reason && result.reason.message ? result.reason.message : result.reason),
            rows: [],
            summary: {},
            guardrails: {}
          });
    }
    function localDateInputValue(offsetDays = 0) {
      const date = new Date();
      date.setDate(date.getDate() + offsetDays);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return year + "-" + month + "-" + day;
    }
    function selectedMatchCenterDate() {
      const input = $("matchCenterDate");
      if (input && input.value) return input.value;
      return localDateInputValue();
    }
    function setMatchCenterDate(offsetDays) {
      const value = localDateInputValue(offsetDays);
      const input = $("matchCenterDate");
      if (input) input.value = value;
      return value;
    }
    function renderTable(id, columns, rows) {
      const table = $(id);
      if (!table) return;
      const safeRows = Array.isArray(rows) ? rows : (rows ? [rows] : []);
      const head = "<tr>" + columns.map(c => "<th>" + c.label + "</th>").join("") + "</tr>";
      if (!safeRows.length) {
        table.innerHTML = head + "<tr><td colspan='" + columns.length + "' class='muted'>Sin datos para mostrar.</td></tr>";
        return;
      }
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
    function asList(value) {
      return Array.isArray(value) ? value.filter(Boolean) : [];
    }
    function hasAnyText(value, tokens) {
      const text = String(value || "").toLowerCase();
      return tokens.some(token => text.includes(token));
    }
    function matchMissingFields(match) {
      const d = match?.detail || {};
      return uniqueList([].concat(asList(d.missing_context_fields), asList(d.block_confirmation_reasons), asList(match?.missing_context_fields)));
    }
    function matchHasOdds(match) {
      return match?.odds !== null && match?.odds !== undefined && match?.odds !== "-" && match?.odds !== "";
    }
    function matchHasModel(match) {
      return match?.model_probability !== null && match?.model_probability !== undefined || match?.expected_value !== null && match?.expected_value !== undefined;
    }
    function matchDataQuality(match) {
      const missing = matchMissingFields(match).map(item => String(item).toLowerCase());
      const d = match?.detail || {};
      let score = 0;
      const checks = {
        fixture: !missing.includes("fixture") && Boolean(match?.home_team && match?.away_team),
        kickoff: !missing.includes("kickoff") && !hasAnyText(match?.kickoff_status || match?.final_chain_status, ["untrusted"]),
        odds: matchHasOdds(match),
        model: matchHasModel(match),
        team: !missing.includes("team_intelligence") && !hasAnyText(match?.intelligence_status, ["context_gaps", "no_context", "observation"]),
        player: !missing.includes("player_intelligence") && !hasAnyText(match?.player_intelligence_status, ["no_context"]),
        lineup: !missing.includes("player_intelligence_lineup") && !hasAnyText(match?.player_intelligence_status, ["lineup_pending"]),
        injuries: !hasAnyText((d.block_confirmation_reasons || []).join(" "), ["injury", "suspension"]),
        closing: !hasAnyText(match?.settlement_status, ["none", "pending"]) && Boolean(match?.settlement_status)
      };
      if (checks.fixture) score += 10;
      if (checks.kickoff) score += 10;
      if (checks.odds) score += 15;
      if (checks.model) score += 15;
      if (checks.team) score += 15;
      if (checks.player) score += 10;
      if (checks.lineup) score += 10;
      if (checks.injuries) score += 5;
      if (checks.closing) score += 10;
      const grade = score >= 81 ? "Fuerte" : score >= 61 ? "Revisable" : score >= 41 ? "Incompleto" : "Debil";
      const cls = score >= 81 ? "strong" : score >= 61 ? "reviewable" : score >= 41 ? "incomplete" : "weak";
      return { score, grade, cls, checks };
    }
    function renderQualityStrip(quality) {
      const width = Math.max(0, Math.min(100, Number(quality.score || 0)));
      return "<div class='quality-strip'><label><span>Data Quality Score</span><strong>" + width + "/100 - " + esc(quality.grade) + "</strong></label><div class='quality-track'><div class='quality-fill " + quality.cls + "' style='width:" + width + "%'></div></div></div>";
    }
    function checkCard(label, passed, detail) {
      const cls = passed ? "pass" : "wait";
      const mark = passed ? "OK" : "Falta";
      return "<div class='check-item " + cls + "'><strong>" + esc(label) + " - " + mark + "</strong><span>" + esc(detail || (passed ? "Validado" : "Pendiente")) + "</span></div>";
    }
    function renderMatchChecklist(match, quality) {
      const checks = quality.checks || {};
      return "<div class='checklist-grid'>" +
        checkCard("Fixture", checks.fixture, checks.fixture ? "Equipos identificados" : "Falta identificar equipos") +
        checkCard("Kickoff", checks.kickoff, checks.kickoff ? "Horario confiable" : "Falta consenso de horario") +
        checkCard("Odds", checks.odds, checks.odds ? "Cuota disponible" : "Falta cuota valida") +
        checkCard("Modelo/EV", checks.model, checks.model ? "Probabilidad o EV disponible" : "Falta modelo/EV") +
        checkCard("Team Intel", checks.team, checks.team ? "Contexto de equipo usable" : "Falta team intelligence") +
        checkCard("Player Intel", checks.player, checks.player ? "Contexto de jugadores usable" : "Falta player intelligence") +
        checkCard("Lineup", checks.lineup, checks.lineup ? "Lineup no bloquea" : "Lineup pendiente") +
        checkCard("Lesiones", checks.injuries, checks.injuries ? "Sin bloqueo detectado" : "Revisar bajas/suspensiones") +
        checkCard("Closing Odds", checks.closing, checks.closing ? "Listo para CLV/settlement" : "Pendiente de cierre") +
        "</div>";
    }
    function whyNotConfirmed(match, quality) {
      const finalStatus = String(match?.final_chain_status || "").toUpperCase();
      const missing = matchMissingFields(match);
      if (finalStatus.includes("CONFIRMED")) return "Ya esta confirmado para paper. Sigue bloqueado para dinero real.";
      if (finalStatus.includes("OBSERVATION_ONLY")) return "No confirma porque solo esta observado como universo; todavia no es pick.";
      if (missing.length) return "No confirma porque falta: " + missing.join(", ") + ".";
      if (!quality.checks.model) return "No confirma porque falta modelo, probabilidad o EV.";
      if (!quality.checks.odds) return "No confirma porque falta cuota valida.";
      if (quality.score < 61) return "No confirma porque la calidad de datos sigue incompleta.";
      return "No confirma porque aun no paso toda la cadena de riesgo, contexto y settlement.";
    }
    function footballInboxRows(matches) {
      return (matches || []).map(match => {
        const quality = matchDataQuality(match);
        const missing = matchMissingFields(match);
        const missingText = missing.map(item => String(item).toLowerCase()).join(" ");
        let bucket = "LISTO_REVIEW";
        if (missing.includes("player_intelligence_lineup") || hasAnyText(match.player_intelligence_status, ["lineup_pending"])) bucket = "LINEUP_PENDIENTE";
        else if (missing.includes("kickoff")) bucket = "KICKOFF_SIN_CONSENSO";
        else if (matchHasOdds(match) && !matchHasModel(match)) bucket = "ODDS_SIN_MODELO";
        else if (String(match.final_chain_status || "").includes("OBSERVATION")) bucket = "OBSERVATION_ONLY";
        const teamPlayerGap = missingText.includes("team_intelligence") || missingText.includes("player_intelligence");
        let priority = 5;
        if (bucket === "LISTO_REVIEW") priority = 1;
        else if (bucket === "LINEUP_PENDIENTE") priority = 2;
        else if (teamPlayerGap) priority = 3;
        else if (bucket === "KICKOFF_SIN_CONSENSO") priority = 4;
        const watcher = bucket === "LINEUP_PENDIENTE"
          ? "Lineup Watcher: esperar once oficial o cargar fuente verificada."
          : (teamPlayerGap
            ? "Context Watcher: cargar team_stats/player_stats y build-consensus."
            : (bucket === "ODDS_SIN_MODELO"
              ? "Model Watcher: falta probabilidad/EV antes de candidato."
              : (bucket === "OBSERVATION_ONLY"
                ? "Observation: guardar universo; no es pick."
                : "Review: revisar cadena completa antes de confirmar.")));
        return {
          bucket,
          priority,
          match: (match.home_team || "-") + " vs " + (match.away_team || "-"),
          league: match.league_name || match.league_id || "-",
          market: match.market || "-",
          final_chain_status: match.final_chain_status || "-",
          data_quality_grade: quality.grade,
          quality_score: quality.score,
          missing,
          team_player_gap: teamPlayerGap,
          watcher,
          recommendation: whyNotConfirmed(match, quality)
        };
      }).sort((a, b) => (a.priority - b.priority) || (b.quality_score - a.quality_score) || String(a.match).localeCompare(String(b.match)));
    }
    function renderFootballContextInbox(data) {
      const matches = data?.matches || [];
      const rows = footballInboxRows(matches);
      const count = bucket => rows.filter(row => row.bucket === bucket).length;
      $("fciLineup").textContent = String(count("LINEUP_PENDIENTE"));
      $("fciKickoff").textContent = String(count("KICKOFF_SIN_CONSENSO"));
      $("fciOddsNoModel").textContent = String(count("ODDS_SIN_MODELO"));
      $("fciReviewable").textContent = String(rows.filter(row => row.quality_score >= 55 && !["OBSERVATION_ONLY"].includes(row.bucket)).length);
      $("fciTeamPlayer").textContent = String(rows.filter(row => row.team_player_gap).length);
      $("fciStrong").textContent = String(rows.filter(row => row.quality_score >= 81).length);
      $("footballContextInboxRecommendation").textContent = rows.length
        ? "Prioridad: completar lineup, team/player intelligence y modelo donde haya odds. La tabla ya está ordenada por lo más accionable."
        : "No hay partidos en bandeja; espera universo fresco.";
      renderTable("footballContextInboxTable", [
        { label: "Prioridad", value: r => r.priority <= 2 ? "<span class='warn'>P" + r.priority + "</span>" : "<span class='badge'>P" + r.priority + "</span>" },
        { label: "Bandeja", value: r => r.bucket === "LISTO_REVIEW" ? "<span class='value'>LISTO_REVIEW</span>" : (r.bucket === "OBSERVATION_ONLY" ? "<span class='badge'>OBSERVATION_ONLY</span>" : "<span class='warn'>" + esc(r.bucket) + "</span>") },
        { label: "Partido", value: r => esc(r.match) },
        { label: "Liga", value: r => esc(r.league) },
        { label: "Mercado", value: r => marketLabel(r.market) },
        { label: "Final Chain", value: r => esc(r.final_chain_status) },
        { label: "Data Quality", value: r => r.quality_score + "/100 - " + esc(r.data_quality_grade) },
        { label: "Falta", value: r => (r.missing || []).join(", ") || "-" },
        { label: "Watcher", value: r => esc(r.watcher) },
        { label: "Accion", value: r => esc(r.recommendation) }
      ], rows);
    }
    function readinessBadge(status) {
      const normalized = String(status || "").toUpperCase();
      if (normalized.includes("CONFIRMED") || normalized === "READY_FOR_SHADOW_REVIEW") return "<span class='value'>" + esc(status || "-") + "</span>";
      if (normalized.includes("BLOCKED") || normalized.includes("REJECTED")) return "<span class='loss'>" + esc(status || "-") + "</span>";
      if (normalized.includes("NEEDS") || normalized.includes("REVIEW")) return "<span class='warn'>" + esc(status || "-") + "</span>";
      return "<span class='badge'>" + esc(status || "-") + "</span>";
    }
    function renderFootballReadinessGate(data) {
      data = data || {};
      const rows = data.rows || [];
      const hasShadowReviewAlert = data.alert_status === "ALERT_READY_FOR_SHADOW_REVIEW" || (data.ready_for_shadow_review || 0) > 0;
      const bridgeReady = data.bridge_ready_count ?? data.ready_shadow_from_chain ?? 0;
      const ticketReady = data.ticket_ready_count ?? data.ready_shadow_from_tickets ?? 0;
      $("frgDecision").textContent = hasShadowReviewAlert ? "ALERTA: READY_FOR_SHADOW_REVIEW" : (data.decision || "COLLECT_DATA_FIRST");
      $("frgDominantGap").textContent = hasShadowReviewAlert
        ? "Bridge ready: " + bridgeReady + " | Tickets shadow abiertos: " + (data.football_shadow_open_tickets || 0)
        : "Gap dominante: " + (data.dominant_gap || "-");
      $("frgObserved").textContent = String(data.observed_matches || rows.length || 0);
      $("frgActive").textContent = (data.active_candidates || 0) + " candidatos activos.";
      $("frgOddsModel").textContent = (data.with_odds_effective || data.with_odds || 0) + " / " + (data.with_model_ev_effective || data.with_model_ev || 0);
      $("frgContext").textContent = (data.with_team_context || 0) + " / " + (data.with_player_context || 0);
      $("frgReady").textContent = String(bridgeReady);
      $("frgShadowTickets").textContent = String(data.football_shadow_open_tickets || 0);
      $("frgPendingClosing").textContent = String(data.pending_closing ?? data.football_shadow_pending_closing ?? 0);
      $("frgPendingSettlement").textContent = String(data.pending_settlement ?? data.football_shadow_pending_settlement ?? 0);
      $("frgConfirmed").textContent = String(data.confirmed_paper ?? data.football_confirmed_paper ?? 0);
      $("footballReadinessGateRecommendation").textContent = hasShadowReviewAlert
        ? "Filtros activos: scope=tickets abiertos + bridge del dia. Bridge ready=" + bridgeReady + "; ticket ready=" + ticketReady + ". Sigue Shadow Paper only: no dinero real, no Kelly, no Telegram auto."
        : (data.recommendation || "Futbol debe juntar odds/modelo/contexto antes de confirmar.");
      renderTable("footballReadinessGateTable", [
        { label: "Estado", value: r => readinessBadge(r.readiness_status) },
        { label: "Match", value: r => esc(r.match || "-") },
        { label: "Liga", value: r => esc(r.league || "-") },
        { label: "Mercado", value: r => marketLabel(r.market) },
        { label: "Odds", value: r => r.odds_ready ? "<span class='value'>OK</span>" : "<span class='warn'>Falta</span>" },
        { label: "Modelo/EV", value: r => r.model_ready ? "<span class='value'>OK</span>" : "<span class='warn'>Falta</span>" },
        { label: "Team", value: r => r.team_context_ready ? "<span class='value'>OK</span>" : "<span class='warn'>Falta</span>" },
        { label: "Player/Lineup", value: r => r.player_context_ready ? "<span class='value'>OK</span>" : (r.lineup_pending ? "<span class='warn'>Lineup pendiente</span>" : "<span class='warn'>Falta</span>") },
        { label: "Falta", value: r => (r.missing_context_fields || []).join(", ") || "odds/modelo si sigue observation" },
        { label: "Siguiente accion", value: r => esc(r.recommendation || "-") }
      ], rows.length ? rows.slice(0, 40) : [{
        readiness_status: "NO_FOOTBALL_ROWS",
        match: "Sin futbol en bandeja",
        recommendation: data.recommendation || "Cargar universo de futbol en OBSERVATION_ONLY."
      }]);
    }
    function summarizeMlbContextWatch(playerIntel, scout) {
      const playerRows = (playerIntel?.rows || []).filter(row => String(row.sport_slug || row.sport || "").toLowerCase() === "baseball" && String(row.league_slug || row.league_id || "").toLowerCase() === "mlb");
      const scoutRows = (scout?.rows || []).filter(row => String(row.sport_slug || row.sport || "").toLowerCase() === "baseball" && String(row.league_slug || row.league_id || "").toLowerCase() === "mlb");
      const groups = new Map();
      playerRows.forEach(row => {
        const key = row.match_id || row.match || [row.team_name, row.observed_at].join("|");
        if (!groups.has(key)) groups.set(key, { match_id: row.match_id, match: row.match || "-", pitchers: [], missing_lineups: [], bullpen_conflicts: 0, supports: 0, manual_review: 0, latest_observed_at: row.observed_at, sources: new Set() });
        const group = groups.get(key);
        group.match = row.match || group.match;
        if (row.source) group.sources.add(row.source);
        if (new Date(row.observed_at || 0) > new Date(group.latest_observed_at || 0)) group.latest_observed_at = row.observed_at;
        const position = String(row.position || "").toLowerCase();
        const status = String(row.status || "").toLowerCase();
        const intelStatus = String(row.player_intelligence_status || "").toUpperCase();
        if (position === "p" || position.includes("pitcher") || row.role_importance === "starter") {
          group.pitchers.push((row.team_name || "-") + ": " + (row.player_name || "-") + " (" + (row.status || "-") + ")");
        }
        if (position === "lineup" && (status === "missing" || intelStatus.includes("MANUAL_REVIEW"))) {
          group.missing_lineups.push(row.team_name || row.player_name || "lineup");
        }
        if (position === "bullpen" && Number(row.impact_score || 0) < 0) group.bullpen_conflicts += 1;
        if (intelStatus.includes("SUPPORT")) group.supports += 1;
        if (intelStatus.includes("MANUAL") || Number(row.impact_score || 0) < 0) group.manual_review += 1;
      });
      scoutRows.forEach(row => {
        const key = row.match_id || row.match || row.id;
        if (!groups.has(key)) groups.set(key, { match_id: row.match_id, match: row.match || "-", pitchers: [], missing_lineups: [], bullpen_conflicts: 0, supports: 0, manual_review: 0, latest_observed_at: row.observed_at, sources: new Set() });
        const group = groups.get(key);
        if (row.source) group.sources.add(row.source);
        if (new Date(row.observed_at || 0) > new Date(group.latest_observed_at || 0)) group.latest_observed_at = row.observed_at;
        const signal = String(row.signal_type || "").toUpperCase();
        if (signal === "LINEUP_MISSING") group.manual_review += 1;
        if (signal === "BULLPEN_FATIGUE") group.bullpen_conflicts += 1;
      });
      const rows = Array.from(groups.values()).map(group => {
        const completePitchers = group.pitchers.length >= 2;
        const lineupsClear = group.missing_lineups.length === 0;
        const status = completePitchers && lineupsClear && group.bullpen_conflicts === 0
          ? "CONTEXT_READY_REVIEW"
          : (completePitchers ? "LINEUP_WATCH" : "PITCHER_WATCH");
        const recommendation = !completePitchers
          ? "Reintentar MLB Stats API hasta tener ambos pitchers probables."
          : (!lineupsClear
            ? "Esperar lineups oficiales; no confirmar con lineup missing."
            : (group.bullpen_conflicts > 0
              ? "Revisar bullpen fatigue antes de confirmar."
              : "Contexto base completo; revisar odds frescas y cadena."));
        return {
          status,
          match: group.match,
          pitchers: group.pitchers,
          missing_lineups: uniqueList(group.missing_lineups),
          bullpen_conflicts: group.bullpen_conflicts,
          supports: group.supports,
          manual_review: group.manual_review,
          source_count: group.sources.size,
          latest_observed_at: group.latest_observed_at,
          recommendation
        };
      }).sort((a, b) => {
        const order = { CONTEXT_READY_REVIEW: 1, LINEUP_WATCH: 2, PITCHER_WATCH: 3 };
        return (order[a.status] || 9) - (order[b.status] || 9) || String(a.match).localeCompare(String(b.match));
      });
      return { rows, playerRows };
    }
    function renderMlbContextWatch(playerIntel, scout) {
      const summary = summarizeMlbContextWatch(playerIntel, scout);
      const rows = summary.rows;
      const pitcherCount = rows.reduce((sum, row) => sum + row.pitchers.length, 0);
      const missingLineupCount = rows.reduce((sum, row) => sum + row.missing_lineups.length, 0);
      const conflictCount = rows.reduce((sum, row) => sum + row.bullpen_conflicts, 0);
      $("mcwMatches").textContent = String(rows.length);
      $("mcwPitchers").textContent = String(pitcherCount);
      $("mcwLineups").textContent = String(missingLineupCount);
      $("mcwConflicts").textContent = String(conflictCount);
      $("mlbContextWatchRecommendation").textContent = rows.length
        ? "MLB listo para vigilancia: pitchers primero, lineups después, luego odds frescas y settlement."
        : "Sin contexto MLB activo; esperar slate regular o correr hidratación MLB.";
      renderTable("mlbContextWatchTable", [
        { label: "Estado", value: r => r.status === "CONTEXT_READY_REVIEW" ? "<span class='value'>CONTEXT_READY_REVIEW</span>" : "<span class='warn'>" + esc(r.status) + "</span>" },
        { label: "Match", value: r => esc(r.match) },
        { label: "Pitchers", value: r => (r.pitchers || []).map(esc).join("<br>") || "-" },
        { label: "Lineups faltantes", value: r => (r.missing_lineups || []).map(esc).join("<br>") || "-" },
        { label: "Bullpen conflicts", value: r => r.bullpen_conflicts || 0 },
        { label: "Supports", value: r => r.supports || 0 },
        { label: "Manual review", value: r => r.manual_review || 0 },
        { label: "Sources", value: r => r.source_count || 0 },
        { label: "Último", value: r => fmtDateTime(r.latest_observed_at) },
        { label: "Qué hacer", value: r => esc(r.recommendation) }
      ], rows.length ? rows : [{
        status: "NO_MLB_CONTEXT",
        match: "Sin MLB activo",
        recommendation: "Esperar slate regular; no inventar contexto."
      }]);
    }
    function renderMlbNoBetSummary(commandCenter, pickDecisions, noBetIntelligence) {
      const noBetRows = noBetIntelligence?.rows || [];
      const command = commandCenter || {};
      const rows = noBetRows.length ? noBetRows : [{
        reason_label: command.dominant_block_reason || "no_fresh_candidates",
        reason_code: command.dominant_block_reason || "no_fresh_candidates",
        severity: "watch",
        occurrences: 1,
        sample: { action: command.recommended_action || "DATA_REFRESH_NEEDED" },
        last_seen_at: null,
        recommendation: command.recommendation || command.recommended_action || "Esperar siguiente ciclo MLB fresco."
      }];
      $("mlbNoBetSummaryRecommendation").textContent = command.dominant_block_reason
        ? "Hoy MLB no confirma porque domina: " + command.dominant_block_reason + "."
        : "Resumen de razones por las que MLB no promueve picks.";
      renderTable("mlbNoBetSummaryTable", [
        { label: "Razón", value: r => esc(r.reason_label || r.reason_code || "-") },
        { label: "Código", value: r => esc(r.reason_code || "-") },
        { label: "Severidad", value: r => r.severity === "block" ? "<span class='loss'>block</span>" : "<span class='warn'>" + esc(r.severity || "watch") + "</span>" },
        { label: "Ocurrencias", value: r => r.occurrences || 0 },
        { label: "Ejemplo", value: r => esc(JSON.stringify(r.sample || {})) },
        { label: "Último", value: r => fmtDateTime(r.last_seen_at) },
        { label: "Qué hacer", value: r => esc(r.recommendation || "No forzar pick; esperar datos limpios.") }
      ], rows);
    }
    function firstValue(...values) {
      return values.find(value => value !== null && value !== undefined && value !== "");
    }
    function formatWinLoss(row) {
      const wins = firstValue(row.wins, row.win_count, row.results?.wins, row.metrics?.wins);
      const losses = firstValue(row.losses, row.loss_count, row.results?.losses, row.metrics?.losses);
      if (wins === undefined && losses === undefined) return "<span class='muted'>N/A</span>";
      return String(Number(wins || 0)) + "/" + String(Number(losses || 0));
    }
    function uniqueList(values) {
      return Array.from(new Set((values || []).filter(Boolean)));
    }
    function pickNegativeReasons(pick) {
      const status = String(pick.simple_status || pick.pick_decision_status || pick.pick_decision || "");
      const decision = String(pick.pick_decision_status || pick.pick_decision || "");
      const underdog = String(pick.underdog_plus_status || "");
      const matchup = String(pick.matchup_status || "");
      const evAudit = String(pick.high_ev_status || pick.high_ev_audit_status || "");
      const reasons = []
        .concat(pick.blocking_reasons || [])
        .concat(pick.negative_reasons || []);
      if (status.includes("MODEL_CONFLICT") || matchup.includes("MODEL_CONFLICT")) {
        reasons.push("Conflicto de matchup: revisar contexto antes de tocar.");
      }
      if (decision.includes("BLOCKED") || status.includes("BLOCKED")) {
        reasons.push("Risk Engine bloquea este pick.");
      }
      if (underdog.includes("BLOCKED")) {
        reasons.push("Underdog Plus bloqueado: no promover sin revision.");
      }
      if (status.includes("REJECT") || decision.includes("REJECT")) {
        reasons.push("No cumple filtros minimos.");
      }
      if (["ODDS_OUTLIER_REVIEW", "PROVIDER_REVIEW", "EXTREME_EV_REVIEW"].includes(evAudit)) {
        reasons.push("EV audit " + evAudit + ": requiere revision extra.");
      }
      return uniqueList(reasons);
    }
    function finiteNumber(...values) {
      for (const value of values) {
        if (value === null || value === undefined || value === "") continue;
        const number = Number(value);
        if (Number.isFinite(number)) return number;
      }
      return null;
    }
    function countDataQualityTier(dataQualityScores, tier) {
      const wanted = String(tier || "").toUpperCase();
      const summary = dataQualityScores?.summary || dataQualityScores?.counts || dataQualityScores?.tier_counts || {};
      const direct = finiteNumber(summary[wanted], summary[wanted.toLowerCase()]);
      if (direct !== null) return direct;
      return (dataQualityScores?.rows || []).filter(row => String(row.tier || "").toUpperCase() === wanted).length;
    }
    function pickModelProbability(row) {
      return finiteNumber(row.model_probability, row.model_probability_audit, row.metrics?.model_probability);
    }
    function pickExpectedValue(row) {
      return finiteNumber(row.expected_value, row.real_expected_value, row.metrics?.expected_value);
    }
    function normalizedMatchName(row) {
      return String(matchLabel(row) || row?.match || "-").trim().toLowerCase();
    }
    function uniqueDecisionRows(rows) {
      const seen = new Set();
      const out = [];
      (rows || []).forEach(row => {
        const key = [
          normalizedMatchName(row),
          row.pick || row.pick_label || row.market_selection || "",
          row.market_type || row.market || ""
        ].join("|");
        if (seen.has(key)) return;
        seen.add(key);
        out.push(row);
      });
      return out;
    }
    function dataQualityStrongMatches(dataQualityScores) {
      return new Set((dataQualityScores?.rows || [])
        .filter(row => String(row.tier || "").toUpperCase() === "STRONG")
        .map(row => String(row.match || "").trim().toLowerCase())
        .filter(Boolean));
    }
    function reasonFromDecisionRow(row) {
      const probability = pickModelProbability(row);
      const ev = pickExpectedValue(row);
      const missing = uniqueList([]
        .concat(asArray(row.missing_context_fields))
        .concat(asArray(row.missing_components))
        .concat(asArray(row.block_confirmation_reasons))
        .concat(asArray(row.blocking_reasons))
      ).map(value => String(value));
      const text = [
        row.final_chain_status,
        row.simple_status,
        row.pick_decision_status,
        row.pick_decision,
        row.freshness_status,
        row.duplicate_status,
        row.high_ev_status,
        row.matchup_status,
        row.intelligence_status,
        row.player_intelligence_status
      ].join(" ").toLowerCase();
      if (probability !== null && probability < 0.55) {
        return "Falta modelo >=55% (tiene " + (probability * 100).toFixed(2) + "%).";
      }
      if (missing.some(item => item.toLowerCase().includes("lineup"))) return "Falta lineup oficial o contexto de bateo/alineación.";
      if (missing.some(item => item.toLowerCase().includes("pitcher"))) return "Falta pitcher confirmado o mapeo válido.";
      if (missing.some(item => item.toLowerCase().includes("bullpen"))) return "Falta bullpen fresco.";
      if (missing.some(item => item.toLowerCase().includes("travel") || item.toLowerCase().includes("rest"))) return "Falta descanso/viaje.";
      if (text.includes("stale")) return "La línea está vieja; no se confirma.";
      if (text.includes("duplicate")) return "Hay exposición duplicada; no se dobla riesgo.";
      if (text.includes("high") && text.includes("review")) return "EV alto en revisión para evitar valor inflado.";
      if (ev !== null && ev <= 0) return "EV no supera el mínimo.";
      return row.recommendation || row.recommended_action || "No completó toda la cadena de confirmación.";
    }
    function buildExecutiveReasons(commandCenter, confirmedPickChain, dataQualityScores, whyNoBettablePaper) {
      const strongMatches = dataQualityStrongMatches(dataQualityScores);
      const chainRows = confirmedPickChain?.rows || [];
      const todayRows = commandCenter?.today_picks_simple || [];
      const rows = uniqueDecisionRows(todayRows.concat(chainRows));
      const nearRows = rows.filter(row => {
        const probability = pickModelProbability(row);
        const key = normalizedMatchName(row);
        if (strongMatches.has(key)) return true;
        return probability !== null && probability >= 0.535 && probability < 0.55;
      }).slice(0, 3);
      if (nearRows.length) {
        return nearRows.map(row => ({
          title: matchLabel(row),
          body: reasonFromDecisionRow(row)
        }));
      }
      const reasonRows = (whyNoBettablePaper?.reasons || []).slice(0, 3);
      if (reasonRows.length) {
        return reasonRows.map(row => ({
          title: row.reason || row.reason_code || row.reason_label || "Bloqueo",
          body: row.recommendation || ("Ocurrencias: " + (row.count || row.occurrences || 0))
        }));
      }
      const dominant = commandCenter?.dominant_block_reason || whyNoBettablePaper?.dominant_reason;
      if (dominant) {
        return [{ title: dominant, body: commandCenter?.recommendation || whyNoBettablePaper?.recommendation || "Esperar datos frescos y cadena completa." }];
      }
      return [{ title: "Sin cadena completa", body: "No hay pick con modelo, odds, contexto, closing y guardrails alineados." }];
    }
    function renderExecutiveDecisionHeader(commandCenter, confirmedPickChain, dataQualityScores, whyNoBettablePaper) {
      const cc = commandCenter || {};
      const chain = confirmedPickChain || {};
      const counts = cc.counts || {};
      const guardrails = cc.guardrails || {};
      const confirmed = finiteNumber(chain.bettable_paper_confirmed, chain.confirmed_paper, counts.bettable_paper_confirmed) || 0;
      const active = finiteNumber(chain.active_picks, counts.active_picks, (cc.today_picks_simple || []).length) || 0;
      const bettable = finiteNumber(counts.bettable_paper, chain.eligible_for_confirmation) || 0;
      const strong = countDataQualityTier(dataQualityScores, "STRONG");
      const reviewable = countDataQualityTier(dataQualityScores, "REVIEWABLE");
      const nearCandidateCount = uniqueDecisionRows((cc.today_picks_simple || []).concat(chain.rows || []))
        .filter(row => {
          const probability = pickModelProbability(row);
          return probability !== null && probability >= 0.535 && probability < 0.55;
        }).length;
      const realMoneyOff = !guardrails.real_money_enabled;
      const kellyOff = !guardrails.kelly_enabled;
      const telegramOff = !guardrails.telegram_auto_enabled;
      const realCandidateCount = finiteNumber(cc.real_candidate_count, counts.real_candidate, guardrails.real_candidate_count) || 0;
      let state = "no-bet";
      let badge = "NO BET TODAY";
      let headline = "No hay pick para tomar hoy";
      let summary = "El sistema no encontró una cadena completa. Esto es correcto: no se fuerza una jugada por EV.";
      let action = "NO APOSTAR";
      let actionReason = "Seguir en Real Paper / Review Only.";
      if (confirmed > 0) {
        state = "confirmed";
        badge = "CONFIRMED PAPER";
        headline = "Hay candidato paper confirmado";
        summary = "Existe al menos un pick con cadena completa para medir en paper. Sigue sin dinero real.";
        action = "PAPER ONLY";
        actionReason = "Revisar manualmente; dinero real sigue apagado.";
      } else if (strong > 0 || bettable > 0 || nearCandidateCount > 0) {
        state = "near";
        badge = "NEAR MISS / NO BET";
        headline = "Hay señales cerca, pero no confirmadas";
        summary = "Algunos candidatos tienen datos fuertes o buen EV, pero todavía falta un requisito de la cadena.";
        action = "NO APOSTAR";
        actionReason = "Esperar que pase modelo, contexto y closing sin bloques.";
      } else if (active > 0 || reviewable > 0) {
        state = "review";
        badge = "REVIEW ONLY";
        headline = "Hay candidatos en revisión";
        summary = "Sirven para aprender y auditar, pero no alcanzan confirmación paper.";
        action = "REVISAR";
        actionReason = "No promover sin cadena completa.";
      }
      const header = $("executiveDecisionHeader");
      if (header) header.className = "executive-decision state-" + state;
      const badgeEl = $("execStateBadge");
      if (badgeEl) {
        badgeEl.className = "exec-badge " + (state === "no-bet" ? "no-bet" : state);
        badgeEl.textContent = badge;
      }
      $("execHeadline").textContent = headline;
      $("execSummary").textContent = summary;
      $("execAction").textContent = action;
      $("execActionReason").textContent = actionReason;
      $("execConfirmedPaper").textContent = String(confirmed);
      $("execActivePicks").textContent = String(active);
      $("execStrongData").textContent = String(strong);
      $("execGuardrails").textContent = (realMoneyOff && kellyOff && telegramOff && realCandidateCount === 0) ? "OK" : "REVISAR";
      const reasons = buildExecutiveReasons(cc, chain, dataQualityScores, whyNoBettablePaper).slice(0, 3);
      const cards = reasons.map(reason => "<div class='exec-reason'><strong>" + esc(reason.title) + "</strong><p>" + esc(reason.body) + "</p></div>").join("");
      $("execReasonList").innerHTML = cards;
      $("whyNoPickTodaySummary").textContent = confirmed > 0
        ? "Sí hay confirmado paper, pero sigue sin permiso de dinero real."
        : (active || strong || reviewable ? "No hay pick confirmado. Estas son las razones principales." : "No hay candidatos frescos con cadena suficiente hoy.");
      $("whyNoPickTodayList").innerHTML = cards;
    }
    function bestNumeric(values, mode) {
      const numbers = values.map(value => Number(value)).filter(value => Number.isFinite(value));
      if (!numbers.length) return null;
      return mode === "min" ? Math.min(...numbers) : Math.max(...numbers);
    }
    function groupPendingSettlementRows(rows) {
      const groups = new Map();
      (rows || []).forEach(row => {
        const key = [
          row.match_id || "",
          row.home_team || "",
          row.away_team || "",
          row.market_type || row.market || "moneyline_2way",
          row.pick || row.selection || ""
        ].join("|");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      });
      return Array.from(groups.values()).map(group => {
        const sorted = group.slice().sort((a, b) => new Date(b.entry_timestamp || b.latest_entry || b.match_date || 0) - new Date(a.entry_timestamp || a.latest_entry || a.match_date || 0));
        const latest = sorted[0] || {};
        return Object.assign({}, latest, {
          row_type: "Grupo",
          snapshots_count: group.length,
          latest_entry_odds: firstValue(latest.entry_odds, latest.latest_entry_odds),
          best_entry_odds: bestNumeric(group.map(row => firstValue(row.entry_odds, row.latest_entry_odds)), "max")
        });
      });
    }
    function hasFootballMarketData(row) {
      const dataCount = [
        row.closed,
        row.total,
        row.open,
        row.wins,
        row.losses,
        row.pushes,
        row.profit,
        row.profit_units,
        row.market_snapshots,
        row.shadow_candidates,
        row.shadow_paper
      ].map(value => Number(value || 0)).reduce((sum, value) => sum + value, 0);
      return dataCount > 0;
    }
    function isEmptyGlobalFootballRow(row) {
      const league = String(row.league_id || row.league_slug || row.league_display_name || "").toUpperCase();
      return league === "GLOBAL" && !hasFootballMarketData(row);
    }
    function visibleFootballRows(rows) {
      return (rows || []).filter(row => {
        if (isEmptyGlobalFootballRow(row)) return false;
        if (hasFootballMarketData(row)) return true;
        if (row.status === "BLOCKED") return true;
        return ["FAVORITE", "WATCH"].includes(row.tier || row.priority || "");
      });
    }
    function hasMeaningfulClvRow(row) {
      if (!row) return false;
      const hasGroup = Boolean(row.group_type || row.group_value);
      const dataCount = [
        row.total,
        row.closed,
        row.wins,
        row.losses,
        row.pushes,
        row.profit_units,
        row.avg_clv,
        row.positive_clv_rate
      ].map(value => Number(value || 0)).reduce((sum, value) => sum + Math.abs(value), 0);
      return hasGroup || dataCount > 0;
    }
    function hasMeaningfulPromotionRow(row) {
      if (!row) return false;
      return Boolean(row.rule_key || row.sport_slug || row.league_slug || row.market_type || row.segment || row.status);
    }
    function providerDisplay(row) {
      return esc(row.provider_name || row.provider || row.source || row.bookmaker || "Sin provider");
    }
    function liveStatusClass(status) {
      const text = String(status || "").toLowerCase();
      if (text.includes("confirmed")) return "confirmed";
      if (text.includes("blocked") || text.includes("reject")) return "blocked";
      if (text.includes("review") || text.includes("value")) return "review";
      if (text.includes("observation") || text.includes("shadow")) return "shadow";
      return "";
    }
    function liveTime(value) {
      if (!value) return "-";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return esc(value);
      return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    function renderLiveMatchDetail(match) {
      const detail = $("liveMatchDetail");
      if (!detail) return;
      if (!match) {
        detail.innerHTML = "<h3>Detalle</h3><p class='muted'>Selecciona un partido para ver odds, inteligencia, pick chain y settlement.</p>";
        return;
      }
      const d = match.detail || {};
      const quality = matchDataQuality(match);
      detail.innerHTML =
        "<h3>" + esc(match.home_team) + " vs " + esc(match.away_team) + "</h3>" +
        "<p class='muted'>" + esc(match.league_name || match.league_id) + " | " + esc(match.status) + " | " + liveTime(match.start_time) + "</p>" +
        renderQualityStrip(quality) +
        "<div class='why-box'><strong>Why Not Confirmed?</strong><p>" + esc(whyNotConfirmed(match, quality)) + "</p></div>" +
        renderMatchChecklist(match, quality) +
        "<div class='live-detail-grid'>" +
        "<div><span>Accion</span><strong>" + esc(match.recommended_action || "WAIT") + "</strong></div>" +
        "<div><span>Final Chain</span><strong>" + esc(match.final_chain_status || "NO_DATA") + "</strong></div>" +
        "<div><span>Pick</span><strong>" + esc(match.recommended_pick || "Sin pick") + "</strong></div>" +
        "<div><span>Odds / EV</span><strong>" + esc(match.odds || "-") + " / " + (match.expected_value === null || match.expected_value === undefined ? "-" : fmtPct(match.expected_value)) + "</strong></div>" +
        "<div><span>Provider</span><strong>" + esc(match.provider || "-") + "</strong></div>" +
        "<div><span>Intelligence</span><strong>" + esc(match.intelligence_status || "NO_CONTEXT") + "</strong></div>" +
        "<div><span>Player Context</span><strong>" + esc(match.player_intelligence_status || "NO_CONTEXT") + "</strong></div>" +
        "<div><span>Settlement</span><strong>" + esc(match.settlement_status || "NONE") + "</strong></div>" +
        "<div><span>Freshness</span><strong>" + esc(d.freshness_status || "-") + "</strong></div>" +
        "<div><span>Missing / Blocks</span><strong>" + esc([...(d.missing_context_fields || []), ...(d.block_confirmation_reasons || [])].join(", ") || "-") + "</strong></div>" +
        "</div>";
    }
    function renderSportsLiveBoard(data) {
      data = data || {};
      const summary = data.summary || {};
      const fallbackText = data.date_fallback_applied
        ? "Fecha sin partidos: " + (data.fallback_reason || ("mostrando " + (data.date || "slate cercano"))) + " "
        : "";
      $("liveBoardRecommendation").textContent = fallbackText + (data.recommendation || "Usar Live Board para revisar partidos sin forzar picks.");
      $("liveBoardDate").textContent = data.date || "-";
      $("liveGamesToday").textContent = String(summary.games_today || summary.matches_today || 0);
      $("liveConfirmedPaper").textContent = String(summary.confirmed_paper || 0);
      $("liveReview").textContent = String(summary.review || 0);
      $("liveBlocked").textContent = String(summary.blocked || 0);
      $("livePendingSettlement").textContent = String(summary.pending_settlement || 0);

      const alerts = data.alerts || [];
      $("liveBoardAlerts").innerHTML = alerts.length
        ? alerts.map(alert => "<span class='live-alert'>" + esc(alert) + "</span>").join("")
        : "<span class='live-alert'>Sin alertas: esperar slate fresco o datos validados.</span>";

      const leagues = data.leagues || [];
      $("liveLeagueList").innerHTML = leagues.length
        ? leagues.map(league => "<div class='live-league-row'><span>" + esc(league.league_name || league.league_id) + "</span><strong>" + esc(league.games_today || 0) + "</strong></div>").join("")
        : "<p class='muted'>Sin ligas activas hoy.</p>";

      const matches = data.matches || [];
      $("liveMatchCards").innerHTML = matches.length
        ? matches.map((match, index) => {
            const statusClass = liveStatusClass(match.final_chain_status);
            const action = match.recommended_action || "WAIT";
            const quality = matchDataQuality(match);
            return "<article class='live-match-card' data-live-index='" + index + "'>" +
              "<header><span class='badge'>" + esc(match.league_name || match.league_id) + "</span><span class='muted'>" + liveTime(match.start_time) + "</span></header>" +
              "<h3>" + esc(match.home_team) + " vs " + esc(match.away_team) + "</h3>" +
              "<div class='live-meta'>" +
              "<span class='live-status " + statusClass + "'>" + esc(match.final_chain_status || "NO_DATA") + "</span>" +
              "<span class='live-status'>" + esc(match.status || "-") + "</span>" +
              "<span class='live-status'>" + esc(match.player_intelligence_status || "NO_CONTEXT") + "</span>" +
              "<span class='live-status " + (quality.score >= 81 ? "confirmed" : (quality.score >= 61 ? "shadow" : "review")) + "'>DQ " + quality.score + "</span>" +
              "</div>" +
              "<p class='muted'>" + esc(action) + "</p>" +
              "</article>";
          }).join("")
        : "<p class='muted'>Sin partidos observados o picks activos para esta fecha.</p>";

      $("liveMatchCards").querySelectorAll("[data-live-index]").forEach(card => {
        card.addEventListener("click", () => renderLiveMatchDetail(matches[Number(card.getAttribute("data-live-index"))]));
      });
      renderLiveMatchDetail(matches[0]);
      renderFootballContextInbox(data);
    }
    function renderPicksToFollow(bestBetsPerMatch) {
      const data = bestBetsPerMatch || {};
      const rows = (data.rows || []);
      const interestingStatuses = new Set([
        "CONFIRMED_PAPER",
        "FOOTBALL_CONFIRMED_PAPER",
        "BETTABLE_PAPER",
        "WAITING_VALID_CLOSING",
        "READY_FOR_SETTLEMENT",
        "READY_FOR_SHADOW_REVIEW",
        "SHADOW_TICKET_READY",
        "CONTEXT_GAPS"
      ]);
      const hasFinancialRead = r => r.odds && r.model_probability !== null && r.model_probability !== undefined && r.expected_value !== null && r.expected_value !== undefined;
      const rank = r => {
        const status = String(r.status || "").toUpperCase();
        if (status.includes("CONFIRMED")) return 100;
        if (status === "BETTABLE_PAPER") return 90;
        if (status === "WAITING_VALID_CLOSING") return 85;
        if (status === "READY_FOR_SETTLEMENT") return 80;
        if (status === "READY_FOR_SHADOW_REVIEW") return 75;
        if (status === "SHADOW_TICKET_READY") return 70;
        if (status === "CONTEXT_GAPS" && hasFinancialRead(r)) return 60;
        return 0;
      };
      const actionFor = r => {
        const status = String(r.status || "").toUpperCase();
        if (status.includes("CONFIRMED")) return "Paper confirmado; dinero real sigue OFF.";
        if (status === "BETTABLE_PAPER") return "Seguir fuerte: near-start + closing antes de confiar.";
        if (status === "WAITING_VALID_CLOSING") return "Seguir closing: capturar solo cuando diga CAPTURE_CLOSING_NOW.";
        if (status === "READY_FOR_SETTLEMENT") return "Esperar resultado final verificado y correr settlement.";
        if (status === "READY_FOR_SHADOW_REVIEW") return "Revisar shadow: falta cerrar contexto/closing.";
        if (status === "SHADOW_TICKET_READY") return "Ticket auditable: seguir contexto y closing.";
        if (status === "CONTEXT_GAPS") return "Seguir solo si se llena lineup/pitcher/portero.";
        return "No seguir como pick; solo observacion.";
      };
      const watchRows = rows
        .filter(r => interestingStatuses.has(String(r.status || "").toUpperCase()))
        .filter(r => String(r.status || "").toUpperCase() !== "CONTEXT_GAPS" || hasFinancialRead(r) || Number(r.context_score || 0) >= 60)
        .sort((a, b) => rank(b) - rank(a) || Number(b.final_score || 0) - Number(a.final_score || 0) || Number(b.expected_value || -999) - Number(a.expected_value || -999))
        .slice(0, 12);
      const high = watchRows.filter(r => ["BETTABLE_PAPER", "WAITING_VALID_CLOSING", "READY_FOR_SETTLEMENT"].includes(String(r.status || "").toUpperCase())).length;
      const closing = watchRows.filter(r => String(r.status || "").toUpperCase() === "WAITING_VALID_CLOSING").length;
      $("picksToFollowRecommendation").textContent = watchRows.length
        ? "Sigue estos candidatos actuales. No vienen del profit historico; vienen de Best Bet + Preflight + guardrails."
        : "No hay picks para seguir ahora. Paper Performance es laboratorio historico, no lista operativa.";
      $("ptfTotal").textContent = String(watchRows.length);
      $("ptfHigh").textContent = String(high);
      $("ptfClosing").textContent = String(closing);
      $("ptfRealMoney").textContent = "OFF";
      renderTable("picksToFollowTable", [
        { label: "Prioridad", value: r => {
          const value = rank(r);
          const label = value >= 85 ? "ALTA" : value >= 70 ? "MEDIA" : "BAJA";
          const cls = value >= 85 ? "value" : value >= 70 ? "warn" : "badge";
          return "<span class='" + cls + "'>" + label + "</span>";
        } },
        { label: "Estado", value: r => {
          const status = String(r.status || "-");
          const cls = status.includes("CONFIRMED") ? "value" : (status.includes("NO_BET") ? "loss" : "warn");
          return "<span class='" + cls + "'>" + esc(status) + "</span>";
        } },
        { label: "Partido", value: r => esc(r.match || "-") },
        { label: "Sport", value: r => esc((r.sport || "-") + "/" + (r.league_id || "-")) },
        { label: "Kickoff", value: r => liveTime(r.kickoff) },
        { label: "Mercado", value: r => esc(r.best_market || "-") },
        { label: "Pick", value: r => pickLabel(r.pick || "none") },
        { label: "Odds", value: r => fmtOdds(r.odds) },
        { label: "Modelo", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
        { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
        { label: "Falta", value: r => (r.why_no || []).slice(0, 3).map(esc).join("<br>") || "Esperar cadena final" },
        { label: "Que hacer", value: r => esc(actionFor(r)) }
      ], watchRows.length ? watchRows : [{
        status: "NO_PICK_TO_FOLLOW",
        match: "Sin candidatos actuales",
        sport: "all",
        league_id: "-",
        best_market: "-",
        pick: "none",
        why_no: ["No usar Paper Performance como lista de picks"],
        final_score: 0,
        recommendation: "Esperar Best Bet / Preflight / Closing Window."
      }]);
    }
    function renderBestBetsPerMatch(data, nearStartContext) {
      data = data || {};
      const summary = data.summary || {};
      const near = nearStartContext || {};
      const nearSummary = near.summary || {};
      $("bestBetsPerMatchRecommendation").textContent = data.recommendation || "Mejor lectura por partido. No reemplaza Confirmed Pick Chain.";
      $("bbmMatches").textContent = String(summary.matches || 0);
      $("bbmConfirmed").textContent = String(summary.confirmed_paper || 0);
      $("bbmBettable").textContent = String(summary.bettable_paper || 0);
      $("bbmShadowTicket").textContent = String(summary.shadow_ticket_ready || 0);
      $("bbmCalibrating").textContent = String(summary.calibrating || 0);
      $("bbmWaitingClosing").textContent = String(summary.waiting_valid_closing || 0);
      $("bbmNoFinancial").textContent = String(summary.no_financial_bet || 0);
      $("bbmNearStart").textContent = near.last_near_start_run_at ? liveTime(near.last_near_start_run_at) : "-";
      $("bbmNearStartMeta").textContent = near.last_near_start_run_at
        ? "MLB scanned " + (nearSummary.scanned || 0) + " | confirmed " + (nearSummary.promoted_to_confirmed_paper || 0) + " | gaps " + (nearSummary.still_context_gaps || 0)
        : "Sin corrida near-start para esta fecha.";
      renderTable("bestBetsPerMatchTable", [
        { label: "Estado", value: r => {
          const status = String(r.status || "-");
          const cls = status.includes("CONFIRMED") ? "value" : (status.includes("NO_BET") ? "loss" : "warn");
          return "<span class='" + cls + "'>" + esc(status) + "</span>";
        } },
        { label: "Partido", value: r => esc(r.match || "-") },
        { label: "Sport", value: r => esc((r.sport || "-") + "/" + (r.league_id || "-")) },
        { label: "Kickoff", value: r => liveTime(r.kickoff) },
        { label: "Mejor mercado", value: r => esc(r.best_market || "-") },
        { label: "Pick", value: r => pickLabel(r.pick || "none") },
        { label: "Odds", value: r => fmtOdds(r.odds) },
        { label: "Modelo", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
        { label: "Fair", value: r => fmtOdds(r.fair_odds) },
        { label: "Min EV", value: r => r.min_market_odds_for_ev === null || r.min_market_odds_for_ev === undefined ? "-" : fmtOdds(r.min_market_odds_for_ev) },
        { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
        { label: "Fuente", value: r => esc(r.provider || "-") },
        { label: "Context", value: r => "<span class='" + (Number(r.context_score || 0) >= 81 ? "value" : Number(r.context_score || 0) >= 61 ? "warn" : "loss") + "'>" + esc(r.context_score ?? "-") + "/100</span>" },
        { label: "Market", value: r => esc(r.market_score ?? "-") + "/100" },
        { label: "Final", value: r => esc(r.final_score ?? "-") + "/100" },
        { label: "Por que si", value: r => (r.why_yes || []).slice(0, 3).map(esc).join("<br>") || "-" },
        { label: "Por que no", value: r => (r.why_no || []).slice(0, 4).map(esc).join("<br>") || "-" },
        { label: "Accion", value: r => esc(r.recommendation || "REVIEW_ONLY") }
      ], (data.rows || []).length ? data.rows : [{
        status: "SIN_DATOS",
        match: "Sin partidos",
        best_market: "-",
        pick: "none",
        context_score: 0,
        market_score: 0,
        final_score: 0,
        why_yes: [],
        why_no: ["Esperar slate fresco o datos validados"],
        recommendation: data.recommendation || "Sin mejores lecturas todavia."
      }]);
    }
    function renderBottleneckBySource(data) {
      data = data || {};
      const rows = data.rows || [];
      const summary = data.summary || {};
      const blockBadge = value => {
        const normalized = String(value || "").toUpperCase();
        const cls = normalized.includes("HARD") || normalized.includes("POST_KICKOFF") || normalized.includes("SOURCE")
          ? "loss"
          : (normalized.includes("WAITING") || normalized.includes("MANUAL") ? "warn" : "badge");
        return "<span class='" + cls + "'>" + esc(value || "-") + "</span>";
      };
      const dataBadge = value => {
        const normalized = String(value || "").toUpperCase();
        const cls = normalized === "READY" ? "value" : (normalized.includes("CAPTURED") || normalized.includes("SOURCE") || normalized.includes("MISMATCH") ? "loss" : "warn");
        return "<span class='" + cls + "'>" + esc(value || "-") + "</span>";
      };
      $("bottleneckBySourceRecommendation").textContent = data.recommendation || "Bottleneck cargado. Es lectura operativa; no cambia picks.";
      $("bbsMainBlock").textContent = rows[0] ? String(rows[0].missing_field || "-") : "-";
      $("bbsMainAction").textContent = summary.next_exact_action || "Sin accion pendiente.";
      $("bbsFootballBlock").textContent = summary.principal_football_block || "-";
      $("bbsMlbBlock").textContent = summary.principal_mlb_block || "-";
      $("bbsWaitingClosing").textContent = String(summary.tickets_waiting_valid_closing || 0);
      $("bbsMlbPostKickoff").textContent = String(summary.mlb_post_kickoff_games || 0);
      $("bbsExternalSource").textContent = String(summary.external_source_required || 0);
      renderTable("bottleneckBySourceTable", [
        { label: "Priority", value: r => esc(r.priority ?? "-") },
        { label: "Sport", value: r => esc(r.sport || "-") },
        { label: "Missing Field", value: r => esc(r.missing_field || "-") },
        { label: "Source Needed", value: r => esc(r.source_needed || "-") },
        { label: "Resolver Module", value: r => esc(r.resolver_module || "-") },
        { label: "Blocking Level", value: r => blockBadge(r.blocking_level) },
        { label: "Data Status", value: r => dataBadge(r.data_status) },
        { label: "Matches", value: r => esc(String(r.count || 0)) + "<br><small>" + esc((r.matches_affected || []).slice(0, 3).join(" | ") || "-") + "</small>" },
        { label: "Next Window", value: r => esc(r.next_run_window || "-") },
        { label: "Recommended Action", value: r => esc(r.recommended_action || "-") }
      ], rows.length ? rows.slice(0, 80) : [{
        priority: "-",
        sport: data.sport || "all",
        missing_field: "none",
        source_needed: "-",
        resolver_module: "-",
        blocking_level: "READY",
        data_status: "READY",
        count: 0,
        matches_affected: [],
        next_run_window: "-",
        recommended_action: data.recommendation || "Sin bloqueos detectados."
      }]);
    }
    function renderClosingWindowWatch(data) {
      data = data || {};
      const rows = data.rows || [];
      const statusBadge = value => {
        const normalized = String(value || "").toUpperCase();
        const cls = normalized === "IN_VALID_CLOSING_WINDOW" || normalized === "CAPTURED_ON_TIME"
          ? "value"
          : (normalized === "MISSED_WINDOW" || normalized === "CAPTURED_LATE" ? "loss" : "warn");
        return "<span class='" + cls + "'>" + esc(value || "-") + "</span>";
      };
      $("closingWindowWatchRecommendation").textContent = data.recommendation || "Closing watch cargado. No captura cuotas ni crea picks.";
      $("cwwValid").textContent = String(data.in_valid_closing_window || 0);
      $("cwwWaiting").textContent = String(data.waiting_window || 0);
      $("cwwMissed").textContent = String(data.missed_window || 0);
      $("cwwOnTime").textContent = String(data.captured_on_time || 0);
      $("cwwFootballWaiting").textContent = String(data.football_waiting_closing || 0);
      $("cwwMlbWaiting").textContent = String(data.mlb_missed_or_waiting_closing || 0);
      renderTable("closingWindowWatchTable", [
        { label: "Match", value: r => esc(r.match || "-") },
        { label: "Sport", value: r => esc((r.sport || "-") + "/" + (r.league || "-")) },
        { label: "Kickoff", value: r => liveTime(r.kickoff) },
        { label: "Window", value: r => esc((r.valid_window || {}).start || "-") + "<br><small>" + esc((r.valid_window || {}).end || "-") + "</small>" },
        { label: "Current Status", value: r => statusBadge(r.current_status) },
        { label: "Tickets", value: r => esc(r.tickets ?? 1) },
        { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
        { label: "Closing Quality", value: r => esc(r.closing_quality || "-") },
        { label: "Delta Window", value: r => r.minutes_from_valid_window === null || r.minutes_from_valid_window === undefined ? "-" : esc(r.minutes_from_valid_window + " min") },
        { label: "Why Invalid", value: r => esc(r.closing_why_invalid || "-") },
        { label: "Next Action", value: r => esc(r.next_action || "-") }
      ], rows.length ? rows.slice(0, 80) : [{
        match: "Sin tickets en closing watch",
        sport: data.sport || "all",
        current_status: "WAITING_WINDOW",
        tickets: 0,
        next_action: data.recommendation || "Esperar ventana valida."
      }]);
    }
    function renderClosingCaptureDraft(data) {
      data = data || {};
      const rows = data.rows || [];
      const stateBadge = value => {
        const normalized = String(value || "").toUpperCase();
        const cls = normalized === "CAPTURE_CLOSING_NOW" || normalized === "CAPTURED_ON_TIME"
          ? "value"
          : (normalized === "MISSED_WINDOW" || normalized === "CAPTURED_LATE" ? "loss" : "warn");
        return "<span class='" + cls + "'>" + esc(value || "-") + "</span>";
      };
      const payloadPreview = r => {
        const payload = String(r.payload_draft_json || "-");
        return "<pre style='white-space:pre-wrap;max-width:560px;max-height:220px;overflow:auto;margin:0;font-size:11px;'>" + esc(payload) + "</pre>";
      };
      $("closingCaptureDraftRecommendation").textContent = data.recommendation || "Drafts cargados. No enviar si no esta en CAPTURE_CLOSING_NOW.";
      $("ccdScanned").textContent = String(data.scanned || 0);
      $("ccdNow").textContent = String(data.capture_closing_now || 0);
      $("ccdWaiting").textContent = String(data.waiting_window || 0);
      $("ccdMissed").textContent = String(data.missed_window || 0);
      renderTable("closingCaptureDraftTable", [
        { label: "Match", value: r => esc(r.match || "-") },
        { label: "Sport", value: r => esc((r.sport || "-") + "/" + (r.league || "-")) },
        { label: "Market/Pick", value: r => esc((r.market || "-") + " / " + (r.selection || "-")) + "<br><small>entry " + esc(r.entry_odds || "-") + "</small>" },
        { label: "Kickoff", value: r => liveTime(r.scheduled_kickoff) },
        { label: "Window", value: r => liveTime(r.closing_window_start) + "<br><small>" + liveTime(r.closing_window_end) + "</small>" },
        { label: "State", value: r => stateBadge(r.state) + "<br><small>safe_to_post=" + esc(String(Boolean(r.safe_to_post_now))) + "</small>" },
        { label: "Delta", value: r => r.minutes_from_valid_window === null || r.minutes_from_valid_window === undefined ? "-" : esc(r.minutes_from_valid_window + " min") },
        { label: "Why", value: r => esc(r.closing_why_invalid || "-") },
        { label: "Source", value: r => esc(r.source_name_suggested || "-") + "<br><small>" + esc(r.bookmaker_suggested || "-") + "</small>" },
        { label: "Endpoint", value: r => esc(r.manual_verified_endpoint || "-") },
        { label: "Action", value: r => esc(r.action || "-") },
        { label: "Payload Draft", value: payloadPreview }
      ], rows.length ? rows.slice(0, 40) : [{
        match: "Sin drafts disponibles",
        sport: data.sport || "all",
        league: "-",
        market: "-",
        selection: "-",
        entry_odds: "-",
        scheduled_kickoff: null,
        closing_window_start: null,
        closing_window_end: null,
        state: "WAITING_WINDOW",
        safe_to_post_now: false,
        source_name_suggested: "-",
        bookmaker_suggested: "-",
        manual_verified_endpoint: "-",
        action: data.recommendation || "Esperar ticket con ventana de closing.",
        payload_draft_json: "-"
      }]);
    }
    function renderSourceCaptureAssistant(data) {
      data = data || {};
      const rows = data.rows || [];
      const stateBadge = value => {
        const normalized = String(value || "").toUpperCase();
        const cls = normalized === "SAFE_TO_POST_MANUAL_VERIFIED" || normalized === "EVIDENCE_CAPTURED"
          ? "value"
          : (normalized === "REJECTED_UNSAFE_SOURCE" || normalized === "MISSED_WINDOW" ? "loss" : "warn");
        return "<span class='" + cls + "'>" + esc(value || "-") + "</span>";
      };
      const payloadPreview = r => {
        const payload = String(r.payload_draft_json || "-");
        return "<pre style='white-space:pre-wrap;max-width:560px;max-height:220px;overflow:auto;margin:0;font-size:11px;'>" + esc(payload) + "</pre>";
      };
      $("sourceCaptureAssistantRecommendation").textContent = data.recommendation || "Asistente de captura listo. Genera evidencia/drafts; no autopost, no picks.";
      $("scaDrafts").textContent = String(data.draft_ready || 0);
      $("scaEvidence").textContent = String(data.evidence_captured || 0);
      $("scaSafe").textContent = String(data.safe_to_post_now || 0);
      $("scaRejected").textContent = String(data.rejected_unsafe_source || 0);
      renderTable("sourceCaptureAssistantTable", [
        { label: "Match", value: r => esc(r.match || "-") },
        { label: "Capture", value: r => esc((r.capture_type || "-") + " / " + (r.source_name || "-")) },
        { label: "Window", value: r => esc(r.window_status || "-") + "<br><small>" + liveTime(r.scheduled_kickoff) + "</small>" },
        { label: "Evidence", value: r => stateBadge(r.evidence_status || r.state) + "<br><small>" + esc(r.screenshot_path || "sin screenshot") + "</small>" },
        { label: "Safe To Post", value: r => r.safe_to_post_now ? "<span class='value'>YES</span>" : "<span class='badge'>NO</span>" },
        { label: "Status", value: r => stateBadge(r.state) },
        { label: "Next Action", value: r => esc(r.next_action || "-") },
        { label: "Safety", value: r => (r.safety_reasons || []).length ? (r.safety_reasons || []).map(esc).join(", ") : "<span class='value'>OK</span>" },
        { label: "Endpoint", value: r => esc(r.manual_verified_endpoint || "POST /api/trading/source-capture-assistant/evidence") },
        { label: "Draft JSON", value: payloadPreview }
      ], rows.length ? rows.slice(0, 60) : [{
        match: "Sin drafts de captura",
        capture_type: "-",
        source_name: "-",
        window_status: "-",
        evidence_status: "DRAFT_READY",
        state: "DRAFT_READY",
        safe_to_post_now: false,
        next_action: data.recommendation || "Esperar slate/ticket o abrir fuente permitida.",
        safety_reasons: [],
        payload_draft_json: "-"
      }]);
    }
    function renderOddsSnapshotCache(data) {
      data = data || {};
      const rows = data.rows || [];
      $("oddsSnapshotCacheRecommendation").textContent = data.recommendation || "Cache de cuotas listo. No crea picks, no reemplaza closing y no alimenta CLV por si solo.";
      $("oscScanned").textContent = String(data.scanned || rows.length || 0);
      $("oscFresh").textContent = String(data.fresh || 0);
      $("oscStale").textContent = String(data.stale || 0);
      $("oscEntry").textContent = String(data.safe_for_entry || 0);
      $("oscClosing").textContent = String(data.safe_for_closing || 0);
      $("oscAudit").textContent = String(data.audit_only || 0);
      const staleBadge = value => {
        const status = String(value || "-");
        if (status === "FRESH") return "<span class='value'>FRESH</span>";
        if (status.startsWith("STALE")) return "<span class='warn'>" + esc(status) + "</span>";
        return "<span class='badge'>" + esc(status) + "</span>";
      };
      const yesNo = value => value ? "<span class='value'>YES</span>" : "<span class='badge'>NO</span>";
      renderTable("oddsSnapshotCacheTable", [
        { label: "Captured", value: r => liveTime(r.captured_at) },
        { label: "Match", value: r => esc(r.match || r.match_id || "-") + "<br><small>" + esc((r.sport || "-") + " / " + (r.league || "-")) + "</small>" },
        { label: "Market", value: r => esc((r.market || "-") + " / " + (r.selection || "-")) + "<br><small>" + (r.line === null || r.line === undefined ? "" : "line " + esc(r.line)) + "</small>" },
        { label: "Odds", value: r => fmtOdds(r.odds) },
        { label: "Book", value: r => esc(r.bookmaker || "-") + "<br><small>" + esc(r.source_name || "-") + "</small>" },
        { label: "Type", value: r => esc(r.snapshot_type || "-") },
        { label: "Stale", value: r => staleBadge(r.stale_status) + "<br><small>exp " + liveTime(r.expires_at) + "</small>" },
        { label: "Entry", value: r => yesNo(r.safe_for_entry) },
        { label: "Closing", value: r => yesNo(r.safe_for_closing) + "<br><small>" + esc(r.closing_quality || "-") + "</small>" },
        { label: "Audit", value: r => r.audit_only ? "<span class='warn'>audit_only</span>" : "<span class='value'>usable</span>" },
        { label: "Evidence", value: r => esc(r.evidence_id || "-") + "<br><small>" + esc(r.screenshot_sha256 || "sin hash") + "</small>" },
        { label: "Verified", value: r => esc(r.verified_by || "-") }
      ], rows.length ? rows.slice(0, 80) : [{
        captured_at: null,
        match: "Sin cuotas cacheadas hoy",
        sport: data.sport || "all",
        league: "-",
        market: "-",
        selection: "-",
        odds: null,
        bookmaker: "-",
        source_name: "-",
        snapshot_type: "-",
        stale_status: "-",
        expires_at: null,
        safe_for_entry: false,
        safe_for_closing: false,
        audit_only: true,
        evidence_id: null,
        screenshot_sha256: null,
        verified_by: "-"
      }]);
    }
    function renderCleanChainProgress(cleanQueue, oddsCache, realPaper) {
      cleanQueue = cleanQueue || {};
      oddsCache = oddsCache || {};
      realPaper = realPaper || {};
      const rows = cleanQueue.rows || [];
      const snapshots = oddsCache.rows || [];
      const summary = cleanQueue.summary || {};
      const targets = cleanQueue.sample_targets || {};
      const realSummary = realPaper.summary || {};
      const hasEvidence = row => Boolean(
        row && row.evidence_id && (row.screenshot_sha256 || row.raw_payload_hash)
      );
      const validEntries = snapshots.filter(row =>
        ["entry", "current"].includes(String(row.snapshot_type || "").toLowerCase())
        && row.safe_for_entry === true
        && row.audit_only !== true
        && row.stale_status === "FRESH"
        && hasEvidence(row)
      ).length;
      const validClosings = snapshots.filter(row =>
        String(row.snapshot_type || "").toLowerCase() === "closing"
        && row.safe_for_closing === true
        && row.audit_only !== true
        && row.closing_quality === "CAPTURED_ON_TIME"
        && hasEvidence(row)
      ).length;
      const settlementsClean = rows.filter(row => row.clean_v2_eligible === true && row.settlement_final === true).length;
      const clvValid = rows.filter(row => row.clean_v2_eligible === true && row.clv_valid === true).length;
      const focus = (cleanQueue.focus_rows || [])[0] || rows.find(row => row.action !== "POST_KICKOFF_AUDIT_ONLY") || null;
      const nextAction = focus
        ? String(focus.action || "WAITING_CLEAN_CHAIN") + ": " + String(focus.next_step || "Completar el siguiente eslabon verificable.")
        : "PREPARE_NEXT_SLATE: cargar fixtures y fair odds temprano; despues capturar entry verificable.";

      $("ccpValidEntries").textContent = String(validEntries);
      $("ccpMissingEntryEvidence").textContent = String(summary.entry_missing || 0);
      $("ccpValidClosings").textContent = String(validClosings);
      $("ccpSettlementsClean").textContent = String(settlementsClean);
      $("ccpClvValid").textContent = String(clvValid);
      $("ccpMlbProgress").textContent = String(targets.mlb_clean_closed || 0) + "/" + String(targets.mlb_target_min || 150);
      $("ccpFootballProgress").textContent = String(targets.football_clean_closed || 0) + "/" + String(targets.football_target_min || 50);
      $("ccpLegacyExcluded").textContent = String(realSummary.canonical_legacy_closed ?? realSummary.legacy_only_closed ?? targets.mlb_legacy_closed ?? 0);
      $("ccpDuplicateExcluded").textContent = String(realSummary.duplicate_excluded || 0);
      $("cleanChainNextAction").textContent = "Siguiente accion: " + nextAction;
      $("cleanChainProgressRecommendation").textContent = validEntries === 0
        ? "La cadena esta limpia pero aun no inicia hoy: primero entry/current fresca con evidence_id y screenshot_sha256."
        : validClosings === 0
          ? "Entry valida presente. El siguiente salto es un closing CAPTURED_ON_TIME dentro de la ventana 10-3 min."
          : settlementsClean === 0
            ? "Entry y closing validos presentes. Esperar resultado final verificado antes de settlement."
            : clvValid === 0
              ? "Settlement limpio presente. Falta validar CLV para completar clean v2."
              : "Cadena limpia completada hoy. Mantener shadow y acumular muestra sin relajar guardrails.";
    }
    function renderCleanSampleQueue(data) {
      data = data || {};
      const summary = data.summary || {};
      const targets = data.sample_targets || {};
      const rows = data.focus_rows || data.rows || [];
      const allRows = data.rows || rows;
      const scanned = Number(summary.scanned || allRows.length || 0);
      const fairReady = allRows.filter(row => Boolean(row.model_quote_id)).length;
      const fairProgress = "Avance: fair odds " + fairReady + "/" + scanned + " cargadas; entry verificable pendiente en " + String(summary.entry_missing || 0) + ".";
      $("cleanSampleQueueRecommendation").textContent = fairProgress + " " + (data.recommendation || "Rutina limpia lista. No crea picks ni ejecuta acciones.");
      $("csqFocus").textContent = String(summary.focus_count || (data.focus_rows || []).length || 0);
      $("csqFootballSample").textContent = String(targets.football_clean_closed || 0) + "/" + String(targets.football_target_min || 50);
      $("csqMlbSample").textContent = String(targets.mlb_clean_closed || 0) + "/" + String(targets.mlb_target_min || 150);
      $("csqMlbLegacy").textContent = String(targets.mlb_legacy_closed || 0);
      $("csqClosingNow").textContent = String(summary.capture_closing_now || 0);
      $("csqNearStart").textContent = String(summary.near_start_now || 0);
      $("csqEntryMissing").textContent = String(summary.entry_missing || 0);
      $("csqFairReady").textContent = String(fairReady) + "/" + String(scanned);
      $("csqFairMissing").textContent = String(summary.fair_odds_missing || 0);
      $("csqFixtureTime").textContent = String(summary.fixture_time_unverified || 0);
      $("csqPostKickoff").textContent = String(summary.post_kickoff_audit_only || 0);
      const actionBadge = value => {
        const status = String(value || "-").toUpperCase();
        if (status === "CAPTURE_CLOSING_NOW" || status === "RUN_NEAR_START_NOW" || status === "READY_FOR_SETTLEMENT") return "<span class='value'>" + esc(status) + "</span>";
        if (status === "CAPTURE_ENTRY_CURRENT_ODDS" || status === "RUN_BRIDGE_REGISTER_SHADOW" || status === "WAITING_VALID_CLOSING" || status === "CAPTURE_LINEUP_GOALKEEPER_NOW" || status === "FIXTURE_TIME_UNVERIFIED") return "<span class='warn'>" + esc(status) + "</span>";
        if (status === "POST_KICKOFF_AUDIT_ONLY") return "<span class='loss'>" + esc(status) + "</span>";
        return "<span class='badge'>" + esc(status) + "</span>";
      };
      const safeEntry = r => r.entry_snapshot_safe_for_entry
        ? "<span class='value'>safe</span><br><small>" + fmtOdds(r.entry_snapshot_odds) + "</small>"
        : (r.market_quote_id ? "<span class='warn'>market only</span>" : "<span class='warn'>missing</span>");
      const safeClosing = r => r.closing_snapshot_safe_for_closing
        ? "<span class='value'>safe</span><br><small>" + fmtOdds(r.closing_snapshot_odds) + "</small>"
        : "<span class='warn'>" + esc(r.closing_quality || "missing") + "</span>";
      renderTable("cleanSampleQueueTable", [
        { label: "Action", value: r => actionBadge(r.action) + "<br><small>score " + esc(r.focus_score ?? "-") + "</small>" },
        { label: "Match", value: r => esc(r.match || r.match_id || "-") + "<br><small>" + esc((r.sport || "-") + " / " + (r.league || "-")) + "</small>" },
        { label: "Kickoff", value: r => liveTime(r.kickoff) + "<br><small>" + esc(r.minutes_until_start === null || r.minutes_until_start === undefined ? "-" : r.minutes_until_start + " min") + "</small>" },
        { label: "Model", value: r => r.model_quote_id ? "<span class='value'>yes</span><br><small>" + esc(r.model_name || "-") + "</small>" : "<span class='warn'>missing</span>" },
        { label: "Entry", value: safeEntry },
        { label: "Ticket", value: r => r.ticket_id ? "<span class='value'>registered</span><br><small>" + esc((r.ticket_market || "-") + " / " + (r.ticket_selection || "-")) + "</small>" : "<span class='badge'>no ticket</span>" },
        { label: "Closing", value: safeClosing },
        { label: "Evidence", value: r => esc(r.entry_evidence_id || "-") + "<br><small>closing " + esc(r.closing_evidence_id || "-") + "</small>" },
        { label: "Next Step", value: r => esc(r.next_step || "-") }
      ], rows.length ? rows.slice(0, 8) : [{
        action: "NO_FOCUS_MATCH",
        focus_score: 0,
        match: "Sin foco pregame disponible",
        sport: data.sport || "all",
        league: "-",
        kickoff: null,
        minutes_until_start: null,
        model_quote_id: null,
        market_quote_id: null,
        entry_snapshot_safe_for_entry: false,
        ticket_id: null,
        closing_snapshot_safe_for_closing: false,
        closing_quality: "missing",
        entry_evidence_id: null,
        closing_evidence_id: null,
        next_step: data.recommendation || "Preparar siguiente slate temprano."
      }]);
    }
    function renderShadowTicketChain(data) {
      data = data || {};
      const rows = data.rows || [];
      $("shadowTicketChainRecommendation").textContent = data.recommendation || "Cadena por ticket lista. Solo lectura; no crea picks ni settlement.";
      $("stcScanned").textContent = String(data.scanned || rows.length || 0);
      $("stcWaitingClosing").textContent = String(data.waiting_valid_closing || 0);
      $("stcReadySettlement").textContent = String(data.ready_for_settlement || 0);
      $("stcWaitingResult").textContent = String(data.waiting_result || 0);
      $("stcClosingReview").textContent = String(data.closing_quality_review || 0);
      $("stcSettled").textContent = String(data.settled_audit || 0);
      const decisionBadge = value => {
        const status = String(value || "-").toUpperCase();
        if (status === "READY_FOR_SETTLEMENT" || status === "SETTLED_AUDIT") return "<span class='value'>" + esc(status) + "</span>";
        if (status === "CLOSING_QUALITY_REVIEW" || status === "ENTRY_AUDIT_ONLY") return "<span class='warn'>" + esc(status) + "</span>";
        if (status === "MISSING_ENTRY_OR_CLOSING") return "<span class='loss'>" + esc(status) + "</span>";
        return "<span class='badge'>" + esc(status) + "</span>";
      };
      const evidenceText = (id, hash) => esc(id || "-") + "<br><small>" + esc(hash || "sin hash") + "</small>";
      renderTable("shadowTicketChainTable", [
        { label: "Decision", value: r => decisionBadge(r.chain_decision) + "<br><small>" + esc(r.ticket_status || "-") + "</small>" },
        { label: "Match", value: r => esc(r.match || r.match_id || "-") + "<br><small>" + esc((r.sport || "-") + " / " + (r.league || "-")) + "</small>" },
        { label: "Market/Pick", value: r => esc((r.market || "-") + " / " + (r.selection || "-")) + "<br><small>ticket " + esc(r.ticket_id || "-") + "</small>" },
        { label: "Ticket EV", value: r => fmtOdds(r.ticket_entry_odds) + "<br><small>EV " + fmtPct(r.expected_value || 0) + "</small>" },
        { label: "Entry Snapshot", value: r => fmtOdds(r.entry_snapshot_odds) + "<br><small>" + esc(r.entry_snapshot_type || "-") + " | safe=" + esc(String(Boolean(r.entry_snapshot_safe_for_entry))) + "</small>" },
        { label: "Entry Evidence", value: r => evidenceText(r.entry_evidence_id, r.entry_screenshot_sha256) },
        { label: "Closing Snapshot", value: r => fmtOdds(r.closing_snapshot_odds) + "<br><small>" + esc(r.closing_quality || r.closing_window_status || "-") + " | safe=" + esc(String(Boolean(r.closing_snapshot_safe_for_closing))) + "</small>" },
        { label: "Closing Evidence", value: r => evidenceText(r.closing_evidence_id, r.closing_screenshot_sha256) },
        { label: "CLV", value: r => r.clv === null || r.clv === undefined ? "<span class='warn'>sin CLV valido</span>" : fmtPct(r.clv) + "<br><small>" + esc(r.clv_band || "-") + "</small>" },
        { label: "Settlement", value: r => esc(r.match_status || "-") + "<br><small>profit " + esc(r.net_profit ?? 0) + "u</small>" },
        { label: "Next Action", value: r => esc(r.next_action || "-") }
      ], rows.length ? rows.slice(0, 80) : [{
        chain_decision: "MISSING_ENTRY_OR_CLOSING",
        ticket_status: "-",
        match: "Sin tickets auditables en la fecha",
        sport: data.sport || "all",
        league: "-",
        market: "-",
        selection: "-",
        ticket_id: "-",
        ticket_entry_odds: null,
        expected_value: null,
        entry_snapshot_odds: null,
        entry_snapshot_type: "-",
        entry_snapshot_safe_for_entry: false,
        entry_evidence_id: null,
        entry_screenshot_sha256: null,
        closing_snapshot_odds: null,
        closing_quality: "-",
        closing_snapshot_safe_for_closing: false,
        closing_evidence_id: null,
        closing_screenshot_sha256: null,
        clv: null,
        clv_band: null,
        match_status: "-",
        net_profit: 0,
        next_action: data.recommendation || "Esperar tickets shadow/paper con snapshots."
      }]);
    }
    function windowTextForAction(row) {
      if (!row || !row.kickoff) return "-";
      const kickoff = new Date(row.kickoff);
      if (Number.isNaN(kickoff.getTime())) return "-";
      const localTime = value => value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const minutes = Number(row.minutes_until_start);
      const status = String(row.status || row.action || "").toUpperCase();
      if (status === "CAPTURE_CLOSING_NOW" || status === "WAITING_WINDOW") {
        return localTime(new Date(kickoff.getTime() - 10 * 60000)) + " - " + localTime(new Date(kickoff.getTime() - 3 * 60000));
      }
      if (status === "RUN_NEAR_START_NOW" && String(row.sport || "").toLowerCase() === "baseball") {
        return minutes >= 45 ? "90-60 min / 45-20 min" : "45-20 min";
      }
      if (status === "RUN_NEAR_START_NOW") return "60-15 min";
      return esc(row.window || "-");
    }
    function headlineForOperationalStatus(status) {
      const normalized = String(status || "").toUpperCase();
      if (normalized === "CAPTURE_CLOSING_NOW") return "Capturar closing ahora";
      if (normalized === "RUN_NEAR_START_NOW") return "Correr near-start ahora";
      if (normalized === "READY_FOR_SETTLEMENT") return "Listo para settlement verificado";
      if (normalized === "WAITING_RESULT") return "Esperar resultado final";
      if (normalized === "MISSED_WINDOW") return "Ventana perdida";
      if (normalized === "POST_KICKOFF_AUDIT_ONLY") return "Solo auditoria post-kickoff";
      return "Esperar próxima ventana";
    }
    function renderNextOperationalAction(data) {
      data = data || {};
      const rows = data.rows || [];
      const immediate = rows.find(r => ["CAPTURE_CLOSING_NOW", "RUN_NEAR_START_NOW", "READY_FOR_SETTLEMENT"].includes(String(r.status || r.action || "").toUpperCase()));
      const waiting = rows.find(r => String(r.status || r.action || "").toUpperCase() === "WAITING_WINDOW" && Number(r.minutes_until_start) > 0);
      const row = immediate || waiting || rows[0] || null;
      const status = String(row?.status || row?.action || "WAITING_WINDOW").toUpperCase();
      const header = $("nextOperationalAction");
      const state = status === "CAPTURE_CLOSING_NOW" || status === "READY_FOR_SETTLEMENT"
        ? "near"
        : (status === "RUN_NEAR_START_NOW" || status === "WAITING_RESULT" ? "review" : "no-bet");
      if (header) header.className = "executive-decision state-" + state;
      const badgeClass = state === "near" ? "near" : (state === "review" ? "review" : "no-bet");
      $("noaBadge").className = "exec-badge " + badgeClass;
      $("noaBadge").textContent = status;
      $("noaHeadline").textContent = headlineForOperationalStatus(status);
      $("noaSummary").textContent = row
        ? (row.match || "Sin partido") + " | " + (row.sport || "-") + " | " + (row.next_step || data.recommendation || "Esperar.")
        : (data.recommendation || "No hay acciones operativas.");
      $("noaAction").textContent = status === "WAITING_WINDOW" ? "ESPERAR" : (status === "MISSED_WINDOW" || status === "POST_KICKOFF_AUDIT_ONLY" ? "NO RESCATAR" : "ACTUAR");
      $("noaCommand").textContent = row?.command || "No ejecutar comando todavía.";
      $("noaMatch").textContent = row?.match || "-";
      $("noaWindow").textContent = windowTextForAction(row);
      $("noaTimeLeft").textContent = row && row.minutes_until_start !== null && row.minutes_until_start !== undefined
        ? String(row.minutes_until_start) + " min"
        : "-";
      $("noaRisk").textContent = row?.risk || "-";
      $("noaNextStep").innerHTML = [
        "Regla: si no dice CAPTURE_CLOSING_NOW, no captures closing.",
        row?.blocked_by_external_source ? "Bloqueo: requiere fuente externa o manual_verified confiable." : "Fuente: sin bloqueo externo dominante para la acción principal.",
        row?.missing?.length ? "Faltante principal: " + row.missing.slice(0, 4).join(", ") + "." : "Faltantes: ninguno crítico visible en esta acción."
      ].map(item => "<div class='exec-reason'>" + esc(item) + "</div>").join("");
    }
    function renderOperationalWindowQueue(data) {
      data = data || {};
      const rows = data.rows || [];
      const summary = data.summary || {};
      const statusBadge = value => {
        const normalized = String(value || "").toUpperCase();
        const cls = normalized === "CAPTURE_CLOSING_NOW" || normalized === "READY_FOR_SETTLEMENT"
          ? "value"
          : (normalized === "RUN_NEAR_START_NOW" || normalized === "WAITING_RESULT" ? "warn" : (normalized.includes("MISSED") || normalized.includes("POST_KICKOFF") ? "loss" : "badge"));
        return "<span class='" + cls + "'>" + esc(value || "-") + "</span>";
      };
      const riskBadge = value => {
        const normalized = String(value || "").toUpperCase();
        const cls = normalized === "HIGH" ? "loss" : (normalized === "MEDIUM" ? "warn" : "value");
        return "<span class='" + cls + "'>" + esc(value || "-") + "</span>";
      };
      $("operationalWindowQueueRecommendation").textContent = data.recommendation || "Cola operativa cargada. No ejecuta scripts ni cambia datos.";
      $("owqNearStart").textContent = String(summary.run_near_start_now || 0);
      $("owqClosingNow").textContent = String(summary.capture_closing_now || 0);
      $("owqWaiting").textContent = String(summary.waiting_window || 0);
      $("owqMissed").textContent = String(summary.missed_window || 0);
      $("owqReadySettlement").textContent = String(summary.ready_for_settlement || 0);
      $("owqManual").textContent = String(summary.manual_verified_available || 0);
      $("owqExternal").textContent = String(summary.external_source_blocked || 0);
      renderTable("operationalWindowQueueTable", [
        { label: "Hora", value: r => liveTime(r.kickoff) + "<br><small>" + esc(r.minutes_until_start === null || r.minutes_until_start === undefined ? "-" : r.minutes_until_start + " min") + "</small>" },
        { label: "Match", value: r => esc(r.match || "-") },
        { label: "Sport", value: r => esc((r.sport || "-") + "/" + (r.league || "-")) },
        { label: "Window", value: r => esc(r.window || "-") },
        { label: "Action", value: r => statusBadge(r.action || r.status) },
        { label: "Command", value: r => esc(r.command || "-") },
        { label: "Missing", value: r => (r.missing || []).slice(0, 6).map(esc).join(", ") || "-" },
        { label: "Status", value: r => statusBadge(r.status) + "<br><small>" + esc(r.preflight_status || "-") + "</small>" },
        { label: "Risk", value: r => riskBadge(r.risk) },
        { label: "Next Step", value: r => esc(r.next_step || "-") }
      ], rows.length ? rows.slice(0, 100) : [{
        kickoff: null,
        minutes_until_start: null,
        match: "Sin acciones operativas",
        sport: data.sport || "all",
        league: "-",
        window: "-",
        action: "WAITING_WINDOW",
        command: "No ejecutar comando.",
        missing: [],
        status: "WAITING_WINDOW",
        risk: "LOW",
        preflight_status: "-",
        next_step: data.recommendation || "Esperar siguiente slate o ventana valida."
      }]);
    }
    function renderOperationalAlerts(data) {
      data = data || {};
      const rows = data.rows || [];
      const summary = data.summary || {};
      const severityBadge = value => {
        const normalized = String(value || "").toUpperCase();
        const cls = normalized === "NOW" ? "value" : (normalized === "WATCH" ? "warn" : (normalized === "MISSED" ? "loss" : "badge"));
        return "<span class='" + cls + "'>" + esc(value || "-") + "</span>";
      };
      const safeBadge = value => value ? "<span class='value'>YES</span>" : "<span class='badge'>NO</span>";
      $("operationalAlertsRecommendation").textContent = data.recommendation || "Alertas operativas cargadas. No crea picks ni cambia datos.";
      $("opaNow").textContent = String(summary.now_alerts || 0);
      $("opaClosingNow").textContent = String(summary.capture_closing_now || 0);
      $("opaPrepare").textContent = String((summary.prepare_source || 0) + (summary.open_dashboard_source || 0) + (summary.prepare_screenshot || 0));
      $("opaSafeToPost").textContent = String(summary.safe_to_post_now || 0);
      $("opaMissed").textContent = String(summary.missed_alerts || summary.missed_window || 0);
      $("opaTelegram").textContent = data.telegram?.mode || "OFF";
      renderTable("operationalAlertsTable", [
        { label: "Alert Time", value: r => liveTime(r.alert_time) + "<br><small>" + esc(r.minutes_until_alert === null || r.minutes_until_alert === undefined ? "-" : r.minutes_until_alert + " min") + "</small>" },
        { label: "Match", value: r => esc(r.match || "-") },
        { label: "Sport", value: r => esc(r.sport || "-") },
        { label: "Kickoff", value: r => liveTime(r.kickoff) + "<br><small>" + esc(r.minutes_until_kickoff === null || r.minutes_until_kickoff === undefined ? "-" : r.minutes_until_kickoff + " min") + "</small>" },
        { label: "Alert", value: r => "<span class='badge'>" + esc(r.alert_type || "-") + "</span>" },
        { label: "Window", value: r => esc(r.window_status || "-") },
        { label: "Action", value: r => esc(r.action || "-") },
        { label: "Severity", value: r => severityBadge(r.severity) },
        { label: "Source Needed", value: r => esc(r.source_needed || "-") },
        { label: "Safe To Post", value: r => safeBadge(r.safe_to_post_now) },
        { label: "No Real Money", value: r => r.no_real_money ? "<span class='value'>TRUE</span>" : "<span class='loss'>FALSE</span>" }
      ], rows.length ? rows.slice(0, 100) : [{
        alert_time: null,
        minutes_until_alert: null,
        match: "Sin alertas operativas",
        sport: data.sport || "all",
        kickoff: null,
        minutes_until_kickoff: null,
        alert_type: "WAITING_WINDOW",
        window_status: "WAITING_WINDOW",
        action: data.recommendation || "Esperar siguiente ventana.",
        severity: "INFO",
        source_needed: "dashboard_review",
        safe_to_post_now: false,
        no_real_money: true
      }]);
    }
    function renderSourceCaptureQueue(data) {
      data = data || {};
      const rows = (data.rows || []).filter(r => r.data_status !== "READY");
      const suggestedSources = r => {
        const sport = String(r.sport || "").toLowerCase();
        const missingField = String(r.missing_field || "").toLowerCase();
        const sourceNeeded = String(r.source_needed || "").toLowerCase();
        const isMarketField = missingField.includes("closing_odds")
          || missingField.includes("current_odds")
          || missingField.includes("odds_model_ev")
          || sourceNeeded.includes("bookmaker")
          || sourceNeeded.includes("market odds")
          || sourceNeeded.includes("verified market");
        if (isMarketField) return sport === "baseball"
          ? "sportsbook_manual_verified / sportsdataio / bookmaker_verified"
          : "sportsbook_manual_verified / bookmaker_verified";
        if (sport === "baseball" && (missingField.includes("result") || missingField.includes("match_status") || sourceNeeded.includes("final score") || sourceNeeded.includes("boxscore"))) return "mlb_official_manual_verified / mlb_stats_manual_verified";
        if (sport === "baseball" && (missingField.includes("pitcher") || missingField.includes("lineup") || missingField.includes("batting_order"))) return "mlb_stats_manual_verified / mlb_official_manual_verified";
        if (sourceNeeded.includes("result") || missingField.includes("result") || missingField.includes("match_status")) return "official_league_manual_verified / google_result_manual_verified / espn_manual_verified";
        if (missingField.includes("goalkeeper") || missingField.includes("lineup") || sourceNeeded.includes("official lineup")) return "365scores_manual_verified / flashscore_manual_verified / official_club_manual_verified / official_league_manual_verified / espn_manual_verified";
        if (sourceNeeded.includes("weather") || missingField.includes("weather")) return "manual_verified weather / weather provider";
        if (sourceNeeded.includes("official")) return "official_club_manual_verified / official_league_manual_verified / espn_manual_verified";
        return r.can_be_manual_verified ? "365scores_manual_verified / flashscore_manual_verified" : "-";
      };
      const captureEndpoint = r => r.can_be_manual_verified ? "POST /api/trading/source-capture/manual-verified" : "-";
      const payloadHint = r => r.can_be_manual_verified
        ? "{ match_id, sport, source_name, source_url, capture_type, captured_at, verified_by, confidence_score, data }"
        : "Automated/provider path required.";
      $("sourceCaptureQueueRecommendation").textContent = rows.length
        ? "Cola ordenada por bloqueo: captura solo fuentes verificadas; no inventar datos."
        : "No hay fuentes pendientes en la cola.";
      renderTable("sourceCaptureQueueTable", [
        { label: "Match", value: r => esc((r.matches_affected || []).slice(0, 2).join(" | ") || "-") },
        { label: "Sport", value: r => esc(r.sport || "-") },
        { label: "Missing Field", value: r => esc(r.missing_field || "-") },
        { label: "Source Needed", value: r => esc(r.source_needed || "-") },
        { label: "Suggested Source", value: r => esc(suggestedSources(r)) },
        { label: "Can Manual Verify", value: r => r.can_be_manual_verified ? "<span class='value'>YES</span>" : "<span class='badge'>NO</span>" },
        { label: "Endpoint", value: r => esc(captureEndpoint(r)) },
        { label: "Payload Hint", value: r => esc(payloadHint(r)) },
        { label: "Resolver Module", value: r => esc(r.resolver_module || "-") },
        { label: "Next Window", value: r => esc(r.next_run_window || "-") },
        { label: "Action", value: r => esc(r.recommended_action || "-") }
      ], rows.length ? rows.slice(0, 80) : [{
        matches_affected: [],
        sport: data.sport || "all",
        missing_field: "none",
        source_needed: "-",
        can_be_manual_verified: false,
        resolver_module: "-",
        next_run_window: "-",
        recommended_action: "Sin captura pendiente."
      }]);
    }
    function renderManualVerifiedSourceCaptures(data) {
      data = data || {};
      const rows = data.rows || [];
      const statusBadge = value => {
        const normalized = String(value || "").toUpperCase();
        const cls = normalized === "ACCEPTED" || normalized === "CAPTURED_ON_TIME"
          ? "value"
          : (normalized.includes("LATE") || normalized.includes("EARLY") ? "warn" : "badge");
        return "<span class='" + cls + "'>" + esc(value || "-") + "</span>";
      };
      $("manualVerifiedSourceCapturesRecommendation").textContent = data.recommendation || "Capturas manual_verified cargadas. No crean picks ni activan dinero real.";
      $("mvscScanned").textContent = String(data.scanned || 0);
      $("mvscAccepted").textContent = String(data.accepted || 0);
      $("mvscPartial").textContent = String(data.partial_accepted || 0);
      $("mvscAuditOnly").textContent = String(data.stored_for_audit_only || 0);
      $("mvscOnTime").textContent = String(data.captured_on_time || 0);
      $("mvscBadClosing").textContent = String((data.captured_too_early || 0) + (data.captured_late || 0));
      renderTable("manualVerifiedSourceCapturesTable", [
        { label: "Match", value: r => esc(r.match || "-") },
        { label: "Sport", value: r => esc((r.sport || "-") + "/" + (r.league || "-")) },
        { label: "Source", value: r => esc(r.source || "-") },
        { label: "Capture Type", value: r => esc(r.capture_type || "-") },
        { label: "Captured At", value: r => liveTime(r.captured_at) },
        { label: "Verified By", value: r => esc(r.verified_by || "-") },
        { label: "Confidence", value: r => esc(r.confidence ?? "-") },
        { label: "Data Status", value: r => statusBadge(r.data_status) },
        { label: "Used By Preflight", value: r => r.used_by_preflight ? "<span class='value'>YES</span>" : "<span class='badge'>NO</span>" },
        { label: "Missing Resolved", value: r => (r.missing_resolved || []).slice(0, 6).map(esc).join(", ") || "-" },
        { label: "Closing Quality", value: r => statusBadge(r.closing_quality || "-") },
        { label: "Window", value: r => liveTime(r.closing_window_start) + "<br><small>" + liveTime(r.closing_window_end) + "</small>" },
        { label: "Delta", value: r => r.minutes_from_valid_window === null || r.minutes_from_valid_window === undefined ? "-" : esc(r.minutes_from_valid_window + " min") },
        { label: "Why Invalid", value: r => esc(r.closing_why_invalid || "-") },
        { label: "Notes", value: r => esc(r.notes || "-") }
      ], rows.length ? rows.slice(0, 120) : [{
        match: "Sin capturas manual_verified",
        sport: data.sport || "all",
        league: "-",
        source: "-",
        capture_type: "-",
        captured_at: null,
        verified_by: "-",
        confidence: "-",
        data_status: "WAITING",
        used_by_preflight: false,
        missing_resolved: [],
        closing_quality: "-",
        notes: data.recommendation || "Cargar datos solo con fuente visible y verificada."
      }]);
    }
    function renderMatchPreflightQueue(data) {
      data = data || {};
      const rows = data.rows || [];
      const statusBadge = status => {
        const normalized = String(status || "").toUpperCase();
        const cls = normalized.includes("SETTLEMENT") || normalized.includes("SHADOW_SETTLED") || normalized.includes("CONFIRMED")
          ? "value"
          : (normalized.includes("NO_BET") || normalized.includes("POST_KICKOFF") ? "loss" : "warn");
        return "<span class='" + cls + "'>" + esc(status || "-") + "</span>";
      };
      const readyBadge = ready => ready ? "<span class='value'>OK</span>" : "<span class='warn'>Falta</span>";
      $("matchPreflightQueueRecommendation").textContent = data.recommendation || "Preflight cargado. No crea picks ni altera dinero real.";
      $("mpfScanned").textContent = String(data.scanned || rows.length || 0);
      $("mpfFinancial").textContent = String(data.financial_ready || 0);
      $("mpfContextGaps").textContent = String(data.context_gaps_total ?? data.context_gaps ?? 0);
      $("mpfHardContext").textContent = String(data.hard_context_gaps || 0);
      $("mpfSoftContext").textContent = String(data.soft_context_gaps || 0);
      $("mpfSourceMissing").textContent = String(data.source_missing_gaps || 0);
      $("mpfLineupGaps").textContent = String(data.lineup_gaps || 0);
      $("mpfGoalkeeperGaps").textContent = String(data.goalkeeper_gaps || 0);
      $("mpfWaitingClosing").textContent = String(data.waiting_valid_closing || 0);
      $("mpfReadySettlement").textContent = String(data.ready_for_settlement || 0);
      $("mpfPostKickoff").textContent = String(data.post_kickoff_audit_only || 0);
      $("mpfSettled").textContent = String(data.shadow_settled || 0);
      $("mpfConfirmed").textContent = String(data.confirmed_paper || 0);
      $("mpfRealCandidate").textContent = String(data.real_candidate || data.guardrails?.real_candidate_count || 0);
      const mlbRows = rows.filter(r => String(r.sport || "").toLowerCase() === "baseball");
      $("mpfMlbPitcher").textContent = String(mlbRows.filter(r => r.pitcher_ready && r.pitcher_stats_ready).length);
      $("mpfMlbLineup").textContent = String(mlbRows.filter(r => r.lineup_ready && r.batting_order_complete).length);
      $("mpfMlbParkWeather").textContent = String(mlbRows.filter(r => r.park_context_ready && r.weather_context_ready).length);
      renderTable("matchPreflightQueueTable", [
        { label: "Priority", value: r => esc(r.priority ?? "-") },
        { label: "Match", value: r => esc(r.match || "-") },
        { label: "Sport", value: r => esc((r.sport || "-") + "/" + (r.league || "-")) },
        { label: "Kickoff", value: r => liveTime(r.kickoff) },
        { label: "Preflight Status", value: r => statusBadge(r.preflight_status) },
        { label: "Financial", value: r => readyBadge(r.financial_ready) },
        { label: "Context", value: r => readyBadge(r.context_ready) },
        { label: "Pitchers", value: r => String(r.sport || "").toLowerCase() === "baseball" ? (readyBadge(r.pitcher_ready) + "<br><small>" + esc((r.pitcher_away || "?") + " @ " + (r.pitcher_home || "?")) + "</small>") : "-" },
        { label: "P Stats", value: r => String(r.sport || "").toLowerCase() === "baseball" ? readyBadge(r.pitcher_stats_ready) : "-" },
        { label: "Lineups", value: r => {
          if (String(r.sport || "").toLowerCase() === "baseball") return readyBadge(r.home_lineup_ready && r.away_lineup_ready && r.lineup_context_ready);
          return readyBadge(r.lineup_ready && (r.goalkeeper_ready !== false));
        } },
        { label: "Batting Order", value: r => String(r.sport || "").toLowerCase() === "baseball" ? readyBadge(r.batting_order_complete) : "-" },
        { label: "Bullpen", value: r => String(r.sport || "").toLowerCase() === "baseball" ? readyBadge(r.bullpen_context_ready) : "-" },
        { label: "Park/Wx", value: r => String(r.sport || "").toLowerCase() === "baseball" ? (readyBadge(r.park_context_ready) + " / " + readyBadge(r.weather_context_ready)) : "-" },
        { label: "Closing", value: r => r.closing_ready ? "<span class='value'>" + esc(r.closing_quality || "OK") + "</span>" : (r.closing_quality ? "<span class='warn'>" + esc(r.closing_quality) + "</span>" : "<span class='warn'>Falta</span>") },
        { label: "Closing Why", value: r => esc(r.closing_why_invalid || (r.minutes_from_valid_window === null || r.minutes_from_valid_window === undefined ? "-" : r.minutes_from_valid_window + " min fuera")) },
        { label: "Settlement", value: r => r.settlement_ready ? "<span class='value'>READY</span>" : "<span class='badge'>" + esc(r.ticket_status || "-") + "</span>" },
        { label: "Missing", value: r => (r.missing || []).slice(0, 6).map(esc).join(", ") || "-" },
        { label: "Top Source", value: r => {
          const b = (r.bottleneck_details || [])[0] || {};
          return esc(b.source_needed || "-") + "<br><small>" + esc(b.resolver_module || "-") + "</small>";
        } },
        { label: "Data Status", value: r => {
          const b = (r.bottleneck_details || [])[0] || {};
          return b.data_status ? "<span class='warn'>" + esc(b.data_status) + "</span>" : "-";
        } },
        { label: "Next Action", value: r => esc(r.next_action || "REVIEW_ONLY") }
      ], rows.length ? rows.slice(0, 80) : [{
        priority: "-",
        match: "Sin partidos en preflight",
        sport: data.sport || "all",
        preflight_status: "NO_ROWS",
        financial_ready: false,
        context_ready: false,
        lineup_ready: false,
        closing_ready: false,
        ticket_status: "-",
        missing: ["universe"],
        next_action: data.recommendation || "Cargar universo del dia."
      }]);
    }
    function renderCandidatePreflight(data) {
      data = data || {};
      const rows = data.rows || [];
      $("candidatePreflightRecommendation").textContent = rows.length
        ? "Snapshots inmutables al instante de decision."
        : "Sin candidatos evaluados para esta fecha.";
      $("cpfScanned").textContent = String(data.scanned || rows.length || 0);
      $("cpfPassed").textContent = String(data.passed || 0);
      $("cpfFailed").textContent = String(data.failed || 0);
      $("cpfRealCandidate").textContent = String(data.guardrails?.real_candidate_count || 0);
      renderTable("candidatePreflightTable", [
        { label: "Match", value: r => esc((r.home_team || "Home") + " vs " + (r.away_team || "Away")) },
        { label: "Sport", value: r => esc((r.sport || "-") + "/" + (r.league || "-")) },
        { label: "Kickoff", value: r => liveTime(r.kickoff) },
        { label: "Decision as-of", value: r => liveTime(r.decision_as_of) },
        { label: "Verdict", value: r => r.verdict === "PASS" && r.hash_valid ? "<span class='value'>PASS</span>" : "<span class='warn'>FAIL</span>" },
        { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
        { label: "Hash", value: r => r.hash_valid ? "<span class='value'>VALID</span>" : "<span class='loss'>INVALID</span>" },
        { label: "Reasons", value: r => (r.reasons_json || []).map(esc).join(", ") || "-" }
      ], rows);
    }
    function renderFootballOwnedFairOdds(data) {
      data = data || {};
      const rows = data.rows || [];
      const summary = data.summary || {};
      const withMarket = rows.filter(row => row.market_quote_id || row.market_odds).length;
      const stale = Number(summary.stale_market_odds || 0);
      const manualUnverified = Number(summary.manual_odds_unverified || 0);
      const priceTooLow = Number(summary.no_bet_price_too_low || 0);
      const freshOdds = Math.max(0, withMarket - stale - manualUnverified);
      $("fofoCount").textContent = String(data.count || rows.length || 0);
      $("fofoWithMarket").textContent = String(withMarket);
      $("fofoFresh").textContent = String(freshOdds);
      $("fofoStale").textContent = String(stale);
      $("fofoManualUnverified").textContent = String(manualUnverified);
      $("fofoPriceTooLow").textContent = String(priceTooLow);
      $("fofoReady").textContent = String(summary.ready_for_shadow_review || 0);
      $("fofoCalibrating").textContent = String(summary.calibrating || 0);
      $("fofoMissing").textContent = String(summary.market_odds_missing || 0);
      $("fofoAggressiveAudit").textContent = String(summary.aggressive_value_audit || 0);
      $("fofoMarketGap").textContent = String(summary.model_market_gap_high || 0);
      $("footballOwnedFairOddsRecommendation").textContent = (data.recommendation || "Nuestra linea propia esta lista; falta cruzarla contra cuotas reales.") +
        " Filtros activos: date=" + esc(data.date || data.requested_date || "seleccion") + ", sport=soccer, max_model_age=1440m, max_market_age=1440m.";
      renderTable("footballOwnedFairOddsTable", [
        { label: "Estado", value: r => {
          const status = String(r.bridge_status || "-");
          if (status === "READY_FOR_SHADOW_REVIEW") return "<span class='value'>READY_FOR_SHADOW_REVIEW</span>";
          if (status === "CALIBRATING" || status === "MARKET_ODDS_MISSING" || status === "ANALYSIS_ONLY" || status === "STALE_MARKET_ODDS" || status === "MANUAL_ODDS_UNVERIFIED") return "<span class='warn'>" + esc(status) + "</span>";
          if (status === "NO_EDGE" || status === "NO_BET_PRICE_TOO_LOW") return "<span class='loss'>" + esc(status) + "</span>";
          return "<span class='badge'>" + esc(status) + "</span>";
        } },
        { label: "Partido", value: r => matchLabel(r) },
        { label: "Liga", value: r => esc(r.league_slug || "-") },
        { label: "Mercado", value: r => marketLabel(r.market_type) + (r.line === null || r.line === undefined ? "" : " " + Number(r.line).toFixed(1)) },
        { label: "Pick", value: r => pickLabel(r.market_selection) },
        { label: "Prob propia", value: r => fmtPct(r.model_probability) },
        { label: "Fair propia", value: r => fmtOdds(r.model_fair_odds) },
        { label: "Min EV +3%", value: r => fmtOdds(r.min_odds_for_ev_3 || r.min_market_odds_for_ev) },
        { label: "Min EV +5%", value: r => fmtOdds(r.min_odds_for_ev_5) },
        { label: "Market real", value: r => r.market_odds ? fmtOdds(r.market_odds) : "<span class='warn'>Falta</span>" },
        { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
        { label: "Edge fair", value: r => r.edge_to_fair === null || r.edge_to_fair === undefined ? "-" : fmtPct(r.edge_to_fair) },
        { label: "No-vig", value: r => r.market_no_vig_probability === null || r.market_no_vig_probability === undefined ? "-" : fmtPct(r.market_no_vig_probability) },
        { label: "Gap", value: r => r.model_vs_market_gap === null || r.model_vs_market_gap === undefined ? "-" : fmtPct(r.model_vs_market_gap) },
        { label: "Flags", value: r => (r.audit_flags || []).length ? (r.audit_flags || []).map(flag => "<span class='warn'>" + esc(flag) + "</span>").join(" ") : "-" },
        { label: "Bookmaker", value: r => esc(r.bookmaker || r.provider_name || "-") },
        { label: "Fuente", value: r => esc(r.source_label || r.source_url || r.provider_name || "-") },
        { label: "Verificado", value: r => esc(r.verified_by || "-") },
        { label: "Edad", value: r => "model " + Math.round(Number(r.model_age_seconds || 0) / 60) + "m" + (r.market_age_seconds === null || r.market_age_seconds === undefined ? "" : " | market " + Math.round(Number(r.market_age_seconds || 0) / 60) + "m") },
        { label: "Por que si", value: r => (r.why_yes || []).join(", ") || "-" },
        { label: "Por que no", value: r => (r.why_no || []).join(", ") || "-" },
        { label: "Accion", value: r => esc(r.recommendation || "-") }
      ], rows.length ? rows : [{
        bridge_status: "NO_OWNED_FAIR_ODDS",
        home_team_name: "Sin linea propia de futbol",
        away_team_name: "-",
        recommendation: "Correr scripts\\\\run_football_owned_fair_odds.cmd primero."
      }]);
    }
    function renderFootballShadowSegments(data) {
      data = data || {};
      const rows = data.rows || [];
      const overall = rows.find(r => r.segment_type === "overall" && r.segment_value === "all") || {};
      const closed = Number(overall.closed || 0);
      const closingValid = Number(overall.valid_closing_count || 0);
      const closingReview = Number(overall.invalid_closing_count || 0);
      const captureRate = closed > 0 ? closingValid / closed : 0;
      $("footballShadowSegmentsRecommendation").textContent = (data.recommendation || "Segmentos shadow cargados. Esperar closing/settlement para evaluar CLV.") +
        " Filtros activos: date_from=" + esc(data.date_from || "-") + ", date_to=" + esc(data.date_to || "-") + ", min_closed=" + esc(data.min_closed || 30) + ".";
      $("fssClosingValid").textContent = String(closingValid);
      $("fssClosingReview").textContent = String(closingReview);
      $("fssClvValid").textContent = String(overall.valid_clv_count || 0);
      $("fssCaptureRate").textContent = fmtPct(captureRate);
      $("fssMetricGate").textContent = overall.metric_sample_status || "INSUFFICIENT_SAMPLE";
      $("fssDixonColes").textContent = overall.dixon_coles_readiness || "NOT_READY_CLOSING_SAMPLE_INSUFFICIENT";
        renderTable("footballShadowSegmentsTable", [
          { label: "Segmento", value: r => esc((r.segment_type || "-") + " / " + (r.segment_value || "-")) },
        { label: "Estado visual", value: r => {
          const status = String(r.segment_visual_status || "-");
          if (status === "READY_FOR_SEGMENT_DECISION") return "<span class='value'>" + esc(status) + "</span>";
          if (status === "WAITING_VALID_CLOSING" || status === "CLOSING_QUALITY_REVIEW") return "<span class='warn'>" + esc(status) + "</span>";
          return "<span class='badge'>" + esc(status) + "</span>";
        } },
        { label: "Decision", value: r => {
          const decision = String(r.decision || "-");
          if (decision === "PROMOTE_WATCH") return "<span class='value'>" + esc(decision) + "</span>";
          if (decision === "KEEP_SHADOW") return "<span class='badge'>" + esc(decision) + "</span>";
          if (decision === "INSUFFICIENT_SAMPLE") return "<span class='warn'>" + esc(decision) + "</span>";
          if (decision === "REDUCE_EXPOSURE") return "<span class='warn'>" + esc(decision) + "</span>";
          if (decision === "BLOCK_SEGMENT") return "<span class='loss'>" + esc(decision) + "</span>";
          return "<span class='badge'>" + esc(decision) + "</span>";
        } },
        { label: "N", value: r => r.total ?? 0 },
        { label: "Closed", value: r => r.closed_min_sample_display || ((r.closed ?? 0) + "/" + (r.sample_required ?? "-")) },
        { label: "Closing valido", value: r => (r.valid_closing_count ?? 0) + " ok / " + (r.invalid_closing_count ?? 0) + " review" },
        { label: "Faltan", value: r => r.sample_remaining ?? "-" },
        { label: "W/L/P", value: r => (r.wins || 0) + "/" + (r.losses || 0) + "/" + (r.pushes || 0) },
        { label: "Win%", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
        { label: "Entry", value: r => fmtOdds(r.avg_entry_odds) },
        { label: "Closing", value: r => r.avg_closing_odds === null || r.avg_closing_odds === undefined ? "<span class='warn'>sin closing valido</span>" : fmtOdds(r.avg_closing_odds) },
        { label: "EV", value: r => r.avg_ev === null || r.avg_ev === undefined ? "-" : fmtPct(r.avg_ev) },
        { label: "Gap", value: r => r.avg_model_vs_market_gap === null || r.avg_model_vs_market_gap === undefined ? "-" : fmtPct(r.avg_model_vs_market_gap) },
        { label: "CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "<span class='warn'>CLV no valido para decision</span>" : fmtPct(r.avg_clv) },
        { label: "CLV+", value: r => r.positive_clv_rate === null || r.positive_clv_rate === undefined ? "-" : fmtPct(r.positive_clv_rate) },
        { label: "Brier", value: r => r.brier_display || (r.brier === null || r.brier === undefined ? "-" : r.brier) },
        { label: "Log loss", value: r => r.log_loss_display || (r.log_loss === null || r.log_loss === undefined ? "-" : r.log_loss) },
        { label: "ROI CI 95%", value: r => r.roi_ci_95_low === null || r.roi_ci_95_low === undefined ? "-" : (r.roi_ci_95_low + " .. " + r.roi_ci_95_high) },
        { label: "Dep", value: r => r.dependency_ratio === null || r.dependency_ratio === undefined ? "-" : fmtPct(r.dependency_ratio) },
        { label: "DC readiness", value: r => esc(r.dixon_coles_readiness || "-") },
        { label: "Profit", value: r => (r.profit_units ?? 0) + "u" },
        { label: "Accion", value: r => esc(r.recommendation || "-") }
      ], rows.length ? rows : [{
        segment_type: "overall",
        segment_value: "sin shadow settled",
        decision: "INSUFFICIENT_SAMPLE",
        recommendation: "Primero capturar closing y settlement shadow."
      }]);
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
        const grade = firstValue(pick.edge_quality_grade, pick.edge_grade, pick.grade, "-");
        const decision = firstValue(pick.pick_decision_status, pick.pick_decision, pick.decision, "-");
        const highEvAudit = firstValue(pick.high_ev_status, pick.high_ev_audit_status, "-");
        const blockingReasons = pickNegativeReasons(pick);
        const cls = simpleStatusClass(pick.simple_status || decision || pick.underdog_plus_status);
        return "<article class='pick-card'>" +
          "<header><span class='simple-status " + cls + "'>" + esc(pick.simple_status || "REVIEW") + "</span><strong>" + esc(pick.match) + "</strong></header>" +
          "<div class='pick-meta'><span>Pick: <b>" + esc(pick.pick_label || pick.pick) + "</b></span><span>Odds: <b>" + esc(pick.odds) + "</b></span><span>Prob: <b>" + (pick.model_probability === null || pick.model_probability === undefined ? "-" : fmtPct(pick.model_probability)) + "</b></span><span>EV: <b>" + (pick.expected_value === null || pick.expected_value === undefined ? "-" : fmtPct(pick.expected_value)) + "</b></span><span>Grade: <b>" + esc(grade) + "</b></span></div>" +
          "<div class='pick-meta'><span>Decision: " + esc(decision) + "</span><span>Underdog+: " + esc(pick.underdog_plus_status) + "</span><span>Matchup: " + esc(pick.matchup_status) + "</span><span>EV audit: " + esc(highEvAudit) + "</span></div>" +
          "<div class='reason-list'><div><b>Por que interesa</b><ul>" + listItems(pick.positive_reasons, "Sin razones positivas fuertes") + "</ul></div><div><b>Por que se frena</b><ul>" + listItems(blockingReasons, "Sin bloqueos activos") + "</ul></div></div>" +
          "<p class='muted'>" + esc(pick.recommended_action || "Revisar en Real Paper") + "</p>" +
        "</article>";
      }).join("");
      $("todayPickCards").innerHTML = cards || "<article class='pick-card'><strong>No hay picks activos limpios.</strong><p class='muted'>Corre ingest fresco o espera nuevos partidos; el sistema sigue en Real Paper only.</p></article>";

      renderTable("whyThisPickTable", [
        { label: "Match", value: r => esc(r.match) },
        { label: "Status", value: r => "<span class='simple-status " + simpleStatusClass(r.simple_status) + "'>" + esc(r.simple_status) + "</span>" },
        { label: "Por que si", value: r => (r.positive_reasons || []).map(esc).join("<br>") || "-" },
        { label: "Por que no", value: r => pickNegativeReasons(r).map(esc).join("<br>") || "-" },
        { label: "Accion", value: r => esc(r.recommended_action || "REVIEW_ONLY") }
      ], picks);

      renderTable("simpleMarketHealthTable", [
        { label: "Market", value: r => esc(r.market || "MLB Moneyline") },
        { label: "Status", value: r => r.status === "READY_FOR_REVIEW" ? "<span class='value'>READY_FOR_REVIEW</span>" : "<span class='warn'>" + esc(r.status || "-") + "</span>" },
        { label: "Closed", value: r => r.closed || 0 },
        { label: "W/L", value: r => formatWinLoss(r) },
        { label: "CLV", value: r => r.average_clv === null || r.average_clv === undefined ? "-" : fmtPct(r.average_clv) },
        { label: "Profit", value: r => (r.profit_units || 0) + "u" },
        { label: "Mejor segmento", value: r => esc(r.best_segment || "odds 2.01+") },
        { label: "Evitar", value: r => esc(r.avoid_segment || "odds 1.61-2.00") }
      ], [health]);
    }
    function renderSafetySuiteStatus(safetySuiteStatus) {
      const data = safetySuiteStatus || {};
      const status = String(data.system_status || "SAFETY_SUITE_UNKNOWN");
      const ok = status === "SAFETY_SUITE_OK";
      const noReport = status === "SAFETY_SUITE_NO_REPORT_YET";
      const failed = status.includes("FAILED");
      const section = $("safetySuiteHeader");
      if (section) section.className = "executive-decision " + (ok ? "state-confirmed" : failed ? "state-no-bet" : "state-review");
      const badge = $("safetySuiteBadge");
      if (badge) {
        badge.className = "exec-badge " + (ok ? "confirmed" : failed ? "no-bet" : "review");
        badge.textContent = ok ? "SAFETY_SUITE_OK" : noReport ? "NO_REPORT_YET" : status;
      }
      $("safetySuiteHeadline").textContent = ok
        ? "Sistema seguro para observación/captura"
        : failed ? "Safety Suite falló: no operar slate"
        : "Corre Safety Suite antes de operar slate";
      $("safetySuiteSummary").textContent = data.recommendation || "Safety Suite revisa build/typecheck, guardrails, closing, Source Capture y health.";
      $("safetySuiteAction").textContent = ok ? "OPERAR EN MODO SEGURO" : failed ? "DETENER" : "CORRER SUITE";
      $("safetySuiteReason").textContent = ok
        ? "No significa pick listo; solo confirma cabina segura."
        : noReport ? "Ejecuta scripts\\run_safety_suite.cmd desde la raíz del proyecto."
        : "Revisar pasos fallidos antes de capturar odds/closing/settlement.";
      $("safetySuiteCheckedAt").textContent = data.checked_at ? fmtDateTime(data.checked_at) : "-";
      const guardrails = data.guardrails || {};
      const guardrailsOk = Number(guardrails.real_candidate_count || 0) === 0 && !guardrails.real_money_enabled && !guardrails.kelly_enabled && !guardrails.telegram_auto_enabled && !guardrails.auto_post_allowed;
      $("safetySuiteGuardrails").innerHTML = guardrailsOk ? "<span class='value'>OK</span>" : "<span class='loss'>REVISAR</span>";
      $("safetySuiteReport").textContent = data.report_path ? "latest.json" : "sin reporte";
      const rows = data.results || [];
      const failedRows = rows.filter(r => Number(r.code || 0) !== 0 && String(r.result || "") !== "protected");
      $("safetySuiteSteps").innerHTML = failedRows.length ? "<span class='loss'>" + failedRows.length + " falla</span>" : "<span class='value'>" + rows.length + " OK</span>";
      $("safetySuiteDetails").innerHTML = rows.slice(0, 8).map(row => {
        const label = row.name || row.check || "-";
        const code = row.code !== undefined ? row.code : row.status;
        const result = row.result || (Number(row.code || 0) === 0 ? "ok" : "review");
        const cls = result === "ok" || result === "protected" || Number(code) === 0 ? "value" : "warn";
        return "<span class='" + cls + "'>" + esc(label) + ": " + esc(result) + "</span>";
      }).join("");
    }
    function setStatusChip(id, value, state) {
      const valueEl = $(id);
      if (!valueEl) return;
      valueEl.textContent = String(value);
      const chip = valueEl.closest(".status-chip");
      if (chip) chip.className = "status-chip " + (state || "");
    }
    function renderDashboardStatusBar(input) {
      input = input || {};
      const commandCenter = input.commandCenter || {};
      const commandCounts = commandCenter.counts || {};
      const guardrails = commandCenter.guardrails || {};
      const closing = input.closingWindowWatch || {};
      const closingSummary = closing.summary || {};
      const operational = input.operationalWindowQueue || {};
      const operationalSummary = operational.summary || {};
      const sourceCapture = input.sourceCaptureAssistant || {};
      const manualCapture = input.manualVerifiedSourceCaptures || {};
      const oddsCache = input.oddsSnapshotCache || {};
      const bestBets = input.bestBetsPerMatch || {};
      const confirmed = Number(bestBets.confirmed_paper || bestBets.confirmed || commandCounts.confirmed_paper || commandCounts.bettable_paper_confirmed || 0);
      const bettable = Number(bestBets.bettable_paper || commandCounts.bettable_paper || 0);
      const realCandidate = Number(commandCenter.real_candidate_count || commandCounts.real_candidate || guardrails.real_candidate_count || 0);
      const realMoney = Boolean(guardrails.real_money_enabled);
      const kelly = Boolean(guardrails.kelly_enabled);
      const telegram = Boolean(guardrails.telegram_auto_enabled);
      const closingNow = Number(closing.in_valid_closing_window || closingSummary.capture_closing_now || operationalSummary.capture_closing_now || 0);
      const nearStart = Number(operationalSummary.run_near_start_now || 0);
      const missed = Number(closing.missed_window || operationalSummary.missed_window || 0);
      const onTime = Number(closing.captured_on_time || manualCapture.closing_valid_on_time || manualCapture.captured_on_time || 0);
      const readySettlement = Number(operationalSummary.ready_for_settlement || 0);
      const sourcePending = Number(sourceCapture.draft_ready || 0);
      const evidence = Number(sourceCapture.evidence_captured || 0);
      const staleOdds = Number(oddsCache.stale || 0);
      const commandState = realCandidate === 0 && !realMoney && !kelly && !telegram ? "REVIEW_ONLY" : "REVISAR";
      setStatusChip("sbCommandState", commandState, commandState === "REVIEW_ONLY" ? "ok" : "bad");
      setStatusChip("sbRealCandidate", realCandidate, realCandidate === 0 ? "ok" : "bad");
      setStatusChip("sbRealMoney", realMoney ? "ON" : "OFF", realMoney ? "bad" : "ok");
      setStatusChip("sbKelly", kelly ? "ON" : "OFF", kelly ? "bad" : "ok");
      setStatusChip("sbTelegram", telegram ? "ON" : "OFF", telegram ? "bad" : "ok");
      setStatusChip("sbConfirmed", confirmed, confirmed > 0 ? "warn" : "");
      setStatusChip("sbBettable", bettable, bettable > 0 ? "warn" : "");
      setStatusChip("sbClosingNow", closingNow, closingNow > 0 ? "warn" : "");
      setStatusChip("sbNearStart", nearStart, nearStart > 0 ? "warn" : "");
      setStatusChip("sbMissed", missed, missed > 0 ? "warn" : "");
      setStatusChip("sbOnTime", onTime, onTime > 0 ? "ok" : "");
      setStatusChip("sbReadySettlement", readySettlement, readySettlement > 0 ? "warn" : "");
      setStatusChip("sbSourcePending", sourcePending, sourcePending > 0 ? "warn" : "");
      setStatusChip("sbEvidence", evidence, evidence > 0 ? "ok" : "");
      setStatusChip("sbStaleOdds", staleOdds, staleOdds > 0 ? "warn" : "ok");
    }
    function renderPendingSettlementMonitor(pendingSettlement) {
      const data = pendingSettlement || {};
      const summary = data.summary || {};
      const detailRows = groupPendingSettlementRows(data.rows || []);
      const hasPostponedOpen = detailRows.some(r => String(r.match_status || r.snapshot_status || "").toLowerCase().includes("postpon"));
      $("pendingSettlementRecommendation").textContent = (data.recommendation || "Sin recomendacion.") +
        (hasPostponedOpen ? " Revisar 2 postponed abiertos y preparar VOID/ARCHIVE dry-run." : "");
      const summaryRow = Object.assign({ row_type: "Resumen" }, summary);
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
        { label: "Snapshots", value: r => r.snapshots_count ?? "-" },
        { label: "Latest entry", value: r => fmtOdds(firstValue(r.latest_entry_odds, r.entry_odds)) },
        { label: "Best entry", value: r => fmtOdds(r.best_entry_odds) },
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
      const footballCommandRows = visibleFootballRows(data.league_market_performance || []);
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
      ], footballCommandRows);
    }
    function renderFootballCompetitionRegistry(registry) {
      const data = registry || {};
      const rows = data.rows || [];
      const trustedWatch = rows.filter(r => r.trust_status === "TRUSTED" || r.trust_status === "WATCH").length;
      const manualBlocked = rows.filter(r => r.trust_status === "MANUAL_ONLY" || r.trust_status === "BLOCKED").length;
      const favorites = data.priority_competitions || [];
      $("fcrTotal").textContent = String(data.total || rows.length || 0);
      $("fcrTrustedWatch").textContent = String(trustedWatch);
      $("fcrManualBlocked").textContent = String(manualBlocked);
      $("fcrFavorites").textContent = String(favorites.length || 0);
      $("fcrStatusMeta").textContent = "Fuente primaria para liga/mercado/trust.";
      $("fcrFavoriteNames").textContent = favorites.slice(0, 6).map(r => r.display_name).join(", ") || "Sin favoritas.";
      $("footballCompetitionRegistryRecommendation").textContent = data.recommendation || "Registry listo para normalizar ligas y bloquear mercados no permitidos.";
      renderTable("footballCompetitionRegistryTable", [
        { label: "Grupo", value: r => esc((r.confederation || "-") + " / " + (r.region || r.country || "-")) },
        { label: "Liga", value: r => esc(r.display_name || r.league_id || "-") },
        { label: "Trust", value: r => r.trust_status === "TRUSTED" ? "<span class='value'>TRUSTED</span>" : (r.trust_status === "NOISY" || r.trust_status === "MANUAL_ONLY" || r.trust_status === "BLOCKED" ? "<span class='warn'>" + esc(r.trust_status || "-") + "</span>" : "<span class='badge'>" + esc(r.trust_status || "-") + "</span>") },
        { label: "Score", value: r => r.trust_score ?? "-" },
        { label: "Tier", value: r => esc(r.tier || "-") },
        { label: "Markets", value: r => Object.entries(r.markets_enabled || {}).filter(([_, enabled]) => enabled).map(([market]) => marketLabel(market)).join(", ") || "manual only" },
        { label: "Aliases", value: r => (r.aliases || []).slice(0, 4).map(esc).join(", ") || "-" }
      ], rows.slice(0, 80));
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
      const footballMarketRows = visibleFootballRows(data.visible_rows || data.rows || []);
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
      ], footballMarketRows);
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
        { label: "Ready settlement", value: r => r.ready_for_settlement ?? r.finished_ready_for_settle ?? "-" },
        { label: "Missing result", value: r => r.missing_result ?? "-" },
        { label: "Missing closing strict", value: r => r.missing_closing_strict ?? r.missing_closing ?? "-" },
        { label: "Closing quality review", value: r => r.closing_quality_review ?? "-" },
        { label: "Stale open", value: r => r.stale_open ?? "-" },
        { label: "Closing quality", value: r => {
          const quality = r.raw_data && r.raw_data.closing_quality ? String(r.raw_data.closing_quality) : "-";
          if (quality === "CAPTURED_ON_TIME") return "<span class='value'>CAPTURED_ON_TIME</span>";
          if (quality === "CAPTURED_TOO_EARLY" || quality === "CAPTURED_LATE") return "<span class='warn'>" + esc(quality) + "</span>";
          return esc(quality);
        } },
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
    function renderFootballDataGateway(data) {
      data = data || {};
      const provider = data.provider_status || {};
      const cache = data.cache || {};
      const consensus = data.consensus || {};
      const footballDataUrl = data.football_data_url || {};
      $("fdgProvider").textContent = provider.provider || "api_football";
      $("fdgProviderMeta").textContent = (provider.api_key_configured ? "API key configurada en engine" : "Sin API key en engine") + " | used " + (provider.requests_used_today || 0) + "/" + (provider.requests_limit || 0);
      $("fdgQuotaRemaining").textContent = String(provider.quota_remaining_estimate ?? 0);
      $("fdgCacheValid").textContent = String(cache.valid_cache_entries || 0);
      $("fdgCacheMeta").textContent = (cache.total_cache_entries || 0) + " total | " + (cache.expired_cache_entries || 0) + " expired";
      $("fdgConsensusVerified").textContent = String(consensus.verified_consensus || 0);
      $("fdgConsensusMeta").textContent = (consensus.total_consensus || 0) + " total | " + (consensus.consensus_required || 0) + " requiere consenso";
      $("fdgFootballDataUrl").textContent = footballDataUrl.source_status || "SOURCE_MISSING";
      $("fdgFootballDataUrl").className = footballDataUrl.configured ? "value" : "warn";
      $("fdgFootballDataUrlMeta").textContent = footballDataUrl.recommendation || "Validar configuracion antes de usar.";
      $("footballDataGatewayRecommendation").textContent = data.recommendation || "Gateway listo; usar dry-run antes de aplicar.";
      renderTable("footballDataGatewayTable", [
        { label: "Tipo", value: r => esc(r.row_type || "Consenso") },
        { label: "Consenso", value: r => r.consensus_verified ? "<span class='value'>verified</span>" : "<span class='warn'>required</span>" },
        { label: "Liga", value: r => esc(r.league_id || "-") },
        { label: "Match", value: r => esc((r.home_team || "Home") + " vs " + (r.away_team || "Away")) },
        { label: "Score", value: r => r.consensus_score ?? "-" },
        { label: "Recommendation", value: r => esc(r.recommendation || "-") },
        { label: "Observed", value: r => fmtDateTime(r.observed_at) }
      ], [
        {
          row_type: "FOOTBALL_DATA_URL",
          consensus_verified: footballDataUrl.configured === true,
          league_id: "-",
          home_team: footballDataUrl.source_status || "SOURCE_MISSING",
          away_team: footballDataUrl.provider_name || "sin provider",
          consensus_score: footballDataUrl.configured ? 50 : 0,
          recommendation: footballDataUrl.recommendation || "Configurar fuente o usar manual_verified.",
          observed_at: footballDataUrl.fetched_at || null
        }
      ].concat((data.recent_consensus || []).length ? data.recent_consensus : [{ league_id: "-", home_team: "Sin consenso", away_team: "todavia", recommendation: data.recommendation || "Usar hydrate dry-run." }]));
    }
    function renderSportsIntelligenceCore(data) {
      data = data || {};
      const summary = data.provider_capabilities_summary || {};
      const consensus = data.consensus_summary || {};
      const context = data.context_summary || {};
      const rows = data.rows || [];
      $("sicProvidersAvailable").textContent = String(summary.available || 0);
      $("sicProviderMeta").textContent = (summary.total || 0) + " capabilities | fallback " + (summary.fallback_only || 0);
      $("sicProvidersBlocked").textContent = String(summary.blocked || 0);
      const blocked = data.plan_blocked_sources || [];
      $("sicBlockedMeta").textContent = blocked.length
        ? blocked.slice(0, 2).map(row => (row.provider || "-") + " " + (row.season || "-")).join(", ")
        : "Sin bloqueos fuertes.";
      $("sicConsensusVerified").textContent = String(data.consensus_verified_count || consensus.verified || 0);
      $("sicConsensusMeta").textContent = (consensus.total || 0) + " total | gaps " + (consensus.gaps || 0);
      $("sicContextGaps").textContent = String(data.context_gaps_count || context.gaps || 0);
      $("sicContextMeta").textContent = "Confirmed " + (data.confirmed_context_count || context.confirmed || 0) + " | manual " + (data.manual_verified_contexts || 0);
      $("sportsIntelligenceCoreRecommendation").textContent = data.recommendation || "sports-data-hub decide; proveedores solo alimentan.";
      renderTable("sportsIntelligenceCoreTable", [
        { label: "Provider", value: r => esc(r.provider || "-") },
        { label: "Sport", value: r => esc(r.sport || "-") },
        { label: "League", value: r => esc(r.league_id || "global") },
        { label: "Season", value: r => esc(r.season || "-") },
        { label: "Data Type", value: r => esc(r.data_type || "-") },
        { label: "Status", value: r => r.status === "AVAILABLE" ? "<span class='value'>AVAILABLE</span>" : (r.status === "PLAN_BLOCKED" || r.status === "NO_KEY" || r.status === "RATE_LIMITED" ? "<span class='loss'>" + esc(r.status || "-") + "</span>" : "<span class='warn'>" + esc(r.status || "-") + "</span>") },
        { label: "Confidence", value: r => r.confidence_score ?? "-" },
        { label: "Reason", value: r => esc(r.reason || "-") },
        { label: "Expires", value: r => fmtDateTime(r.expires_at) },
        { label: "Recommendation", value: r => esc(r.recommendation || "-") }
      ], rows.length ? rows : [{ provider: "sports-data-hub", sport: "-", league_id: "global", season: "-", data_type: "-", status: "UNKNOWN", recommendation: "Sin capabilities todavía." }]);
    }
    function renderExpectedLineupEngine(data) {
      data = data || {};
      const rows = data.rows || [];
      $("eleExpected").textContent = String(data.expected_or_projected || 0);
      $("eleConfirmed").textContent = String(data.confirmed || 0);
      $("eleChanged").textContent = String(data.changed_or_conflict || 0);
      $("eleNeedsOfficial").textContent = String(data.needs_official || 0);
      $("expectedLineupEngineRecommendation").textContent = data.recommendation || "Expected lineup es preview; confirmed paper requiere lineup oficial.";
      renderTable("expectedLineupEngineTable", [
        { label: "Status", value: r => r.engine_status === "LINEUP_CONFIRMED" || r.engine_status === "OFFICIAL_ONLY" ? "<span class='value'>" + esc(r.engine_status || "-") + "</span>" : (String(r.engine_status || "").includes("CHANGED") || String(r.engine_status || "").includes("REVIEW") ? "<span class='loss'>" + esc(r.engine_status || "-") + "</span>" : "<span class='warn'>" + esc(r.engine_status || "-") + "</span>") },
        { label: "Match", value: r => esc(r.match_id || "-") },
        { label: "Liga", value: r => esc(r.league_id || "-") },
        { label: "Team", value: r => esc(r.team_name || "-") },
        { label: "Expected", value: r => esc(r.expected_status || "-") + " (" + (r.expected_starters ?? 0) + " starters)" },
        { label: "Official", value: r => esc(r.official_status || "-") + " (" + (r.official_starters ?? 0) + " starters)" },
        { label: "Similarity", value: r => r.similarity_score === null || r.similarity_score === undefined ? "-" : fmtPct(Number(r.similarity_score) / 100) },
        { label: "Confidence", value: r => r.avg_expected_confidence === null || r.avg_expected_confidence === undefined ? "-" : r.avg_expected_confidence },
        { label: "Risk", value: r => r.change_risk === "LOW" ? "<span class='value'>LOW</span>" : (r.change_risk === "HIGH" ? "<span class='loss'>HIGH</span>" : "<span class='warn'>" + esc(r.change_risk || "-") + "</span>") },
        { label: "Power", value: r => r.confirmation_power === "CAN_SUPPORT_CONTEXT" ? "<span class='value'>CAN_SUPPORT_CONTEXT</span>" : "<span class='warn'>" + esc(r.confirmation_power || "-") + "</span>" },
        { label: "Missing official", value: r => r.missing_official ? "<span class='warn'>yes</span>" : "<span class='value'>no</span>" },
        { label: "Source", value: r => esc(r.source || "-") },
        { label: "Recommendation", value: r => esc(r.recommendation || "-") }
      ], rows.length ? rows : [{
        engine_status: "NO_EXPECTED_LINEUPS",
        match_id: "-",
        league_id: "-",
        team_name: "Sin resguardo todavia",
        expected_status: "NO_EXPECTED_LINEUP",
        official_status: "NO_OFFICIAL_LINEUP",
        missing_official: true,
        recommendation: data.recommendation || "Cargar expected_lineups con dry-run antes de aplicar."
      }]);
    }
    function renderFootballIntelligence({ trustScores, teamIntel, playerIntel, confirmedChain }) {
      trustScores = trustScores || {};
      teamIntel = teamIntel || {};
      playerIntel = playerIntel || {};
      confirmedChain = confirmedChain || {};
      const trustRows = trustScores.rows || [];
      const teamRows = teamIntel.rows || [];
      const playerRows = playerIntel.rows || [];
      const chainRows = confirmedChain.rows || [];
      const trustedLeagues = trustRows.filter(row => row.trust_status === "TRUSTED").length;
      const watchLeagues = trustRows.filter(row => row.trust_status === "WATCH").length;
      const manualLeagues = trustRows.filter(row => row.trust_status === "MANUAL_ONLY").length;
      const blockedLeagues = trustRows.filter(row => row.trust_status === "BLOCKED").length;
      $("fiTrustedLeagues").textContent = String(trustedLeagues);
      $("fiTrustMeta").textContent = "Watch " + watchLeagues + " | Manual " + manualLeagues + " | Blocked " + blockedLeagues;
      $("fiTeamContexts").textContent = String(teamIntel.total_contexts || teamRows.length || 0);
      $("fiTeamMeta").textContent = "Gaps " + (teamIntel.context_gaps || 0) + " | Supports " + (teamIntel.supports_context || 0);
      $("fiPlayerContexts").textContent = String(playerIntel.total_contexts || playerRows.length || 0);
      $("fiPlayerMeta").textContent = "Lineup pending " + (playerIntel.lineup_pending || 0) + " | Blocks " + (playerIntel.block_confirmation || 0);
      $("fiConfirmedPaper").textContent = String(confirmedChain.football_confirmed_paper || 0);
      const footballContextSummary = confirmedChain.context_completeness_summary || {};
      $("fiChainMeta").textContent = "Active " + (confirmedChain.active_football_picks || 0) + " | Context gaps " + (confirmedChain.context_gaps || 0) + " | Fuerte " + (footballContextSummary.fuerte || 0) + " | Revisable " + (footballContextSummary.revisable || 0);
      $("footballIntelligenceRecommendation").textContent = confirmedChain.recommendation || "Futbol sigue Shadow Paper only; completar liga, odds, modelo y contexto.";
      renderTable("footballConfirmedPickChainTable", [
        { label: "Final", value: r => r.final_chain_status === "FOOTBALL_CONFIRMED_PAPER" ? "<span class='value'>FOOTBALL_CONFIRMED_PAPER</span>" : (String(r.final_chain_status || "").includes("REJECT") || String(r.final_chain_status || "").includes("BLOCKED") ? "<span class='loss'>" + esc(r.final_chain_status || "-") + "</span>" : "<span class='warn'>" + esc(r.final_chain_status || "-") + "</span>") },
        { label: "Match", value: r => esc(r.match || "-") },
        { label: "Liga", value: r => esc(r.league || r.league_id || "-") },
        { label: "Mercado", value: r => marketLabel(r.market) },
        { label: "Pick", value: r => pickLabel(r.pick) },
        { label: "Odds", value: r => fmtOdds(r.odds) },
        { label: "Model Prob", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
        { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
        { label: "Market", value: r => esc((r.market_layer || {}).status || "-") },
        { label: "Context", value: r => r.football_context_completeness_score === null || r.football_context_completeness_score === undefined ? "-" : "<span class='" + (Number(r.football_context_completeness_score) >= 81 ? "value" : Number(r.football_context_completeness_score) >= 61 ? "warn" : "loss") + "'>" + esc(r.football_context_completeness_score) + "/100</span>" },
        { label: "Tier", value: r => r.football_tier_classification === "FUERTE" ? "<span class='value'>FUERTE</span>" : (r.football_tier_classification === "REVISABLE" ? "<span class='warn'>REVISABLE</span>" : "<span class='badge'>" + esc(r.football_tier_classification || "-") + "</span>") },
        { label: "Action", value: r => r.football_context_actionable_status === "READY_FOR_SHADOW_REVIEW" ? "<span class='value'>READY_FOR_SHADOW_REVIEW</span>" : esc(r.football_context_actionable_status || "-") },
        { label: "Trust", value: r => (r.league_trust_score ?? "-") + " / " + esc(r.league_trust_status || "-") },
        { label: "Team Intel", value: r => esc(r.team_intelligence_status || "-") },
        { label: "Player Intel", value: r => esc(r.player_intelligence_status || "-") },
        { label: "Kickoff", value: r => esc(r.kickoff_status || "-") },
        { label: "Odds TS", value: r => esc(r.odds_timestamp_status || "-") },
        { label: "Missing", value: r => (r.missing_context_fields || []).join(", ") || "none" },
        { label: "Recommendation", value: r => esc(r.recommendation || "-") }
      ], chainRows.length ? chainRows : [{
        final_chain_status: "NO_FOOTBALL_PICK_ACTIVE",
        match: "Sin picks de futbol activos",
        recommendation: confirmedChain.recommendation || "Cargar solo SHADOW_CANDIDATE validado."
      }]);
      renderTable("footballLeagueTrustTable", [
        { label: "Liga", value: r => esc(r.display_name || r.league_id || "-") },
        { label: "Trust", value: r => r.trust_status === "TRUSTED" ? "<span class='value'>TRUSTED</span>" : (r.trust_status === "BLOCKED" ? "<span class='loss'>BLOCKED</span>" : "<span class='warn'>" + esc(r.trust_status || "-") + "</span>") },
        { label: "Score", value: r => r.trust_score ?? "-" },
        { label: "Priority", value: r => esc(r.priority || "-") },
        { label: "Allowed", value: r => asArray(r.allowed_markets || r.market_allowed_json).map(marketLabel).join(", ") || "-" },
        { label: "Blocked", value: r => asArray(r.blocked_markets || r.market_blocked_json).map(marketLabel).join(", ") || "-" },
        { label: "Recommendation", value: r => esc(r.recommendation || "-") }
      ], trustRows);
      renderTable("footballTeamIntelligenceTable", [
        { label: "Status", value: r => r.team_intelligence_status === "TEAM_CONTEXT_SUPPORTS" ? "<span class='value'>TEAM_CONTEXT_SUPPORTS</span>" : (r.team_intelligence_status === "BLOCK_CONFIRMATION" ? "<span class='loss'>BLOCK_CONFIRMATION</span>" : "<span class='warn'>" + esc(r.team_intelligence_status || "-") + "</span>") },
        { label: "Match", value: r => esc(r.match || "-") },
        { label: "Liga", value: r => esc(r.league_id || "-") },
        { label: "Home", value: r => esc(r.home_team_name || "-") },
        { label: "Away", value: r => esc(r.away_team_name || "-") },
        { label: "Home form", value: r => esc(r.home_recent_form || "-") },
        { label: "Away form", value: r => esc(r.away_recent_form || "-") },
        { label: "Home score", value: r => r.home_context_score ?? "-" },
        { label: "Away score", value: r => r.away_context_score ?? "-" },
        { label: "Source", value: r => esc(r.source || "-") },
        { label: "Recommendation", value: r => esc(r.recommendation || "-") }
      ], teamRows.length ? teamRows : [{
        team_intelligence_status: "NO_CONTEXT",
        match: "Sin team context de futbol",
        recommendation: teamIntel.recommendation || "Alimentar contexto solo con fuentes confiables."
      }]);
      renderTable("footballPlayerIntelligenceTable", [
        { label: "Status", value: r => r.player_intelligence_status === "PLAYER_CONTEXT_SUPPORTS" ? "<span class='value'>PLAYER_CONTEXT_SUPPORTS</span>" : (r.player_intelligence_status === "BLOCK_CONFIRMATION" ? "<span class='loss'>BLOCK_CONFIRMATION</span>" : "<span class='warn'>" + esc(r.player_intelligence_status || "-") + "</span>") },
        { label: "Match", value: r => esc(r.match || "-") },
        { label: "Team", value: r => esc(r.team_name || "-") },
        { label: "League", value: r => esc(r.league_id || "-") },
        { label: "Lineup", value: r => r.lineup_confirmed ? "<span class='value'>confirmed</span>" : "<span class='warn'>pending</span>" },
        { label: "Unavailable", value: r => r.key_players_unavailable ?? "-" },
        { label: "Doubtful", value: r => r.doubtful_players ?? "-" },
        { label: "Impact", value: r => r.player_news_impact_score ?? "-" },
        { label: "Source", value: r => esc(r.source || "-") },
        { label: "Recommendation", value: r => esc(r.recommendation || "-") }
      ], playerRows.length ? playerRows : [{
        player_intelligence_status: "LINEUP_PENDING",
        match: "Sin player context de futbol",
        recommendation: playerIntel.recommendation || "Esperar lineups/news verificadas."
      }]);
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
        const matchDate = encodeURIComponent(selectedMatchCenterDate());
        const [
          safetySuiteStatus,
          live,
          sportsLiveBoard,
          matchCenter,
          bestBetsPerMatch,
          candidatePreflightQueue,
          matchPreflightQueue,
          bottleneckBySource,
          closingWindowWatch,
          closingCaptureDraft,
          sourceCaptureAssistant,
          operationalWindowQueue,
          operationalAlerts,
          oddsSnapshotCache,
          cleanSampleQueue,
          shadowTicketChain,
          manualVerifiedSourceCaptures,
          footballOwnedFairOddsBridge,
          footballShadowSegments,
          nearStartContextStatus,
          perf,
          alpha,
          smart,
          parlays,
          paper,
          health,
          commandCenter,
          pilotReadinessGate,
          freshVsArchive,
          dataQualityScores,
          evOutlierGuardrail,
          confirmedVsEvBacktest,
          formalPilotReadiness,
          freshCandidateInbox,
          ruleConfidence,
          walkForwardBacktest,
          realPilotSimulator,
          confirmedPickChain,
          timestampMismatchAudit,
          pendingSettlement,
          footballCommandCenter,
          footballCompetitionRegistry,
          footballTodayUniverse,
          footballMarketLab,
          footballPendingSettlement,
          footballFeedQuality,
          footballLeagueTrustScores,
          footballTeamIntelligence,
          footballPlayerIntelligence,
          footballConfirmedPickChain,
          footballReadinessGate,
          footballDataGateway,
          sportsIntelligenceCore,
          expectedLineupEngine,
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
          closingSupportedEdge,
          extremeEvClosingAudit,
          matchupConfirmation,
          teamIntelligence,
          intelligenceScout,
          playerIntelligence,
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
        ] = await getJsonBatch([
          getJson("/api/v1/internal/analytics/safety-suite/status"),
          getJson("/api/v1/internal/model-quotes/live-board?limit=50&max_age_minutes=1440"),
          getJson("/api/v1/internal/analytics/live-board?date=" + matchDate),
          getJson("/api/v1/internal/analytics/match-center?date=" + matchDate + "&fallback_recent=true"),
          getJson("/api/v1/internal/analytics/best-bets-per-match?date=" + matchDate + "&fallback_recent=true"),
          getJson("/api/v1/internal/analytics/candidate-preflight/status?date=" + matchDate + "&sport=all&limit=120"),
          getJson("/api/v1/internal/analytics/match-preflight/status?date=" + matchDate + "&sport=all&limit=120"),
          getJson("/api/v1/internal/analytics/bottleneck-by-source?date=" + matchDate + "&sport=all&limit=120"),
          getJson("/api/v1/internal/analytics/closing-window-watch?date=" + matchDate + "&sport=all&limit=120"),
          getJson("/api/v1/internal/analytics/closing-capture-draft?date=" + matchDate + "&sport=all&limit=120"),
          getJson("/api/v1/internal/analytics/source-capture-assistant?date=" + matchDate + "&sport=all&limit=120"),
          getJson("/api/v1/internal/analytics/operational-window-queue?date=" + matchDate + "&sport=all&limit=120"),
          getJson("/api/v1/internal/analytics/operational-alerts?date=" + matchDate + "&sport=all&limit=120"),
          getJson("/api/v1/internal/analytics/odds-snapshot-cache?date=" + matchDate + "&sport=all&limit=120"),
          getJson("/api/v1/internal/analytics/clean-sample-queue?date=" + matchDate + "&sport=all&limit=120"),
          getJson("/api/v1/internal/analytics/shadow-ticket-chain?date=" + matchDate + "&sport=all&limit=120"),
          getJson("/api/v1/internal/analytics/source-capture/manual-verified/status?date=" + matchDate + "&sport=all&limit=120"),
          getJson("/api/v1/internal/model-quotes/owned-fair-odds-bridge?sport=soccer&date=" + matchDate + "&max_model_age_minutes=1440&max_market_age_minutes=1440&limit=80"),
          getJson("/api/v1/internal/analytics/football/performance/segments?date_to=" + matchDate + "&min_closed=30&limit=120"),
          getJson("/api/v1/internal/analytics/near-start-context/status?date=" + matchDate + "&fallback_recent=true"),
          getJson("/api/v1/internal/model-quotes/performance-summary"),
          getJson("/api/v1/internal/model-quotes/alpha-opportunities?processed=false&min_ev=0&limit=50"),
          getJson("/api/v1/internal/model-quotes/smart-selection?min_ev=0.05&min_confidence=0&limit=50&max_model_age_minutes=1440&max_market_age_minutes=1440"),
          getJson("/api/v1/internal/model-quotes/parlay-suggestions?processed=false&min_ev=0.05&limit=80&max_age_minutes=1440"),
          getJson("/api/v1/paper-trades/summary", false),
          getJson("/api/v1/internal/model-quotes/data-health"),
          getJson("/api/v1/internal/analytics/command-center"),
          getJson("/api/v1/internal/analytics/pilot-readiness-gate"),
          getJson("/api/v1/internal/analytics/fresh-vs-archive"),
          getJson("/api/v1/internal/analytics/data-quality-scores"),
          getJson("/api/v1/internal/analytics/ev-outlier-guardrail"),
          getJson("/api/v1/internal/analytics/confirmed-vs-ev-backtest"),
          getJson("/api/v1/internal/analytics/formal-pilot-readiness"),
          getJson("/api/v1/internal/analytics/fresh-candidate-inbox"),
          getJson("/api/v1/internal/analytics/rule-confidence"),
          getJson("/api/v1/internal/analytics/walk-forward-backtest"),
          getJson("/api/v1/internal/analytics/real-pilot-simulator"),
          getJson("/api/v1/internal/analytics/confirmed-pick-chain"),
          getJson("/api/v1/internal/analytics/timestamp-mismatch-audit"),
          getJson("/api/v1/internal/analytics/pending-settlement-monitor"),
          getJson("/api/v1/internal/analytics/football-command-center"),
          getJson("/api/v1/internal/analytics/football-competition-registry"),
          getJson("/api/v1/internal/analytics/football-today-universe?date=" + matchDate),
          getJson("/api/v1/internal/analytics/football-market-lab"),
          getJson("/api/v1/internal/analytics/football-pending-settlement-monitor"),
          getJson("/api/v1/internal/analytics/football-feed-quality-report"),
          getJson("/api/v1/internal/analytics/football-league-trust-scores"),
          getJson("/api/v1/internal/analytics/football-team-intelligence"),
          getJson("/api/v1/internal/analytics/football-player-intelligence"),
          getJson("/api/v1/internal/analytics/football-confirmed-pick-chain"),
          getJson("/api/v1/internal/analytics/football-readiness-gate"),
          getJson("/api/v1/internal/analytics/football-data-gateway-status"),
          getJson("/api/v1/internal/analytics/sports-intelligence-core"),
          getJson("/api/v1/internal/analytics/expected-lineup-engine?sport=football&limit=100"),
          getJson("/api/v1/internal/model-quotes/real-paper-summary"),
          getJson("/api/v1/internal/model-quotes/portfolio-summary"),
          getJson("/api/v1/internal/odds-snapshots/health?max_age_hours=720&limit=50"),
          getJson("/api/v1/internal/odds-snapshots/provider-scorecard?max_age_hours=720&limit=50"),
          getJson("/api/v1/internal/model-quotes/clv-lab?league_slug=mlb&market_type=moneyline_2way&min_closed=1&limit=100"),
          getJson("/api/v1/internal/analytics/closing-line-intelligence"),
          getJson("/api/v1/internal/analytics/confidence-calibration"),
          getJson("/api/v1/internal/analytics/bet-grading"),
          getJson("/api/v1/internal/analytics/edge-quality-score"),
          getJson("/api/v1/internal/analytics/pick-explainability?date=" + matchDate + "&sport=all"),
          getJson("/api/v1/internal/analytics/timing-engine"),
          getJson("/api/v1/internal/analytics/line-movement-radar"),
          getJson("/api/v1/internal/analytics/auto-research-lab"),
          getJson("/api/v1/internal/analytics/why-no-bettable-paper"),
          getJson("/api/v1/internal/analytics/high-ev-audit"),
          getJson("/api/v1/internal/analytics/closing-supported-edge"),
          getJson("/api/v1/internal/analytics/extreme-ev-closing-audit"),
          getJson("/api/v1/internal/analytics/matchup-confirmation"),
          getJson("/api/v1/internal/analytics/team-intelligence"),
          getJson("/api/v1/internal/analytics/intelligence-scout"),
          getJson("/api/v1/internal/analytics/player-intelligence"),
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

        let effectiveFootballTodayUniverse = footballTodayUniverse;
        const selectedDateRaw = decodeURIComponent(matchDate);
        if (matchCenter && matchCenter.date_fallback_applied && matchCenter.date && matchCenter.date !== selectedDateRaw) {
          effectiveFootballTodayUniverse = (await getJsonBatch([
            getJson("/api/v1/internal/analytics/football-today-universe?date=" + encodeURIComponent(matchCenter.date))
          ]))[0];
        }

        $("mLive").textContent = live.count || 0;
        $("mSmart").textContent = smart.count || 0;
        $("mAlpha").textContent = alpha.count || 0;
        $("mProfit").textContent = ((paper.balance_neto_mxn || 0) / 100).toFixed(2) + "u";
        renderSafetySuiteStatus(safetySuiteStatus);
        renderExecutiveDecisionHeader(commandCenter, confirmedPickChain, dataQualityScores, whyNoBettablePaper);
        updateReaderGuide({ health, pilotChecklist, timingEngine, edgeQuality, autoResearchLab });
        $("pilotReadinessGateRecommendation").textContent = pilotReadinessGate.recommendation || "Pilot gate cargado.";
        renderTable("pilotReadinessGateTable", [
          { label: "Gate", value: r => r.gate || "-" },
          { label: "Pass", value: r => r.passed ? "<span class='value'>PASS</span>" : (r.severity === "CRITICAL" ? "<span class='loss'>FAIL</span>" : "<span class='warn'>WAIT</span>") },
          { label: "Value", value: r => r.value ?? "-" },
          { label: "Requirement", value: r => r.requirement || "-" },
          { label: "Severity", value: r => r.severity === "CRITICAL" ? "<span class='loss'>CRITICAL</span>" : (r.severity === "HIGH" || r.severity === "MEDIUM" ? "<span class='warn'>" + r.severity + "</span>" : "<span class='badge'>" + (r.severity || "OK") + "</span>") },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], [{
          gate: "Final State",
          passed: pilotReadinessGate.final_state === "PILOT_READY_BUT_LOCKED",
          value: pilotReadinessGate.final_state || "-",
          requirement: "Debe terminar bloqueado, sin dinero real.",
          severity: pilotReadinessGate.final_state === "STOP_REAL_MONEY_GUARDRAIL_BREACH" ? "CRITICAL" : "OK",
          recommendation: pilotReadinessGate.recommendation || "-"
        }].concat(pilotReadinessGate.rows || []));
        $("freshVsArchiveRecommendation").textContent = (freshVsArchive.mode === "dry-run" ? "DRY-RUN / NO PERSISTIDO. " : "") +
          (freshVsArchive.recommendation || "Fresh vs Archive cargado.");
        renderTable("freshVsArchiveTable", [
          { label: "Mode", value: r => freshVsArchive.mode === "dry-run" ? "<span class='warn'>DRY-RUN / NO PERSISTIDO</span>" : "<span class='value'>APLICADO</span>" },
          { label: "State", value: r => r.data_state === "FRESH" ? "<span class='value'>FRESH</span>" : (r.data_state === "DUPLICATE" ? "<span class='loss'>DUPLICATE</span>" : "<span class='badge'>" + esc(r.data_state || "-") + "</span>") },
          { label: "Count", value: r => r.count ?? "-" },
          { label: "Active", value: r => r.active_count ?? "-" },
          { label: "Settled", value: r => r.settled_count ?? "-" },
          { label: "Avg CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "Profit", value: r => (r.profit_units ?? 0) + "u" },
          { label: "Note", value: r => r.note || (freshVsArchive.mode === "dry-run" ? "Dry-run; no movio datos." : "Aplicado.") }
        ], (freshVsArchive.summary || []).length ? freshVsArchive.summary : [{
          data_state: "NO_DATA",
          count: 0,
          note: freshVsArchive.recommendation || "Sin resumen."
        }]);
        $("dataQualityScoresRecommendation").textContent = (dataQualityScores.mode === "dry-run" ? "DRY-RUN / NO PERSISTIDO. " : "") +
          (dataQualityScores.recommendation || "Data Quality cargado.");
        renderTable("dataQualityScoresTable", [
          { label: "Mode", value: r => dataQualityScores.mode === "dry-run" ? "<span class='warn'>DRY-RUN / NO PERSISTIDO</span>" : "<span class='value'>APLICADO</span>" },
          { label: "Tier", value: r => r.tier === "STRONG" ? "<span class='value'>STRONG</span>" : (r.tier === "REVIEWABLE" ? "<span class='warn'>REVIEWABLE</span>" : "<span class='badge'>" + esc(r.tier || "-") + "</span>") },
          { label: "Score", value: r => (r.total_score ?? "-") + "/100" },
          { label: "Match", value: r => esc(r.match || "-") },
          { label: "Missing", value: r => (r.missing_components || []).join(", ") || "none" },
          { label: "Why", value: r => esc(r.why_not_confirmed || "-") }
        ], (dataQualityScores.rows || []).slice(0, 25));
        $("evOutlierGuardrailRecommendation").textContent = evOutlierGuardrail.recommendation || "EV outlier guardrail cargado.";
        renderTable("evOutlierGuardrailTable", [
          { label: "Match", value: r => esc(r.match || "-") },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
          { label: "Threshold", value: r => evOutlierGuardrail.threshold === null || evOutlierGuardrail.threshold === undefined ? "-" : fmtPct(evOutlierGuardrail.threshold) },
          { label: "Model Prob", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
          { label: "Odds", value: r => fmtOdds(r.entry_odds) },
          { label: "Flag", value: r => esc(r.ev_flag || "WOULD_FLAG_EV_OUTLIER_HIGH") },
          { label: "Recommendation", value: r => evOutlierGuardrail.mode === "dry-run" ? "Review antes de aplicar; no confirmar por EV extremo." : "Marcado para review." }
        ], (evOutlierGuardrail.rows || []).length ? evOutlierGuardrail.rows : [{
          match: "Sin EV outliers frescos",
          recommendation: evOutlierGuardrail.recommendation || "-"
        }]);
        $("confirmedVsEvBacktestRecommendation").textContent = confirmedVsEvBacktest.recommendation || "Confirmed vs EV cargado.";
        renderTable("confirmedVsEvBacktestTable", [
          { label: "Segment", value: r => r.segment === "confirmed_context" ? "<span class='value'>confirmed_context</span>" : "<span class='badge'>" + esc(r.segment || "-") + "</span>" },
          { label: "Status", value: r => r.sample_status === "POSITIVE_EDGE_REVIEW" ? "<span class='value'>POSITIVE_EDGE</span>" : (r.sample_status === "INSUFFICIENT_SAMPLE" ? "<span class='warn'>INSUFFICIENT</span>" : "<span class='badge'>" + esc(r.sample_status || "-") + "</span>") },
          { label: "N", value: r => r.n || 0 },
          { label: "W/L", value: r => (r.wins || 0) + "/" + (r.losses || 0) },
          { label: "Avg Quality", value: r => r.avg_data_quality_score ?? "-" },
          { label: "Avg EV", value: r => r.avg_ev === null || r.avg_ev === undefined ? "-" : fmtPct(r.avg_ev) },
          { label: "Avg CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "Profit", value: r => (r.profit_units || 0) + "u" },
          { label: "Top 10%", value: r => (r.profit_from_top10 || 0) + "u / " + (r.top_10pct_n || 0) + " picks" },
          { label: "Excl Top 10%", value: r => (r.profit_excluding_top10 || 0) + "u" },
          { label: "Robustez", value: r => r.robustness_status === "ROBUST_AFTER_TOP10_EXCLUSION" ? "<span class='value'>ROBUST</span>" : "<span class='warn'>DEPENDS_ON_TAIL</span>" },
          { label: "Brier", value: r => r.brier ?? "-" },
          { label: "Recommendation", value: r => esc(r.recommendation || "-") }
        ], (confirmedVsEvBacktest.rows || []).length ? confirmedVsEvBacktest.rows : [{
          segment: "NO_SAMPLE",
          sample_status: "INSUFFICIENT_SAMPLE",
          recommendation: confirmedVsEvBacktest.recommendation || "Seguir acumulando."
        }]);
        $("formalPilotReadinessRecommendation").textContent = formalPilotReadiness.recommendation || "Formal gate cargado.";
        renderTable("formalPilotReadinessTable", [
          { label: "Check", value: r => r.check },
          { label: "Pass", value: r => r.passed ? "<span class='value'>PASS</span>" : "<span class='warn'>WAIT</span>" },
          { label: "Value", value: r => r.value },
          { label: "Requirement", value: r => r.requirement }
        ], [
          { check: "Backtest positive CI", passed: formalPilotReadiness.backtest_positive_ci, value: String(formalPilotReadiness.backtest_positive_ci), requirement: "Confirmed context debe sostener CLV/profit con muestra." },
          { check: "Min sample reached", passed: formalPilotReadiness.min_sample_reached, value: String(formalPilotReadiness.min_sample_reached), requirement: "150+ confirmados cerrados antes de hablar de piloto." },
          { check: "Avg quality score", passed: formalPilotReadiness.quality_score_passes, value: formalPilotReadiness.avg_quality_score_confirmed ?? "-", requirement: "Promedio >= 80." },
          { check: "Zero duplicate exposure", passed: formalPilotReadiness.zero_duplicate_exposure, value: String(formalPilotReadiness.zero_duplicate_exposure), requirement: "Sin duplicados en últimas 4 semanas." },
          { check: "Provider scorecard clean", passed: formalPilotReadiness.provider_scorecard_clean, value: String(formalPilotReadiness.provider_scorecard_clean), requirement: "Providers sin alertas activas." },
          { check: "Settlement clean", passed: formalPilotReadiness.settlement_clean, value: String(formalPilotReadiness.settlement_clean), requirement: "Sin pendientes viejos que contaminen." },
          { check: "Final", passed: formalPilotReadiness.all_passed, value: formalPilotReadiness.all_passed ? "PILOT_READY_BUT_LOCKED" : "NO_REAL_MONEY", requirement: "Aunque pase, requiere autorización explícita." }
        ]);
        $("freshCandidateInboxRecommendation").textContent = freshCandidateInbox.recommendation || "Fresh inbox cargado.";
        renderTable("freshCandidateInboxTable", [
          { label: "Tier", value: r => r.candidate_tier === "CONFIRMED_PAPER" ? "<span class='value'>CONFIRMED_PAPER</span>" : (r.candidate_tier === "PAPER_CANDIDATE_REVIEW" ? "<span class='warn'>PAPER_REVIEW</span>" : "<span class='badge'>" + (r.candidate_tier || "-") + "</span>") },
          { label: "Fresh", value: r => r.is_fresh_operational ? "<span class='value'>yes</span>" : "<span class='loss'>no</span>" },
          { label: "Match", value: r => esc(r.match || "-") },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Status", value: r => r.final_operational_status || r.status || "-" },
          { label: "Team Intel", value: r => r.team_intelligence_status || "-" },
          { label: "Complete", value: r => r.context_completeness_score === null || r.context_completeness_score === undefined ? "-" : r.context_completeness_score + "%" },
          { label: "Odds", value: r => fmtOdds(r.entry_odds) },
          { label: "Model Prob", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
          { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
          { label: "Provider", value: r => r.provider || "-" },
          { label: "Blocks", value: r => (r.blocking_reasons || []).join(", ") || "-" },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], (freshCandidateInbox.rows || []).length ? freshCandidateInbox.rows : [{
          candidate_tier: "NO_FRESH_CANDIDATES",
          is_fresh_operational: false,
          match: "No hay candidato fresco limpio",
          recommendation: freshCandidateInbox.recommendation || "Esperar datos frescos."
        }]);
        $("ruleConfidenceRecommendation").textContent = ruleConfidence.recommendation || "Rule confidence cargado.";
        renderTable("ruleConfidenceTable", [
          { label: "Confidence", value: r => r.confidence_status === "HIGH_CONFIDENCE_WATCH" ? "<span class='value'>HIGH</span>" : (r.confidence_status === "WATCH" ? "<span class='warn'>WATCH</span>" : "<span class='badge'>" + (r.confidence_status || "-") + "</span>") },
          { label: "Score", value: r => r.confidence_score ?? "-" },
          { label: "Rule", value: r => r.rule_name || r.rule_key || "-" },
          { label: "Closed", value: r => r.closed || 0 },
          { label: "W/L", value: r => (r.wins || 0) + "/" + (r.losses || 0) },
          { label: "Win Rate", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
          { label: "Profit", value: r => (r.profit_units || 0) + "u" },
          { label: "CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "Recent CLV20", value: r => r.recent_clv_20 === null || r.recent_clv_20 === undefined ? "-" : fmtPct(r.recent_clv_20) },
          { label: "Brier", value: r => r.brier ?? "-" },
          { label: "Max DD", value: r => r.max_drawdown ?? "-" },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], (ruleConfidence.rows || []).slice(0, 12));
        $("walkForwardBacktestRecommendation").textContent = walkForwardBacktest.recommendation || "Walk-forward cargado.";
        renderTable("walkForwardBacktestTable", [
          { label: "Status", value: r => r.walk_forward_status === "WALK_FORWARD_PASS" ? "<span class='value'>WALK_FORWARD_PASS</span>" : (String(r.walk_forward_status || "").includes("FAIL") ? "<span class='loss'>" + (r.walk_forward_status || "-") + "</span>" : "<span class='warn'>" + (r.walk_forward_status || "-") + "</span>") },
          { label: "Rule", value: r => r.rule_name || r.rule_key || "-" },
          { label: "Total", value: r => r.total_samples || 0 },
          { label: "Discovery N", value: r => r.discovery_closed || 0 },
          { label: "Discovery W/L", value: r => (r.discovery_wins || 0) + "/" + (r.discovery_losses || 0) },
          { label: "Discovery Profit", value: r => (r.discovery_profit || 0) + "u" },
          { label: "Discovery CLV", value: r => r.discovery_clv === null || r.discovery_clv === undefined ? "-" : fmtPct(r.discovery_clv) },
          { label: "Validation N", value: r => r.validation_closed || 0 },
          { label: "Validation W/L", value: r => (r.validation_wins || 0) + "/" + (r.validation_losses || 0) },
          { label: "Validation Profit", value: r => (r.validation_profit || 0) + "u" },
          { label: "Validation CLV", value: r => r.validation_clv === null || r.validation_clv === undefined ? "-" : fmtPct(r.validation_clv) },
          { label: "Validation Brier", value: r => r.validation_brier ?? "-" },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], (walkForwardBacktest.rows || []).length ? walkForwardBacktest.rows : [{
          walk_forward_status: "NO_RULES",
          rule_name: "Sin reglas evaluables",
          recommendation: walkForwardBacktest.recommendation || "Seguir acumulando."
        }]);
        $("realPilotSimulatorRecommendation").textContent = realPilotSimulator.recommendation || "Simulador cargado.";
        renderTable("realPilotSimulatorTable", [
          { label: "State", value: r => r.simulation_state || realPilotSimulator.simulation_state || "-" },
          { label: "Match", value: r => esc(r.match || "Sin candidatos frescos") },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Tier", value: r => r.candidate_tier || "-" },
          { label: "Odds", value: r => fmtOdds(r.entry_odds) },
          { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
          { label: "Sim Stake", value: r => r.simulated_stake_units === undefined ? realPilotSimulator.max_stake_per_pick_units + "u max" : r.simulated_stake_units + "u" },
          { label: "Daily Max", value: r => realPilotSimulator.max_daily_stake_units + "u" },
          { label: "Stop Loss", value: r => realPilotSimulator.stop_loss_units + "u" },
          { label: "Manual", value: r => (r.manual_confirmation_required ?? realPilotSimulator.manual_confirmation_required) ? "<span class='value'>required</span>" : "<span class='loss'>missing</span>" },
          { label: "Real Money", value: r => r.real_money_allowed ? "<span class='loss'>allowed</span>" : "<span class='value'>blocked</span>" },
          { label: "Recommendation", value: r => r.recommendation || realPilotSimulator.recommendation || "-" }
        ], (realPilotSimulator.rows || []).length ? realPilotSimulator.rows : [{
          simulation_state: realPilotSimulator.simulation_state,
          real_money_allowed: false,
          recommendation: realPilotSimulator.recommendation || "Sin simulacion activa."
        }]);
        $("confirmedPickChainRecommendation").textContent = confirmedPickChain.recommendation || "Confirmed Pick Chain cargado. Sigue Real Paper only.";
        $("cpcConfirmed").textContent = confirmedPickChain.bettable_paper_confirmed || 0;
        $("cpcIntel").textContent = confirmedPickChain.blocked_by_intelligence || 0;
        $("cpcHighEv").textContent = confirmedPickChain.blocked_by_high_ev || 0;
        $("cpcRisk").textContent = (confirmedPickChain.blocked_by_stale || 0) + (confirmedPickChain.blocked_by_duplicate || 0);
        renderTable("confirmedPickChainTable", [
          { label: "Final", value: r => r.final_chain_status === "CONFIRMED_PAPER" ? "<span class='value'>CONFIRMED_PAPER</span>" : (String(r.final_chain_status || "").includes("BLOCKED") || r.final_chain_status === "REJECT" ? "<span class='loss'>" + esc(r.final_chain_status || "-") + "</span>" : "<span class='warn'>" + esc(r.final_chain_status || "-") + "</span>") },
          { label: "Match", value: r => esc(r.match || matchLabel(r)) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Odds", value: r => fmtOdds(r.odds || r.entry_odds) },
          { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
          { label: "Provider", value: r => esc(r.provider || "-") + " (" + (r.provider_score ?? "-") + ")" },
          { label: "Freshness", value: r => r.freshness_status === "FRESH_LINE" ? "<span class='value'>FRESH_LINE</span>" : "<span class='loss'>" + esc(r.freshness_status || "-") + "</span>" },
          { label: "Duplicate", value: r => r.duplicate_status === "NO_DUPLICATE_EXPOSURE" ? "<span class='value'>clear</span>" : "<span class='loss'>" + esc(r.duplicate_status || "-") + "</span>" },
          { label: "High EV", value: r => String(r.high_ev_status || "").includes("REVIEW") ? "<span class='warn'>" + esc(r.high_ev_status || "-") + "</span>" : "<span class='badge'>" + esc(r.high_ev_status || "-") + "</span>" },
          { label: "Context", value: r => r.context_completeness_score === null || r.context_completeness_score === undefined ? "-" : "<span class='" + (Number(r.context_completeness_score) >= 81 ? "value" : Number(r.context_completeness_score) >= 61 ? "warn" : "loss") + "'>" + esc(r.context_completeness_score) + "/100</span>" },
          { label: "Tier", value: r => r.tier_classification === "FUERTE" ? "<span class='value'>FUERTE</span>" : (r.tier_classification === "REVISABLE" ? "<span class='warn'>REVISABLE</span>" : "<span class='badge'>" + esc(r.tier_classification || "-") + "</span>") },
          { label: "Lineup Base", value: r => String(r.lineup_projection_state || "").includes("PROJECTED") ? "<span class='warn'>" + esc(r.lineup_projection_state || "-") + "</span>" : esc(r.lineup_projection_state || "-") },
          { label: "Baseline", value: r => esc(r.lineup_baseline_status || "-") + " (" + esc(r.lineup_baseline_score ?? "-") + ")" },
          { label: "Matchup", value: r => esc(r.matchup_status || "-") },
          { label: "Intel", value: r => r.intelligence_status === "MATCHUP_CONTEXT_SUPPORTS" ? "<span class='value'>MATCHUP_CONTEXT_SUPPORTS</span>" : (r.intelligence_status === "BLOCK_CONFIRMATION" ? "<span class='loss'>BLOCK_CONFIRMATION</span>" : "<span class='warn'>" + esc(r.intelligence_status || "-") + "</span>") },
          { label: "Player", value: r => r.player_intelligence_status === "SUPPORTS_PICK" ? "<span class='value'>SUPPORTS_PICK</span>" : (r.player_intelligence_status === "BLOCK_CONFIRMATION" ? "<span class='loss'>BLOCK_CONFIRMATION</span>" : "<span class='warn'>" + esc(r.player_intelligence_status || "-") + "</span>") },
          { label: "Missing", value: r => (r.missing_context_fields || []).join(", ") || "none" },
          { label: "Blocks", value: r => (r.block_confirmation_reasons || []).join(", ") || "none" },
          { label: "Recommendation", value: r => esc(r.recommendation || "-") }
        ], (confirmedPickChain.rows || []).length ? confirmedPickChain.rows : [{
          final_chain_status: "SIN_CANDIDATOS",
          match: "No hay picks activos",
          missing_context_fields: [],
          block_confirmation_reasons: [],
          context_completeness_score: 0,
          tier_classification: "SIN_DATOS",
          lineup_projection_state: "NO_CONTEXT",
          recommendation: confirmedPickChain.recommendation || "Esperar candidato fresco."
        }]);
        $("timestampMismatchAuditRecommendation").textContent = timestampMismatchAudit.recommendation || "Timestamp audit cargado. Sigue review only.";
        $("tmaCount").textContent = timestampMismatchAudit.count || 0;
        $("tmaMismatch").textContent = timestampMismatchAudit.mismatch_count || 0;
        $("tmaSurvives").textContent = timestampMismatchAudit.ev_survives_refresh_count || 0;
        $("tmaBlocks").textContent = (timestampMismatchAudit.blocked_count || 0) > 0 ? "BLOCKED" : "CLEAR";
        renderTable("timestampMismatchAuditTable", [
          { label: "Audit", value: r => String(r.audit_status || "").includes("MISMATCH") || String(r.audit_status || "").includes("MISSING") ? "<span class='loss'>" + esc(r.audit_status || "-") + "</span>" : (String(r.audit_status || "").includes("SURVIVES") ? "<span class='warn'>" + esc(r.audit_status || "-") + "</span>" : "<span class='badge'>" + esc(r.audit_status || "-") + "</span>") },
          { label: "Match", value: r => esc((r.home_team_name || "Home") + " vs " + (r.away_team_name || "Away")) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Entry Odds", value: r => fmtOdds(r.entry_odds) },
          { label: "Latest Odds", value: r => fmtOdds(r.latest_odds) },
          { label: "Odds Gap", value: r => r.odds_gap_hours === null || r.odds_gap_hours === undefined ? "-" : r.odds_gap_hours + "h" },
          { label: "Model Gap", value: r => r.model_gap_hours === null || r.model_gap_hours === undefined ? "-" : r.model_gap_hours + "h" },
          { label: "Odds vs Model", value: r => r.odds_vs_model_hours === null || r.odds_vs_model_hours === undefined ? "-" : r.odds_vs_model_hours + "h" },
          { label: "EV Original", value: r => r.ev_original === null || r.ev_original === undefined ? "-" : fmtPct(r.ev_original) },
          { label: "EV Odds Fresh", value: r => r.ev_odds_refreshed === null || r.ev_odds_refreshed === undefined ? "-" : fmtPct(r.ev_odds_refreshed) },
          { label: "EV Full Fresh", value: r => r.ev_fully_refreshed === null || r.ev_fully_refreshed === undefined ? "-" : fmtPct(r.ev_fully_refreshed) },
          { label: "Blocks", value: r => r.blocks_confirmation ? "<span class='warn'>yes</span>" : "<span class='value'>no</span>" },
          { label: "Recommendation", value: r => esc(r.recommendation || "-") }
        ], (timestampMismatchAudit.rows || []).length ? timestampMismatchAudit.rows : [{
          audit_status: "SIN PICKS ACTIVOS",
          home_team_name: "No hay picks abiertos",
          away_team_name: "-",
          blocks_confirmation: false,
          recommendation: timestampMismatchAudit.recommendation || "Esperar siguiente ciclo."
        }]);
        renderSportsLiveBoard(matchCenter && matchCenter.system_status ? matchCenter : sportsLiveBoard);
        renderPicksToFollow(bestBetsPerMatch);
        renderBestBetsPerMatch(bestBetsPerMatch, nearStartContextStatus);
        renderNextOperationalAction(operationalWindowQueue);
        renderBottleneckBySource(bottleneckBySource);
        renderClosingWindowWatch(closingWindowWatch);
        renderClosingCaptureDraft(closingCaptureDraft);
        renderSourceCaptureAssistant(sourceCaptureAssistant);
        renderOddsSnapshotCache(oddsSnapshotCache);
        renderCleanChainProgress(cleanSampleQueue, oddsSnapshotCache, realPaper);
        renderCleanSampleQueue(cleanSampleQueue);
        renderShadowTicketChain(shadowTicketChain);
        renderOperationalWindowQueue(operationalWindowQueue);
        renderOperationalAlerts(operationalAlerts);
        renderSourceCaptureQueue(bottleneckBySource);
        renderManualVerifiedSourceCaptures(manualVerifiedSourceCaptures);
        renderCandidatePreflight(candidatePreflightQueue);
        renderMatchPreflightQueue(matchPreflightQueue);
        renderFootballOwnedFairOdds(footballOwnedFairOddsBridge);
        renderFootballShadowSegments(footballShadowSegments);
        renderCommandCenter(commandCenter);
        renderMlbNoBetSummary(commandCenter, pickDecisions, noBetIntelligence);
        renderMlbContextWatch(playerIntelligence, intelligenceScout);
        renderPendingSettlementMonitor(pendingSettlement);
        renderFootballCommandCenter(footballCommandCenter);
        renderFootballCompetitionRegistry(footballCompetitionRegistry);
        renderFootballTodayUniverse(effectiveFootballTodayUniverse);
        renderFootballReadinessGate(footballReadinessGate);
        renderFootballDataGateway(footballDataGateway);
        renderSportsIntelligenceCore(sportsIntelligenceCore);
        renderExpectedLineupEngine(expectedLineupEngine);
        renderFootballIntelligence({
          trustScores: footballLeagueTrustScores,
          teamIntel: footballTeamIntelligence,
          playerIntel: footballPlayerIntelligence,
          confirmedChain: footballConfirmedPickChain
        });
        renderFootballMarketLab(footballMarketLab);
        renderFootballPendingSettlementMonitor(footballPendingSettlement);
        renderFootballFeedQualityReport(footballFeedQuality);
        renderDashboardStatusBar({
          commandCenter,
          closingWindowWatch,
          operationalWindowQueue,
          sourceCaptureAssistant,
          manualVerifiedSourceCaptures,
          oddsSnapshotCache,
          bestBetsPerMatch
        });

        const normalizedHealth = {
          ...health,
          counts: {
            total_picks: 0,
            real_candidate: 0,
            real_paper_candidate: 0,
            radar_only: 0,
            review: 0,
            no_bet: 0,
            processed_true: 0,
            processed_false: 0,
            ...(health.counts || {})
          },
          providers: {
            real_active: 0,
            shadow_active: 0,
            real: [],
            shadow: [],
            ...(health.providers || {})
          },
          latest: health.latest || {},
          review_types: health.review_types || []
        };
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
        ], [normalizedHealth]);

        renderTable("internalOddsHub", [
          { label: "Provider", value: r => providerDisplay(r) },
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
          { label: "Provider", value: r => providerDisplay(r) },
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
        renderTable("clvLab", clvColumns, (clvLab.rows || []).filter(hasMeaningfulClvRow));

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
          { label: "Status", value: r => {
            const status = String(r.status || "-");
            if (status.includes("CONFIRMED")) return "<span class='value'>" + esc(status) + "</span>";
            if (status === "CALIBRATING" || status.includes("WAITING") || status.includes("CONTEXT")) return "<span class='warn'>" + esc(status) + "</span>";
            if (status.includes("NO_BET") || status.includes("POST_KICKOFF")) return "<span class='loss'>" + esc(status) + "</span>";
            return "<span class='badge'>" + esc(status) + "</span>";
          } },
          { label: "Match", value: r => matchLabel(r) },
          { label: "Grade", value: r => {
            const grade = String(r.model_confidence_grade || r.grade || "-");
            if (grade === "A" || grade === "B") return "<span class='value'>" + esc(grade) + "</span>";
            if (grade === "C" || grade === "D") return "<span class='warn'>" + esc(grade) + "</span>";
            return "<span class='loss'>" + esc(grade) + "</span>";
          } },
          { label: "Conf", value: r => (r.model_confidence_score ?? "-") + "/100" },
          { label: "Market", value: r => marketLabel(r.market || r.market_type) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Provider", value: r => r.provider || "-" },
          { label: "Model Prob", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
          { label: "Fair", value: r => fmtOdds(r.fair_odds) },
          { label: "Odds", value: r => fmtOdds(r.odds) },
          { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
          { label: "Complete", value: r => (r.overall_completeness ?? "-") + "%" },
          { label: "Context", value: r => (r.context_completeness ?? "-") + "%" },
          { label: "Lineup", value: r => (r.lineup_completeness ?? "-") + "%" },
          { label: "Closing", value: r => esc(r.closing_quality || "MISSING") + " / " + (r.closing_completeness ?? 0) + "%" },
          { label: "Segment", value: r => esc(r.primary_segment || "-") },
          { label: "Seg N", value: r => (r.segment_closed ?? 0) + " closed" },
          { label: "Seg CLV", value: r => r.segment_clv_avg === null || r.segment_clv_avg === undefined ? "-" : fmtPct(r.segment_clv_avg) },
          { label: "Seg Brier", value: r => esc(r.segment_brier_display || (r.segment_brier === null || r.segment_brier === undefined ? "-" : r.segment_brier)) },
          { label: "Seg LogLoss", value: r => esc(r.segment_log_loss_display || (r.segment_log_loss === null || r.segment_log_loss === undefined ? "-" : r.segment_log_loss)) },
          { label: "Seg ROI CI", value: r => r.segment_roi_ci_95_low === null || r.segment_roi_ci_95_low === undefined ? "-" : (r.segment_roi_ci_95_low + " .. " + r.segment_roi_ci_95_high) },
          { label: "Metric gate", value: r => esc(r.segment_metric_sample_status || "-") },
          { label: "DC ready", value: r => esc(r.dixon_coles_readiness || "-") },
          { label: "Block", value: r => esc(r.blocking_level || r.decision_rule || "-") },
          { label: "Why No", value: r => (r.why_no || []).slice(0, 3).map(esc).join(", ") || "-" },
          { label: "Next", value: r => esc(r.next_action || "-") }
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
        renderTable("closingSupportedEdge", [
          { label: "Status", value: r => r.audit_status === "PAPER_PRIORITY" ? "<span class='value'>PAPER_PRIORITY</span>" : (String(r.audit_status || "").includes("REVIEW") ? "<span class='warn'>" + (r.audit_status || "-") + "</span>" : "<span class='badge'>" + (r.audit_status || "-") + "</span>") },
          { label: "Rule", value: r => r.rule_name || r.rule_key || "-" },
          { label: "Closed", value: r => r.closed || 0 },
          { label: "W/L", value: r => (r.wins || 0) + "/" + (r.losses || 0) },
          { label: "Win Rate", value: r => r.win_rate === null || r.win_rate === undefined ? "-" : fmtPct(r.win_rate) },
          { label: "Profit", value: r => (r.profit_units || 0) + "u" },
          { label: "CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "CLV+", value: r => r.clv_positive_rate === null || r.clv_positive_rate === undefined ? "-" : fmtPct(r.clv_positive_rate) },
          { label: "Same Close", value: r => r.same_close_rate === null || r.same_close_rate === undefined ? "-" : fmtPct(r.same_close_rate) },
          { label: "Issue Rate", value: r => r.closing_issue_rate === null || r.closing_issue_rate === undefined ? "-" : fmtPct(r.closing_issue_rate) },
          { label: "Supported", value: r => r.closing_supported_count || 0 },
          { label: "Score", value: r => r.closing_edge_score ?? "-" },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], (closingSupportedEdge.rows || []).length ? closingSupportedEdge.rows : [{
          audit_status: "SIN REGLAS",
          rule_name: "Sin muestra suficiente",
          recommendation: closingSupportedEdge.recommendation || "Seguir acumulando"
        }]);
        renderTable("extremeEvClosingAudit", [
          { label: "EV Bucket", value: r => r.ev_bucket || "-" },
          { label: "Closing Quality", value: r => r.closing_quality_bucket || "-" },
          { label: "Closed", value: r => r.closed || 0 },
          { label: "W/L", value: r => (r.wins || 0) + "/" + (r.losses || 0) },
          { label: "Profit", value: r => (r.profit_units || 0) + "u" },
          { label: "CLV", value: r => r.avg_clv === null || r.avg_clv === undefined ? "-" : fmtPct(r.avg_clv) },
          { label: "CLV+", value: r => r.clv_positive_rate === null || r.clv_positive_rate === undefined ? "-" : fmtPct(r.clv_positive_rate) },
          { label: "Same Close", value: r => r.same_close_rate === null || r.same_close_rate === undefined ? "-" : fmtPct(r.same_close_rate) },
          { label: "Avg Entry", value: r => fmtOdds(r.avg_entry_odds) },
          { label: "Avg Closing", value: r => fmtOdds(r.avg_closing_odds) },
          { label: "Audit", value: r => String(r.audit_status || "").includes("SUPPORTS") ? "<span class='value'>" + (r.audit_status || "-") + "</span>" : (String(r.audit_status || "").includes("REVIEW") ? "<span class='warn'>" + (r.audit_status || "-") + "</span>" : "<span class='badge'>" + (r.audit_status || "-") + "</span>") },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], (extremeEvClosingAudit.summary || []).length ? extremeEvClosingAudit.summary : [{
          ev_bucket: "SIN MUESTRA",
          closing_quality_bucket: "-",
          closed: 0,
          recommendation: extremeEvClosingAudit.recommendation || "Esperar mas cierres Real Paper"
        }]);
        renderTable("extremeEvClosingDetails", [
          { label: "Audit", value: r => String(r.audit_status || "").includes("SUPPORTS") ? "<span class='value'>" + (r.audit_status || "-") + "</span>" : "<span class='warn'>" + (r.audit_status || "-") + "</span>" },
          { label: "Match", value: r => matchLabel(r) },
          { label: "Pick", value: r => pickLabel(r.pick) },
          { label: "Book", value: r => r.bookmaker || "-" },
          { label: "Status", value: r => r.status || "-" },
          { label: "Entry", value: r => fmtOdds(r.entry_odds) },
          { label: "Closing", value: r => fmtOdds(r.closing_odds) },
          { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
          { label: "Model Prob", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
          { label: "CLV", value: r => r.clv === null || r.clv === undefined ? "-" : fmtPct(r.clv) },
          { label: "Profit", value: r => (r.profit_loss || 0) + "u" },
          { label: "Bucket", value: r => r.ev_bucket || "-" },
          { label: "Recommendation", value: r => r.recommendation || "-" }
        ], (extremeEvClosingAudit.rows || []).length ? extremeEvClosingAudit.rows : [{
          audit_status: "SIN ALERTAS",
          home_team_name: "No hay EV alto cerrado para revisar",
          away_team_name: "-",
          recommendation: extremeEvClosingAudit.recommendation || "-"
        }]);
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
        $("teamIntelligenceRecommendation").textContent = (teamIntelligence.recommendation || "Team Intelligence solo lectura.") + " " + (teamIntelligence.next_expansion || "");
        renderTable("teamIntelligenceTable", [
          { label: "Context", value: r => r.intelligence_status === "MATCHUP_CONTEXT_SUPPORTS" ? "<span class='value'>MATCHUP_CONTEXT_SUPPORTS</span>" : (r.intelligence_status === "CONTEXT_GAPS" || r.intelligence_status === "MATCHUP_CONTEXT_CONFLICT" ? "<span class='loss'>" + (r.intelligence_status || "-") + "</span>" : "<span class='warn'>" + (r.intelligence_status || "-") + "</span>") },
          { label: "Score", value: r => r.team_matchup_score ?? "-" },
          { label: "Complete", value: r => r.context_completeness_score === null || r.context_completeness_score === undefined ? "-" : r.context_completeness_score + "%" },
          { label: "Match", value: r => esc(r.match || matchLabel(r)) },
          { label: "Pick Team", value: r => esc(r.picked_team_name || pickLabel(r.pick)) },
          { label: "Odds", value: r => fmtOdds(r.entry_odds) },
          { label: "EV", value: r => r.expected_value === null || r.expected_value === undefined ? "-" : fmtPct(r.expected_value) },
          { label: "Model Prob", value: r => r.model_probability === null || r.model_probability === undefined ? "-" : fmtPct(r.model_probability) },
          { label: "Feature Source", value: r => esc(r.feature_source || "-") },
          { label: "Feature At", value: r => fmtDateTime(r.feature_generated_at) },
          { label: "Contexts", value: r => (r.feature_context_summary || []).join(", ") || "none" },
          { label: "Recent Form", value: r => (r.picked_recent_wins || 0) + "-" + (r.picked_recent_losses || 0) + " vs opp " + (r.opponent_recent_wins || 0) + "-" + (r.opponent_recent_losses || 0) },
          { label: "Form Edge", value: r => r.form_edge === null || r.form_edge === undefined ? "-" : fmtPct(r.form_edge) },
          { label: "Team RP W/L", value: r => (r.picked_real_paper_wins || 0) + "/" + (r.picked_real_paper_losses || 0) + " (" + (r.picked_real_paper_closed || 0) + ")" },
          { label: "Team RP Profit", value: r => (r.picked_real_paper_profit || 0) + "u" },
          { label: "Team RP CLV", value: r => r.picked_real_paper_clv === null || r.picked_real_paper_clv === undefined ? "-" : fmtPct(r.picked_real_paper_clv) },
          { label: "Missing", value: r => (r.missing_context || []).join(", ") || "none" },
          { label: "Recommendation", value: r => esc(r.recommendation || "-") }
        ], (teamIntelligence.rows || []).length ? teamIntelligence.rows : [{
          intelligence_status: "SIN PICKS ABIERTOS",
          team_matchup_score: "-",
          context_completeness_score: 0,
          match: "No hay MLB Moneyline abiertos",
          picked_team_name: "-",
          missing_context: [],
          recommendation: teamIntelligence.recommendation || "Esperar siguiente ciclo Real Paper."
        }]);
        $("intelligenceScoutRecommendation").textContent = (intelligenceScout.recommendation || "Intelligence Scout solo lectura.") + " Supports: " + (intelligenceScout.support_count || 0) + " | Conflicts: " + (intelligenceScout.conflict_count || 0) + " | Blocks: " + (intelligenceScout.block_count || 0);
        renderTable("intelligenceScoutTable", [
          { label: "Impact", value: r => r.impact === "BLOCKS_CONFIRMATION" ? "<span class='loss'>BLOCKS</span>" : (r.impact === "CONFLICTS_PICK" ? "<span class='warn'>CONFLICT</span>" : (r.impact === "SUPPORTS_PICK" || r.impact === "WEAK_SUPPORT" ? "<span class='value'>" + esc(r.impact || "-") + "</span>" : "<span class='badge'>" + esc(r.impact || "-") + "</span>")) },
          { label: "Signal", value: r => esc(r.signal_type || "-") },
          { label: "Severity", value: r => r.severity === "high" || r.severity === "critical" ? "<span class='loss'>" + esc(r.severity || "-") + "</span>" : (r.severity === "medium" ? "<span class='warn'>medium</span>" : "<span class='badge'>" + esc(r.severity || "info") + "</span>") },
          { label: "Confidence", value: r => r.confidence === null || r.confidence === undefined ? "-" : fmtPct(r.confidence) },
          { label: "Match", value: r => esc(r.match || matchLabel(r)) },
          { label: "Team", value: r => esc(r.team_name || "-") },
          { label: "Player", value: r => esc(r.player_name || "-") },
          { label: "Source", value: r => esc(r.source || "-") },
          { label: "Observed", value: r => fmtDateTime(r.observed_at) },
          { label: "Recommendation", value: r => esc(r.recommendation || "-") }
        ], (intelligenceScout.rows || []).length ? intelligenceScout.rows : [{
          impact: "NEUTRAL",
          signal_type: "SIN_SENALES",
          severity: "info",
          match: "Sin señales activas",
          recommendation: intelligenceScout.recommendation || "Esperar datos de jugadores/contexto."
        }]);
        $("playerIntelligenceRecommendation").textContent = playerIntelligence.recommendation || "Player Intelligence solo lectura.";
        renderTable("playerIntelligenceTable", [
          { label: "Status", value: r => r.player_intelligence_status === "BLOCK_CONFIRMATION" ? "<span class='loss'>BLOCK_CONFIRMATION</span>" : (r.player_intelligence_status === "MANUAL_REVIEW" ? "<span class='warn'>MANUAL_REVIEW</span>" : (r.player_intelligence_status === "SUPPORTS_PICK" ? "<span class='value'>SUPPORTS_PICK</span>" : "<span class='badge'>" + esc(r.player_intelligence_status || "-") + "</span>")) },
          { label: "Impact", value: r => r.impact_score ?? 0 },
          { label: "Match", value: r => esc(r.match || matchLabel(r)) },
          { label: "Team", value: r => esc(r.team_name || "-") },
          { label: "Player", value: r => esc(r.player_name || "-") },
          { label: "Position", value: r => esc(r.position || "-") },
          { label: "Role", value: r => esc(r.role_importance || "-") },
          { label: "Availability", value: r => esc(r.status || "-") },
          { label: "Source", value: r => esc(r.source || "-") },
          { label: "Observed", value: r => fmtDateTime(r.observed_at) },
          { label: "Recommendation", value: r => esc(r.scout_recommendation || "-") }
        ], (playerIntelligence.rows || []).length ? playerIntelligence.rows : [{
          player_intelligence_status: "NEUTRAL",
          match: "Sin jugadores activos",
          recommendation: playerIntelligence.recommendation || "Esperar datos de jugadores."
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
        ], (marketPromotion.rows || []).filter(hasMeaningfulPromotionRow));

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
          { label: "Total", value: r => ((r.totals || {}).total ?? r.total ?? 0) },
          { label: "Cerradas", value: r => ((r.totals || {}).closed ?? r.closed ?? 0) },
          { label: "Wins", value: r => ((r.totals || {}).wins ?? r.wins ?? 0) },
          { label: "Losses", value: r => ((r.totals || {}).losses ?? r.losses ?? 0) },
          { label: "Win Rate", value: r => ((r.totals || {}).win_rate ?? r.win_rate) === null || ((r.totals || {}).win_rate ?? r.win_rate) === undefined ? "-" : fmtPct((r.totals || {}).win_rate ?? r.win_rate) },
          { label: "Open", value: r => ((r.totals || {}).open ?? r.open ?? 0) },
          { label: "Pending Closing", value: r => ((r.totals || {}).pending_closing ?? r.pending_closing ?? 0) },
          { label: "Pending Results", value: r => ((r.totals || {}).pending_results ?? r.pending_results ?? 0) },
          { label: "Profit", value: r => (((r.totals || {}).profit_units ?? r.profit_units ?? 0) || 0) + "u" },
          { label: "Guardrails", value: r => "Kelly: off | Real money: off | Telegram auto: off" }
        ], [portfolio || { totals: {} }]);

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
          { label: "Acción", value: r => "<span class='action'>" + actionText(r) + "</span>" },
          { label: "Match", value: r => matchLabel(r) },
          { label: "Sport", value: r => r.sport_slug + "/" + r.league_slug },
          { label: "Mercado", value: r => marketLabel(r.market_type) },
          { label: "Línea", value: r => r.line === null || r.line === undefined ? "-" : Number(r.line).toFixed(1) },
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
          { label: "Acción", value: r => "<span class='action'>" + actionText(r) + "</span>" },
          { label: "Match", value: r => matchLabel(r) },
          { label: "Model", value: r => r.model_name },
          { label: "Provider", value: r => r.provider_name },
          { label: "Mercado", value: r => marketLabel(r.market_type) },
          { label: "Línea", value: r => r.line === null || r.line === undefined ? "-" : Number(r.line).toFixed(1) },
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
          { label: "Línea", value: r => r.line === null || r.line === undefined ? "-" : Number(r.line).toFixed(1) },
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

        const normalizedPaper = {
          ...paper,
          banco_control_actual_mxn: paper.banco_control_actual_mxn || 0,
          balance_neto_mxn: paper.balance_neto_mxn || 0,
          auditoria: {
            roi_percentage: 0,
            yield_percentage: 0,
            total_picks: 0,
            ...(paper.auditoria || {})
          }
        };
        renderTable("paper", [
          { label: "Banco", value: r => r.banco_control_actual_mxn },
          { label: "Balance", value: r => r.balance_neto_mxn },
          { label: "ROI", value: r => r.auditoria.roi_percentage + "%" },
          { label: "Yield", value: r => r.auditoria.yield_percentage + "%" },
          { label: "Picks", value: r => r.auditoria.total_picks }
        ], [normalizedPaper]);

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
          { label: "Siguiente expansión", value: r => r.next },
          { label: "Nota", value: r => r.note }
        ], [
          { sport: "Fútbol", ready: "1X2, DNB, Doble oportunidad, Over/Under 2.5, BTTS manual", next: "Hándicap asiático, descanso/final, marcador correcto", note: "Doble oportunidad queda en Shadow Paper; BTTS sigue bloqueado salvo revisión manual." },
          { sport: "MLB", ready: "Moneyline 2 vías, total carreras. Run line solo diagnóstico.", next: "Run line real con enable_real_runline=true, team totals, pitcher props", note: "Run line real queda bloqueado por defecto hasta revisión manual." },
          { sport: "NBA", ready: "Moneyline 2 vías", next: "Spread, total puntos, team totals, player props", note: "Requiere margen proyectado y pace/eficiencia." },
          { sport: "Tenis", ready: "Pendiente", next: "Ganador partido, hándicap games/sets, total games, correct score", note: "Primero hay que crear fetcher y engine 2 vías." }
        ]);

        $("status").textContent = "OK " + new Date().toLocaleTimeString();
      } catch (err) {
        const msg = err.message || "";
        $("status").textContent = msg.includes("401")
          ? "Error 401: pega la X-Internal-API-Key correcta, guarda y actualiza."
          : "Error: " + msg;
      }
    }
    const dateInput = $("matchCenterDate");
    if (dateInput && !dateInput.value) dateInput.value = localDateInputValue();
    const todayButton = $("matchCenterToday");
    if (todayButton) todayButton.addEventListener("click", () => { setMatchCenterDate(0); load(); });
    const tomorrowButton = $("matchCenterTomorrow");
    if (tomorrowButton) tomorrowButton.addEventListener("click", () => { setMatchCenterDate(1); load(); });
    if (dateInput) dateInput.addEventListener("change", () => load());
    load();
  </script>
</body>
</html>`;

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/dashboard/trading", async (_request, reply) => {
    return reply.header("content-type", "text/html; charset=utf-8").send(dashboardHtml);
  });
}




