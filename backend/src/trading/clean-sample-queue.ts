import { tradingLocalDate, tradingLocalDateWindow } from "./timezone.js";
import { normalizeSportForFilter } from "./sport-taxonomy.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type QueueQuery = {
  date?: string;
  sport?: string;
  limit?: number;
};

const FOOTBALL_FOCUS_LEAGUES = new Set([
  "uefa-champions-league",
  "europa-league",
  "conference-league",
  "england-league-cup",
  "mls",
  "liga-mx",
  "brasileirao-serie-a",
  "brasileirao-serie-b"
]);

function localDate(date?: string) {
  return date || tradingLocalDate();
}

function numeric(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function minutesUntil(kickoff: unknown) {
  const date = new Date(String(kickoff || ""));
  if (Number.isNaN(date.getTime())) return null;
  return Math.round((date.getTime() - Date.now()) / 60000);
}

function inWindow(minutes: number | null, start: number, end: number) {
  return minutes !== null && minutes <= start && minutes >= end;
}

function isLikelyPlaceholderKickoff(row: Record<string, any>) {
  const kickoff = new Date(String(row.kickoff || ""));
  const sourceMatchId = String(row.source_match_id || "").toLowerCase();
  if (Number.isNaN(kickoff.getTime())) return true;
  if (row.sport === "baseball" && row.league === "mlb" && row.status === "scheduled") {
    return kickoff.getUTCHours() === 12
      && kickoff.getUTCMinutes() === 0
      && sourceMatchId.startsWith("espn-mlb-");
  }
  return false;
}

const safeJsonBooleanSql = (expression: string) => `
  CASE
    WHEN (${expression}) IN ('true', 'false') THEN (${expression})::boolean
    ELSE false
  END
`;

function focusScore(row: Record<string, any>) {
  let score = 0;
  if (row.sport === "soccer" && FOOTBALL_FOCUS_LEAGUES.has(String(row.league))) score += 45;
  if (row.sport === "baseball" && String(row.league) === "mlb") score += 45;
  if (row.model_quote_id) score += 15;
  if (row.market_quote_id || row.entry_snapshot_id) score += 15;
  if (row.ticket_id) score += 15;
  if (row.closing_snapshot_safe_for_closing) score += 10;
  if (row.status === "scheduled") score += 10;
  if (row.fixture_time_unverified) score -= 20;
  if (row.minutes_until_start !== null && row.minutes_until_start > 0 && row.minutes_until_start <= 360) score += 10;
  if (row.minutes_until_start !== null && row.minutes_until_start <= 0) score -= 35;
  return score;
}

function actionForRow(row: Record<string, any>) {
  const minutes = numeric(row.minutes_until_start);
  const sport = String(row.sport || "");
  const hasEntry = Boolean(row.entry_snapshot_safe_for_entry && row.entry_evidence_id && row.entry_screenshot_sha256);
  const hasTicket = Boolean(row.ticket_id);
  const hasClosing = Boolean(
    row.closing_snapshot_safe_for_closing
    && row.closing_quality === "CAPTURED_ON_TIME"
    && row.closing_evidence_id
    && row.closing_screenshot_sha256
  );

  if (row.fixture_time_unverified) return "FIXTURE_TIME_UNVERIFIED";
  if (minutes !== null && minutes <= 0) return "POST_KICKOFF_AUDIT_ONLY";
  if (!row.model_quote_id) return sport === "soccer" ? "GENERATE_OWNED_FAIR_ODDS" : "GENERATE_MODEL_FAIR_ODDS";
  if (!hasEntry) return "CAPTURE_ENTRY_CURRENT_ODDS";
  if (!hasTicket) return sport === "soccer" ? "RUN_BRIDGE_REGISTER_SHADOW" : "REGISTER_PAPER_SHADOW_TICKET";
  if (sport === "baseball" && (inWindow(minutes, 90, 60) || inWindow(minutes, 45, 20))) return "RUN_NEAR_START_NOW";
  if (sport === "soccer" && inWindow(minutes, 60, 30)) return "CAPTURE_LINEUP_GOALKEEPER_NOW";
  if (inWindow(minutes, 10, 3)) return "CAPTURE_CLOSING_NOW";
  if (!hasClosing) return "WAITING_VALID_CLOSING";
  if (hasClosing && row.status !== "finished") return "WAITING_RESULT";
  return "READY_FOR_SETTLEMENT";
}

function nextStepForAction(action: string) {
  if (action === "GENERATE_OWNED_FAIR_ODDS") return "Correr fair odds antes del kickoff; no aplicar post-kickoff.";
  if (action === "GENERATE_MODEL_FAIR_ODDS") return "Generar modelo/fair odds para MLB antes de near-start.";
  if (action === "FIXTURE_TIME_UNVERIFIED") return "Refrescar hora real de inicio desde MLB Stats API/fuente oficial; no usar ventanas con placeholder.";
  if (action === "CAPTURE_ENTRY_CURRENT_ODDS") return "Guardar entry/current odds verificadas en odds_snapshot_cache con fuente y timestamp.";
  if (action === "RUN_BRIDGE_REGISTER_SHADOW") return "Correr bridge con cuotas reales; registrar shadow solo si pasa reglas.";
  if (action === "REGISTER_PAPER_SHADOW_TICKET") return "Registrar ticket paper/shadow solo si el gate lo permite.";
  if (action === "RUN_NEAR_START_NOW") return "Correr near-start MLB para pitchers/lineups/batting order/bullpen.";
  if (action === "CAPTURE_LINEUP_GOALKEEPER_NOW") return "Capturar XI/portero/bajas con fuente visible y verified_by.";
  if (action === "CAPTURE_CLOSING_NOW") return "Capturar closing con Source Capture Assistant; requiere evidencia y CAPTURED_ON_TIME.";
  if (action === "WAITING_VALID_CLOSING") return "Esperar ventana 10-3 min; preparar fuente y draft.";
  if (action === "WAITING_RESULT") return "No settlement hasta marcador final verificado.";
  if (action === "READY_FOR_SETTLEMENT") return "Cargar resultado verificado y correr settlement seguro.";
  return "Solo auditoria; no rescatar como pregame.";
}

function priorityForAction(action: string) {
  if (action === "CAPTURE_CLOSING_NOW") return 0;
  if (action === "RUN_NEAR_START_NOW" || action === "CAPTURE_LINEUP_GOALKEEPER_NOW") return 1;
  if (action === "READY_FOR_SETTLEMENT") return 2;
  if (action === "FIXTURE_TIME_UNVERIFIED") return 2;
  if (action === "CAPTURE_ENTRY_CURRENT_ODDS" || action === "RUN_BRIDGE_REGISTER_SHADOW") return 3;
  if (action === "WAITING_VALID_CLOSING") return 4;
  if (action === "GENERATE_OWNED_FAIR_ODDS" || action === "GENERATE_MODEL_FAIR_ODDS") return 5;
  if (action === "WAITING_RESULT") return 6;
  return 9;
}

export async function getCleanSampleQueue(db: Queryable, input: QueueQuery = {}) {
  const date = localDate(input.date);
  const window = tradingLocalDateWindow(date);
  const sport = normalizeSportForFilter(input.sport);
  const limit = Math.max(1, Math.min(200, Number(input.limit || 80)));
  const sample = await db.query(
    `
      SELECT
        (
          SELECT COUNT(*)::int
          FROM paper_trades pt
          WHERE pt.league_type = 'football_shadow'
            AND pt.status IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED')
            AND pt.raw_data->>'closing_quality' = 'CAPTURED_ON_TIME'
            AND NULLIF(pt.raw_data->>'clv', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
            AND COALESCE((pt.raw_data->>'entry_valid')::boolean, false)
            AND COALESCE((pt.raw_data->>'result_source_verified')::boolean, false)
            AND COALESCE((pt.raw_data->>'settlement_final')::boolean, false)
            AND COALESCE((pt.raw_data->>'clv_valid')::boolean, false)
            AND COALESCE((pt.raw_data->>'clean_v2_eligible')::boolean, false)
        ) AS football_clean_closed,
        (
          SELECT COUNT(*)::int
          FROM real_paper_snapshots rps
          WHERE rps.sport_slug = 'baseball'
            AND rps.league_slug = 'mlb'
            AND rps.market_type = 'moneyline_2way'
            AND rps.duplicate_of_id IS NULL
            AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
            AND rps.clv IS NOT NULL
            AND rps.raw_data->>'closing_quality' = 'CAPTURED_ON_TIME'
            AND COALESCE((rps.raw_data->>'result_source_verified')::boolean, false)
            AND COALESCE((rps.raw_data->>'settlement_final')::boolean, false)
            AND COALESCE((rps.raw_data->>'clv_valid')::boolean, false)
            AND COALESCE((rps.raw_data->>'clean_v2_eligible')::boolean, false)
            AND COALESCE((rps.raw_data->>'audit_only')::boolean, true) = false
        ) AS mlb_clean_closed,
        (
          SELECT COUNT(*)::int
          FROM real_paper_snapshots rps
          WHERE rps.sport_slug = 'baseball'
            AND rps.league_slug = 'mlb'
            AND rps.market_type = 'moneyline_2way'
            AND rps.duplicate_of_id IS NULL
            AND COALESCE(rps.data_state, 'FRESH') IN ('FRESH', 'ARCHIVED')
            AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
        ) AS mlb_legacy_closed,
        (
          SELECT ROUND(AVG(rps.clv) FILTER (WHERE rps.clv IS NOT NULL)::numeric, 6)
          FROM real_paper_snapshots rps
          WHERE rps.sport_slug = 'baseball'
            AND rps.league_slug = 'mlb'
            AND rps.market_type = 'moneyline_2way'
            AND rps.duplicate_of_id IS NULL
            AND COALESCE(rps.data_state, 'FRESH') IN ('FRESH', 'ARCHIVED')
            AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
        ) AS mlb_legacy_avg_clv,
        (
          SELECT ROUND((COALESCE(SUM(rps.profit_loss), 0) / 100.0)::numeric, 4)
          FROM real_paper_snapshots rps
          WHERE rps.sport_slug = 'baseball'
            AND rps.league_slug = 'mlb'
            AND rps.market_type = 'moneyline_2way'
            AND rps.duplicate_of_id IS NULL
            AND COALESCE(rps.data_state, 'FRESH') IN ('FRESH', 'ARCHIVED')
            AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
        ) AS mlb_legacy_profit_units;
    `
  );
  const rowsResult = await db.query(
    `
      SELECT
        m.id AS match_id,
        CASE
          WHEN l.slug IN ('mlb', 'baseball/mlb') THEN 'baseball'
          WHEN l.slug = 'nba' THEN 'basketball'
          WHEN l.slug LIKE '%world-cup%' OR s.slug = 'soccer' THEN 'soccer'
          ELSE s.slug
        END AS sport,
        l.slug AS league,
        CONCAT(away_team.name, ' @ ', home_team.name) AS match,
        m.match_date AS kickoff,
        m.status,
        m.raw_data->>'source_match_id' AS source_match_id,
        CASE
          WHEN l.slug IN ('mlb', 'baseball/mlb')
            AND m.status = 'scheduled'
            AND COALESCE(m.raw_data->>'source_match_id', '') ILIKE 'espn-mlb-%'
            AND NULLIF(m.raw_data->>'match_date', '')::timestamptz IS NOT NULL
            AND EXTRACT(HOUR FROM NULLIF(m.raw_data->>'match_date', '')::timestamptz AT TIME ZONE 'UTC') = 12
            AND EXTRACT(MINUTE FROM NULLIF(m.raw_data->>'match_date', '')::timestamptz AT TIME ZONE 'UTC') = 0
          THEN COALESCE(m.raw_data->>'official_kickoff', m.match_date::text)
          ELSE COALESCE(m.raw_data->>'match_date', m.match_date::text)
        END AS raw_match_date,
        mq.id AS model_quote_id,
        mq.model_name,
        mq.generated_at AS model_captured_at,
        market.id AS market_quote_id,
        market.provider_name AS market_provider,
        market.captured_at AS market_captured_at,
        entry_os.id AS entry_snapshot_id,
        entry_os.odds AS entry_snapshot_odds,
        ${safeJsonBooleanSql("entry_os.raw_data->>'safe_for_entry'")} AS entry_snapshot_safe_for_entry,
        entry_os.raw_data->>'evidence_id' AS entry_evidence_id,
        entry_os.raw_data->>'screenshot_sha256' AS entry_screenshot_sha256,
        COALESCE(pt.id, rps.id) AS ticket_id,
        pt.league_type,
        pt.market_type AS ticket_market,
        pt.selection AS ticket_selection,
        pt.expected_value,
        COALESCE(pt.status, rps.status) AS ticket_status,
        COALESCE(rps.raw_data->>'closing_quality', pt.raw_data->>'closing_quality', closing_os.raw_data->>'closing_quality') AS closing_quality,
        ${safeJsonBooleanSql("COALESCE(rps.raw_data->>'settlement_final', pt.raw_data->>'settlement_final')")} AS settlement_final,
        ${safeJsonBooleanSql("COALESCE(rps.raw_data->>'clv_valid', pt.raw_data->>'clv_valid')")} AS clv_valid,
        ${safeJsonBooleanSql("COALESCE(rps.raw_data->>'clean_v2_eligible', pt.raw_data->>'clean_v2_eligible')")} AS clean_v2_eligible,
        closing_os.id AS closing_snapshot_id,
        closing_os.odds AS closing_snapshot_odds,
        ${safeJsonBooleanSql("closing_os.raw_data->>'safe_for_closing'")} AS closing_snapshot_safe_for_closing,
        closing_os.raw_data->>'evidence_id' AS closing_evidence_id,
        closing_os.raw_data->>'screenshot_sha256' AS closing_screenshot_sha256
      FROM matches m
      JOIN leagues l ON l.id = m.league_id
      JOIN sports s ON s.id = l.sport_id
      LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
      LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
      LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
      LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM model_quotes
        WHERE match_id = m.id
        ORDER BY generated_at DESC
        LIMIT 1
      ) mq ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM market_quotes
        WHERE match_id = m.id
        ORDER BY captured_at DESC
        LIMIT 1
      ) market ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM paper_trades
        WHERE match_id = m.id
        ORDER BY created_at DESC
        LIMIT 1
      ) pt ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM real_paper_snapshots
        WHERE match_id = m.id
          AND duplicate_of_id IS NULL
          AND COALESCE(data_state, 'FRESH') <> 'DUPLICATE'
        ORDER BY entry_timestamp DESC
        LIMIT 1
      ) rps ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM odds_snapshots
        WHERE match_id = m.id
          AND COALESCE(raw_data->>'snapshot_type', snapshot_role) IN ('entry', 'current', 'market')
        ORDER BY ${safeJsonBooleanSql("raw_data->>'safe_for_entry'")} DESC, captured_at DESC
        LIMIT 1
      ) entry_os ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM odds_snapshots
        WHERE match_id = m.id
          AND COALESCE(raw_data->>'snapshot_type', snapshot_role) = 'closing'
        ORDER BY ${safeJsonBooleanSql("raw_data->>'safe_for_closing'")} DESC, captured_at DESC
        LIMIT 1
      ) closing_os ON TRUE
      WHERE m.match_date >= $1::timestamptz
        AND m.match_date < $2::timestamptz
        AND ($3 = 'all' OR CASE
          WHEN l.slug IN ('mlb', 'baseball/mlb') THEN 'baseball'
          WHEN l.slug = 'nba' THEN 'basketball'
          WHEN l.slug LIKE '%world-cup%' OR s.slug = 'soccer' THEN 'soccer'
          ELSE s.slug
        END = $3)
      ORDER BY m.match_date ASC
      LIMIT $4;
    `,
    [window.start, window.end, sport, limit]
  );
  const rows = rowsResult.rows
    .map((row) => {
      const baseRow = { ...row };
      const withMinutes = {
        ...baseRow,
        minutes_until_start: minutesUntil(baseRow.kickoff),
        fixture_time_unverified: isLikelyPlaceholderKickoff(baseRow)
      };
      const action = actionForRow(withMinutes);
      return {
        ...withMinutes,
        focus_score: focusScore(withMinutes),
        action,
        action_priority: priorityForAction(action),
        next_step: nextStepForAction(action),
        target_chain: "fair_odds -> entry/current -> shadow ticket -> near-start -> closing -> result -> settlement -> CLV",
        no_real_money: true,
        auto_post_allowed: false
      };
    })
    .sort((a, b) => a.action_priority - b.action_priority || b.focus_score - a.focus_score || Number(a.minutes_until_start ?? 99999) - Number(b.minutes_until_start ?? 99999));
  const focusRows = rows.filter((row) => row.action !== "POST_KICKOFF_AUDIT_ONLY").slice(0, 4);
  const count = (action: string) => rows.filter((row) => row.action === action).length;
  const sampleRow = sample.rows[0] || {};
  return {
    system_status: "CLEAN_SAMPLE_QUEUE_SAFE_V1",
    date,
    sport,
    sample_targets: {
      football_clean_closed: Number(sampleRow.football_clean_closed || 0),
      football_target_min: 50,
      football_next_goal: 20,
      mlb_clean_closed: Number(sampleRow.mlb_clean_closed || 0),
      mlb_target_min: 150,
      mlb_legacy_closed: Number(sampleRow.mlb_legacy_closed || 0),
      mlb_legacy_avg_clv: sampleRow.mlb_legacy_avg_clv === null || sampleRow.mlb_legacy_avg_clv === undefined ? null : Number(sampleRow.mlb_legacy_avg_clv),
      mlb_legacy_profit_units: sampleRow.mlb_legacy_profit_units === null || sampleRow.mlb_legacy_profit_units === undefined ? null : Number(sampleRow.mlb_legacy_profit_units),
      sample_policy: "legacy_pilot_is_orientation_only_clean_v2_requires_verified_chain"
    },
    summary: {
      scanned: rows.length,
      focus_count: focusRows.length,
      capture_closing_now: count("CAPTURE_CLOSING_NOW"),
      near_start_now: count("RUN_NEAR_START_NOW") + count("CAPTURE_LINEUP_GOALKEEPER_NOW"),
      entry_missing: count("CAPTURE_ENTRY_CURRENT_ODDS"),
      fair_odds_missing: count("GENERATE_OWNED_FAIR_ODDS") + count("GENERATE_MODEL_FAIR_ODDS"),
      fixture_time_unverified: count("FIXTURE_TIME_UNVERIFIED"),
      waiting_valid_closing: count("WAITING_VALID_CLOSING"),
      ready_for_settlement: count("READY_FOR_SETTLEMENT"),
      post_kickoff_audit_only: count("POST_KICKOFF_AUDIT_ONLY")
    },
    focus_rows: focusRows,
    rows,
    recommendation: focusRows.length
      ? "Trabajar solo 2-4 partidos foco hasta completar cadena limpia; no abrir mas ligas si falta closing/evidencia."
      : "No hay foco pregame disponible en esta fecha; preparar siguiente slate temprano.",
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
