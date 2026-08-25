import { tradingLocalDate, tradingLocalDateWindow } from "./timezone.js";
import { normalizeSportForFilter } from "./sport-taxonomy.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type ChainQuery = {
  date?: string;
  sport?: string;
  limit?: number;
};

function localDate(date?: string) {
  return date || tradingLocalDate();
}

function decisionForRow(row: Record<string, any>) {
  if (row.ticket_status === "WIN" || row.ticket_status === "LOSS" || row.ticket_status === "PUSH" || row.ticket_status === "VOID") return "SETTLED_AUDIT";
  if (row.closing_quality === "CAPTURED_ON_TIME" && row.final_score_known) return "READY_FOR_SETTLEMENT";
  if (row.closing_quality === "CAPTURED_ON_TIME") return "WAITING_RESULT";
  if (row.closing_snapshot_id && row.closing_quality !== "CAPTURED_ON_TIME") return "CLOSING_QUALITY_REVIEW";
  if (row.entry_snapshot_safe_for_entry && !row.closing_snapshot_id) return "WAITING_VALID_CLOSING";
  if (row.entry_snapshot_id && !row.entry_snapshot_safe_for_entry) return "ENTRY_AUDIT_ONLY";
  return "MISSING_ENTRY_OR_CLOSING";
}

function nextActionForDecision(decision: string) {
  if (decision === "READY_FOR_SETTLEMENT") return "Cargar resultado verificado y correr settlement seguro.";
  if (decision === "WAITING_RESULT") return "Esperar marcador final verificado; no settlement antes de FINAL/FT.";
  if (decision === "CLOSING_QUALITY_REVIEW") return "No usar CLV formal; recapturar closing en proxima ventana valida.";
  if (decision === "WAITING_VALID_CLOSING") return "Esperar CAPTURE_CLOSING_NOW y capturar closing con evidencia.";
  if (decision === "ENTRY_AUDIT_ONLY") return "Recapturar entry/current antes del kickoff con fuente vigente.";
  if (decision === "SETTLED_AUDIT") return "Revisar CLV/segmento; sigue sin dinero real.";
  return "Ligar cuota entry/current y closing con odds_snapshot_cache.";
}

export async function getShadowTicketChain(db: Queryable, input: ChainQuery = {}) {
  const date = localDate(input.date);
  const window = tradingLocalDateWindow(date);
  const sport = normalizeSportForFilter(input.sport);
  const limit = Math.max(1, Math.min(300, Number(input.limit || 120)));
  const result = await db.query(
    `
      SELECT
        pt.id AS ticket_id,
        pt.match_id,
        CASE
          WHEN l.slug IN ('mlb', 'baseball/mlb') THEN 'baseball'
          WHEN l.slug = 'nba' THEN 'basketball'
          WHEN l.slug = 'nfl' OR s.slug = 'american-football' THEN 'american_football'
          WHEN l.slug LIKE '%world-cup%' OR s.slug = 'soccer' THEN 'soccer'
          ELSE s.slug
        END AS sport,
        pt.league_slug AS league,
        CONCAT(away_team.name, ' @ ', home_team.name) AS match,
        m.match_date AS kickoff,
        m.status AS match_status,
        (m.status IN ('finished', 'cancelled', 'postponed') OR m.home_score IS NOT NULL OR m.away_score IS NOT NULL) AS final_score_known,
        pt.league_type,
        pt.market_type AS market,
        pt.selection,
        pt.status AS ticket_status,
        pt.market_odds AS ticket_entry_odds,
        pt.model_probability,
        pt.expected_value,
        pt.net_profit,
        pt.raw_data->>'model_label' AS model_label,
        pt.raw_data->>'decision' AS bridge_decision,
        pt.raw_data->>'closing_quality' AS closing_quality,
        pt.raw_data->>'clv_band' AS clv_band,
        CASE
          WHEN pt.raw_data->>'closing_quality' = 'CAPTURED_ON_TIME'
            AND NULLIF(pt.raw_data->>'clv', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN (pt.raw_data->>'clv')::numeric
          ELSE NULL
        END AS clv,
        entry_os.id AS entry_snapshot_id,
        entry_os.odds AS entry_snapshot_odds,
        entry_os.bookmaker AS entry_bookmaker,
        entry_os.captured_at AS entry_captured_at,
        COALESCE(entry_os.raw_data->>'snapshot_type', entry_os.snapshot_role) AS entry_snapshot_type,
        entry_os.raw_data->>'stale_status' AS entry_stale_status,
        COALESCE((entry_os.raw_data->>'safe_for_entry')::boolean, false) AS entry_snapshot_safe_for_entry,
        COALESCE((entry_os.raw_data->>'audit_only')::boolean, false) AS entry_audit_only,
        entry_os.raw_data->>'evidence_id' AS entry_evidence_id,
        entry_os.raw_data->>'screenshot_sha256' AS entry_screenshot_sha256,
        closing_os.id AS closing_snapshot_id,
        closing_os.odds AS closing_snapshot_odds,
        closing_os.bookmaker AS closing_bookmaker,
        closing_os.captured_at AS closing_captured_at,
        COALESCE(closing_os.raw_data->>'snapshot_type', closing_os.snapshot_role) AS closing_snapshot_type,
        closing_os.raw_data->>'window_status' AS closing_window_status,
        COALESCE((closing_os.raw_data->>'safe_for_closing')::boolean, false) AS closing_snapshot_safe_for_closing,
        COALESCE((closing_os.raw_data->>'audit_only')::boolean, false) AS closing_audit_only,
        closing_os.raw_data->>'evidence_id' AS closing_evidence_id,
        closing_os.raw_data->>'screenshot_sha256' AS closing_screenshot_sha256
      FROM paper_trades pt
      JOIN v_valid_matches m ON m.id = pt.match_id
      JOIN leagues l ON l.id = m.league_id
      JOIN sports s ON s.id = l.sport_id
      LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
      LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
      LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
      LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
      LEFT JOIN LATERAL (
        SELECT os.*
        FROM odds_snapshots os
        WHERE os.match_id = pt.match_id
          AND os.market_type = pt.market_type
          AND os.selection = pt.selection
          AND COALESCE(os.raw_data->>'snapshot_type', os.snapshot_role) IN ('entry', 'current', 'market')
        ORDER BY
          COALESCE((os.raw_data->>'safe_for_entry')::boolean, false) DESC,
          os.captured_at DESC
        LIMIT 1
      ) entry_os ON TRUE
      LEFT JOIN LATERAL (
        SELECT os.*
        FROM odds_snapshots os
        WHERE os.match_id = pt.match_id
          AND os.market_type = pt.market_type
          AND os.selection = pt.selection
          AND COALESCE(os.raw_data->>'snapshot_type', os.snapshot_role) = 'closing'
        ORDER BY
          COALESCE((os.raw_data->>'safe_for_closing')::boolean, false) DESC,
          os.captured_at DESC
        LIMIT 1
      ) closing_os ON TRUE
      WHERE pt.created_at >= $1::timestamptz
        AND pt.created_at < $2::timestamptz
        AND pt.league_type IN ('football_shadow', 'shadow_paper', 'real_paper')
        AND ($3 = 'all' OR CASE
          WHEN l.slug IN ('mlb', 'baseball/mlb') THEN 'baseball'
          WHEN l.slug = 'nba' THEN 'basketball'
          WHEN l.slug = 'nfl' OR s.slug = 'american-football' THEN 'american_football'
          WHEN l.slug LIKE '%world-cup%' OR s.slug = 'soccer' THEN 'soccer'
          ELSE s.slug
        END = $3)
      ORDER BY
        CASE
          WHEN pt.league_type = 'football_shadow' AND pt.status = 'PENDING' THEN 0
          WHEN pt.status = 'PENDING' THEN 1
          ELSE 2
        END,
        m.match_date,
        pt.expected_value DESC
      LIMIT $4;
    `,
    [window.start, window.end, sport, limit]
  );

  const rows = result.rows.map((row) => {
    const chainDecision = decisionForRow(row);
    return {
      ...row,
      chain_decision: chainDecision,
      next_action: nextActionForDecision(chainDecision),
      no_real_money: true,
      auto_post_allowed: false
    };
  });
  const count = (decision: string) => rows.filter((row) => row.chain_decision === decision).length;
  return {
    system_status: "SHADOW_TICKET_CHAIN_SAFE_V1",
    date,
    sport,
    scanned: rows.length,
    waiting_valid_closing: count("WAITING_VALID_CLOSING"),
    ready_for_settlement: count("READY_FOR_SETTLEMENT"),
    waiting_result: count("WAITING_RESULT"),
    closing_quality_review: count("CLOSING_QUALITY_REVIEW"),
    settled_audit: count("SETTLED_AUDIT"),
    rows,
    recommendation: "Cadena ticket -> entry snapshot -> closing snapshot -> evidencia -> CLV. Solo lectura; no crea picks ni settlement.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      auto_post_allowed: false,
      picks_created: 0,
      parlays_created: 0,
      kill_switch_enabled: true
    }
  };
}
