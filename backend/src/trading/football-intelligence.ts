type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[]; rowCount?: number }>;
};

const FOOTBALL_ALLOWED_MARKETS = ["moneyline_3way", "draw_no_bet", "double_chance", "total_goals_2_5"];
const FOOTBALL_BLOCKED_MARKETS = ["btts"];

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTrue(value: unknown): boolean {
  return value === true || String(value).toLowerCase() === "true";
}

function oddsTimestampStatus(rawData: Record<string, any>, placedAt?: string | null, kickoff?: string | null) {
  const rawTimestamp = rawData.odds_timestamp || rawData.odds_captured_at || rawData.captured_at || placedAt;
  if (!rawTimestamp) return "MISSING_ODDS_TIMESTAMP";
  const captured = new Date(String(rawTimestamp));
  if (Number.isNaN(captured.getTime())) return "INVALID_ODDS_TIMESTAMP";
  if (kickoff) {
    const kickoffDate = new Date(kickoff);
    if (!Number.isNaN(kickoffDate.getTime()) && captured >= kickoffDate) return "POST_KICKOFF_REJECTED";
  }
  return "VALID";
}

function kickoffStatus(rawData: Record<string, any>, kickoff?: string | null) {
  if (!kickoff) return "MISSING_KICKOFF";
  const date = new Date(kickoff);
  if (Number.isNaN(date.getTime())) return "INVALID_KICKOFF";
  if (rawData.kickoff_trusted === false || String(rawData.validation_status || "").toUpperCase() === "KICKOFF_UNTRUSTED") {
    return "KICKOFF_UNTRUSTED";
  }
  return rawData.kickoff_trusted === true || rawData.source_consensus ? "TRUSTED" : "OBSERVED";
}

function marketEnabled(markets: unknown, market: string, manualReview: boolean): boolean {
  if (market === "btts" && manualReview) return true;
  if (Array.isArray(markets)) return markets.map(String).includes(market);
  if (markets && typeof markets === "object") return (markets as Record<string, unknown>)[market] === true;
  return FOOTBALL_ALLOWED_MARKETS.includes(market) && !FOOTBALL_BLOCKED_MARKETS.includes(market);
}

function finalStatus(input: {
  market: string;
  trustScore: number;
  trustStatus: string;
  isFriendly: boolean;
  manualReview: boolean;
  competitionEnabled: boolean;
  manualOnlyCompetition: boolean;
  marketsEnabled: unknown;
  kickoffStatus: string;
  oddsTimestampStatus: string;
  hasModel: boolean;
  teamStatus: string;
  playerStatus: string;
}) {
  if (!input.competitionEnabled) return "FOOTBALL_LEAGUE_TRUST_REVIEW";
  if (input.trustStatus === "BLOCKED") return "FOOTBALL_REJECTED";
  if (input.trustStatus === "MANUAL_ONLY" || input.manualOnlyCompetition) return input.manualReview ? "FOOTBALL_VALUE_ONLY_REVIEW" : "FOOTBALL_LEAGUE_TRUST_REVIEW";
  if (input.trustScore < 70) return "FOOTBALL_LEAGUE_TRUST_REVIEW";
  if (input.isFriendly && !input.manualReview) return "FOOTBALL_BLOCKED_BY_FRIENDLY";
  if (!marketEnabled(input.marketsEnabled, input.market, input.manualReview)) return "FOOTBALL_MARKET_BLOCKED";
  if (!["TRUSTED", "OBSERVED"].includes(input.kickoffStatus)) return "FOOTBALL_CONTEXT_GAPS";
  if (input.oddsTimestampStatus !== "VALID") return input.oddsTimestampStatus === "POST_KICKOFF_REJECTED" ? "FOOTBALL_REJECTED" : "FOOTBALL_VALUE_ONLY_REVIEW";
  if (!input.hasModel) return "FOOTBALL_VALUE_ONLY_REVIEW";
  if (input.teamStatus === "BLOCK_CONFIRMATION") return "FOOTBALL_CONTEXT_GAPS";
  if (input.playerStatus === "BLOCK_CONFIRMATION") return "FOOTBALL_PLAYER_NEWS_REVIEW";
  if (["NO_CONTEXT", "CONTEXT_GAPS"].includes(input.teamStatus)) return "FOOTBALL_CONTEXT_GAPS";
  if (["NO_CONTEXT", "LINEUP_PENDING"].includes(input.playerStatus)) return "FOOTBALL_PLAYER_NEWS_REVIEW";
  if (input.teamStatus === "TEAM_CONTEXT_SUPPORTS" && input.playerStatus === "PLAYER_CONTEXT_SUPPORTS") {
    return "FOOTBALL_CONFIRMED_PAPER";
  }
  return "FOOTBALL_VALUE_ONLY_REVIEW";
}

function recommendation(status: string) {
  switch (status) {
    case "FOOTBALL_CONFIRMED_PAPER":
      return "Confirmado solo para Shadow Paper; no dinero real.";
    case "FOOTBALL_LEAGUE_TRUST_REVIEW":
      return "Liga requiere mas confianza o revision manual antes de confirmar.";
    case "FOOTBALL_MARKET_BLOCKED":
      return "Mercado bloqueado o no permitido para decisiones automaticas.";
    case "FOOTBALL_BLOCKED_BY_FRIENDLY":
      return "Amistoso: conservar como observacion salvo revision manual.";
    case "FOOTBALL_PLAYER_NEWS_REVIEW":
      return "Falta alineacion/jugador clave; esperar noticias antes de confirmar.";
    case "FOOTBALL_CONTEXT_GAPS":
      return "Falta contexto de equipo o kickoff confiable; mantener en review.";
    case "FOOTBALL_REJECTED":
      return "Rechazado por validacion de seguridad.";
    default:
      return "Tiene valor/observacion, pero no cadena completa para confirmar.";
  }
}

function timestampAgeMinutes(timestamp?: string | null): number | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
}

function footballMarketLayer(input: {
  odds: unknown;
  modelProbability: unknown;
  expectedValue: unknown;
  oddsTimestamp?: string | null;
  oddsStatus: string;
}) {
  const odds = toNullableNumber(input.odds);
  const modelProbability = toNullableNumber(input.modelProbability);
  const expectedValue = toNullableNumber(input.expectedValue);
  const impliedProbability = odds && odds > 1 ? 1 / odds : null;
  const ageMinutes = timestampAgeMinutes(input.oddsTimestamp || null);
  let status = "MISSING_ODDS_MODEL_EV";

  if (input.oddsStatus !== "VALID") {
    status = input.oddsStatus;
  } else if (odds && modelProbability !== null && expectedValue !== null) {
    status = expectedValue > 0.03 ? "VALID_EV" : "NO_EDGE";
  } else if (odds && modelProbability === null) {
    status = "MISSING_MODEL_PROBABILITY";
  }

  return {
    odds_real_timestamp: input.oddsTimestamp || null,
    odds_age_minutes: ageMinutes,
    model_probability: modelProbability,
    market_implied_probability: impliedProbability,
    raw_ev: expectedValue,
    status
  };
}

function footballContextCompleteness(input: {
  leagueTrustScore: number;
  leagueTrustStatus: string;
  teamStatus: string;
  playerStatus: string;
  oddsStatus: string;
  marketLayerStatus: string;
  isFriendly: boolean;
  observationOnly: boolean;
}) {
  const teamStatus = input.teamStatus.toUpperCase();
  const playerStatus = input.playerStatus.toUpperCase();
  const trustStatus = input.leagueTrustStatus.toUpperCase();

  const playerSupports = playerStatus === "PLAYER_CONTEXT_SUPPORTS";
  const lineupPending = ["NO_CONTEXT", "LINEUP_PENDING"].includes(playerStatus);
  const playerConflict = ["BLOCK_CONFIRMATION", "REQUIRES_MANUAL_REVIEW", "PLAYER_CONTEXT_CONFLICTS"].includes(playerStatus);
  const teamSupports = teamStatus === "TEAM_CONTEXT_SUPPORTS";
  const teamPartial = ["PARTIAL_CONTEXT_REVIEW", "CONTEXT_GAPS"].includes(teamStatus);

  const lineupValue = playerSupports ? 20 : playerConflict ? 3 : lineupPending ? 8 : 12;
  const keyPlayersValue = playerSupports ? 15 : playerConflict ? 0 : lineupPending ? 7 : 10;
  const goalkeeperValue = playerSupports ? 10 : playerConflict ? 0 : lineupPending ? 4 : 6;
  const formValue = teamSupports ? 15 : teamPartial ? 10 : 0;
  const homeAwayValue = teamSupports ? 10 : teamPartial ? 7 : 0;
  const restTravelValue = teamSupports ? 10 : teamPartial ? 7 : 3;
  const competitionValue = input.isFriendly
    ? 2
    : trustStatus === "TRUSTED" || input.leagueTrustScore >= 85
      ? 10
      : input.leagueTrustScore >= 70
        ? 7
        : input.leagueTrustScore >= 50
          ? 4
          : 0;
  const closingOddsValue = input.observationOnly
    ? 0
    : input.oddsStatus === "VALID" && ["VALID_EV", "NO_EDGE"].includes(input.marketLayerStatus)
      ? 10
      : 0;

  const contextLayers = {
    lineup_official_status: {
      weight: 20,
      value: lineupValue,
      state: playerSupports ? "OFFICIAL_OR_VERIFIED" : playerConflict ? "LINEUP_CONFLICT" : lineupPending ? "PROJECTED_OR_PENDING" : "PARTIAL_PLAYER_CONTEXT"
    },
    key_players_absent: {
      weight: 15,
      value: keyPlayersValue,
      state: playerSupports ? "NO_MAJOR_INJURIES" : playerConflict ? "KEY_PLAYER_ALERT" : lineupPending ? "PENDING_NEWS" : "PARTIAL_NEWS"
    },
    portero_titular: {
      weight: 10,
      value: goalkeeperValue,
      state: playerSupports ? "CONFIRMED_OR_VERIFIED" : playerConflict ? "GOALKEEPER_OR_CORE_REVIEW" : lineupPending ? "PENDING" : "PARTIAL"
    },
    forma_5_10_partidos: {
      weight: 15,
      value: formValue,
      state: teamSupports ? "COMPUTED" : teamPartial ? "PARTIAL_COMPUTED" : "MISSING_TEAM_FORM"
    },
    forma_local_visitante: {
      weight: 10,
      value: homeAwayValue,
      state: teamSupports ? "COMPUTED" : teamPartial ? "PARTIAL_COMPUTED" : "MISSING_HOME_AWAY"
    },
    descanso_viaje_calendario: {
      weight: 10,
      value: restTravelValue,
      state: teamSupports ? "RESOLVED" : teamPartial ? "PARTIAL_REVIEW" : "MISSING_REST_TRAVEL"
    },
    tipo_competicion_trust: {
      weight: 10,
      value: competitionValue,
      state: input.isFriendly ? "FRIENDLY_OBSERVATION_ONLY" : trustStatus || "WATCH"
    },
    closing_odds_tracking: {
      weight: 10,
      value: closingOddsValue,
      state: closingOddsValue === 10 ? "ACTIVE" : input.observationOnly ? "NO_ODDS_REQUIRED_OBSERVATION" : input.oddsStatus
    }
  };

  const rawScore = Object.values(contextLayers).reduce((total, layer) => total + layer.value, 0);
  const marketMissing = input.observationOnly || ["MISSING_ODDS_MODEL_EV", "MISSING_MODEL_PROBABILITY", "NO_ODDS_REQUIRED_OBSERVATION"].includes(input.marketLayerStatus);
  const marketInvalid = input.oddsStatus !== "VALID" || input.marketLayerStatus.includes("STALE") || input.marketLayerStatus.includes("POST_KICKOFF");
  const score = marketMissing || marketInvalid ? Math.min(rawScore, 60) : rawScore;
  const tier = score <= 40 ? "DEBIL" : score <= 60 ? "INCOMPLETO" : score <= 80 ? "REVISABLE" : "FUERTE";
  const actionable = score > 80 && input.marketLayerStatus === "VALID_EV"
    ? "READY_FOR_SHADOW_REVIEW"
    : score > 80
      ? "STRONG_CONTEXT_MARKET_REVIEW"
      : score > 60
        ? "CONDITIONAL_SHADOW_REVIEW"
        : "BLOCKED_LOW_CONTEXT";

  return {
    football_context_layers: contextLayers,
    football_context_raw_score: rawScore,
    football_market_cap_applied: marketMissing || marketInvalid,
    football_context_completeness_score: score,
    football_tier_classification: tier,
    football_context_actionable_status: actionable
  };
}

export async function getFootballLeagueTrustScores(db: Queryable) {
  const result = await db.query(
    `
      WITH registry AS (
        SELECT
          league_id,
          display_name AS league_name,
          tier,
          trust_score,
          trust_status,
          20::integer AS min_closed_before_watch,
          50::integer AS min_closed_before_review,
          markets_enabled AS market_allowed_json,
          notes,
          updated_at
        FROM football_competition_registry
      )
      SELECT *
      FROM registry
      ORDER BY trust_score DESC, league_name ASC
    `
  );

  return {
    system_status: "FOOTBALL_LEAGUE_TRUST_READ_ONLY",
    count: result.rows.length,
    rows: result.rows,
    recommendation: "Usar trust score como primer filtro: ligas TRUSTED/WATCH pueden acumular; MANUAL_ONLY/BLOCKED no confirman.",
    guardrails: {
      shadow_paper_only: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false
    }
  };
}

export async function getFootballTeamIntelligence(db: Queryable) {
  const result = await db.query(
    `
      WITH persisted AS (
        SELECT
          fti.*,
          CONCAT(home_team.name, ' vs ', away_team.name) AS match,
          'persisted' AS row_source
        FROM football_team_intelligence fti
        LEFT JOIN v_valid_matches m ON m.id = fti.match_id
        LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
        LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
      ),
      observed AS (
        SELECT
          gen_random_uuid() AS id,
          m.id AS match_id,
          l.slug AS league_id,
          home_team.name AS home_team,
          away_team.name AS away_team,
          NULL::numeric AS form_home_score,
          NULL::numeric AS form_away_score,
          NULL::numeric AS home_attack_score,
          NULL::numeric AS away_attack_score,
          NULL::numeric AS home_defense_score,
          NULL::numeric AS away_defense_score,
          NULL::numeric AS home_recent_goals_for,
          NULL::numeric AS away_recent_goals_for,
          NULL::numeric AS home_recent_goals_against,
          NULL::numeric AS away_recent_goals_against,
          NULL::integer AS home_rest_days,
          NULL::integer AS away_rest_days,
          NULL::boolean AS home_travel_flag,
          NULL::boolean AS away_travel_flag,
          COALESCE((m.raw_data->>'is_neutral_venue')::boolean, false) AS neutral_venue,
          m.raw_data->>'match_importance' AS match_importance,
          NULL::varchar AS fixture_congestion_home,
          NULL::varchar AS fixture_congestion_away,
          CASE
            WHEN m.raw_data->>'football_today_universe' = 'true' THEN 'CONTEXT_GAPS'
            ELSE 'NO_CONTEXT'
          END AS team_intelligence_status,
          COALESCE(m.raw_data->>'source', 'football_today_universe') AS source,
          CASE WHEN m.raw_data ? 'source_consensus' THEN 0.700 ELSE 0.500 END::numeric AS source_confidence_score,
          COALESCE(m.updated_at, m.match_date) AS observed_at,
          m.raw_data,
          m.created_at,
          m.updated_at,
          CONCAT(home_team.name, ' vs ', away_team.name) AS match,
          'derived_observed' AS row_source
        FROM v_valid_matches m
        JOIN leagues l ON l.id = m.league_id
        LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
        LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
        WHERE l.slug IN ('fifa-world-cup-2026', 'liga-mx', 'mls', 'uefa-champions-league', 'premier-league', 'la-liga', 'serie-a', 'bundesliga', 'brasileirao-serie-a', 'argentina-primera-division')
          AND m.match_date >= NOW() - INTERVAL '14 days'
          AND NOT EXISTS (SELECT 1 FROM football_team_intelligence fti WHERE fti.match_id = m.id)
      )
      SELECT *
      FROM (
        SELECT * FROM persisted
        UNION ALL
        SELECT * FROM observed
      ) x
      ORDER BY observed_at DESC
      LIMIT 200
    `
  );

  const counts = result.rows.reduce((acc: Record<string, number>, row) => {
    const status = String(row.team_intelligence_status || "NO_CONTEXT");
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  return {
    system_status: "FOOTBALL_TEAM_INTELLIGENCE_READ_ONLY",
    count: result.rows.length,
    counts,
    rows: result.rows,
    recommendation: "Team Intelligence de futbol esta en lectura/ acumulacion; no confirma picks sin contexto suficiente.",
    guardrails: {
      shadow_paper_only: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false
    }
  };
}

export async function getFootballPlayerIntelligence(db: Queryable) {
  const result = await db.query(
    `
      WITH persisted AS (
        SELECT
          fpi.*,
          CONCAT(home_team.name, ' vs ', away_team.name) AS match,
          'persisted' AS row_source
        FROM football_player_intelligence fpi
        LEFT JOIN v_valid_matches m ON m.id = fpi.match_id
        LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
        LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
      ),
      derived_lineups AS (
        SELECT
          gen_random_uuid() AS id,
          m.id AS match_id,
          l.slug AS league_id,
          home_team.name AS team,
          CONCAT(home_team.name, ' lineup') AS player_name,
          LOWER(REGEXP_REPLACE(home_team.name || '-lineup', '[^a-zA-Z0-9]+', '-', 'g')) AS normalized_player_name,
          'lineup'::varchar AS position,
          NULL::boolean AS expected_starting,
          NULL::boolean AS confirmed_starting,
          'UNKNOWN'::varchar AS lineup_status,
          'UNKNOWN'::varchar AS injury_status,
          'UNKNOWN'::varchar AS suspension_status,
          NULL::varchar AS rotation_risk,
          NULL::numeric AS minutes_last_5,
          NULL::numeric AS goals_last_5,
          NULL::numeric AS assists_last_5,
          NULL::numeric AS shots_last_5,
          NULL::numeric AS shots_on_target_last_5,
          NULL::numeric AS goalkeeper_saves_last_5,
          true AS key_player_flag,
          'lineup_context'::varchar AS impact_area,
          'LINEUP_PENDING'::varchar AS player_intelligence_status,
          COALESCE(m.raw_data->>'source', 'football_today_universe') AS source,
          0.500::numeric AS source_confidence_score,
          COALESCE(m.updated_at, m.match_date) AS observed_at,
          m.raw_data,
          m.created_at,
          m.updated_at,
          CONCAT(home_team.name, ' vs ', away_team.name) AS match,
          'derived_lineup_pending' AS row_source
        FROM v_valid_matches m
        JOIN leagues l ON l.id = m.league_id
        LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
        LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
        WHERE l.slug IN ('fifa-world-cup-2026', 'liga-mx', 'mls', 'uefa-champions-league', 'premier-league', 'la-liga', 'serie-a', 'bundesliga', 'brasileirao-serie-a', 'argentina-primera-division')
          AND m.match_date >= NOW() - INTERVAL '14 days'
          AND NOT EXISTS (SELECT 1 FROM football_player_intelligence fpi WHERE fpi.match_id = m.id)
        UNION ALL
        SELECT
          gen_random_uuid(), m.id, l.slug, away_team.name,
          CONCAT(away_team.name, ' lineup'),
          LOWER(REGEXP_REPLACE(away_team.name || '-lineup', '[^a-zA-Z0-9]+', '-', 'g')),
          'lineup', NULL::boolean, NULL::boolean, 'UNKNOWN', 'UNKNOWN', 'UNKNOWN',
          NULL::varchar, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
          true, 'lineup_context', 'LINEUP_PENDING',
          COALESCE(m.raw_data->>'source', 'football_today_universe'),
          0.500::numeric,
          COALESCE(m.updated_at, m.match_date),
          m.raw_data, m.created_at, m.updated_at,
          CONCAT(home_team.name, ' vs ', away_team.name),
          'derived_lineup_pending'
        FROM v_valid_matches m
        JOIN leagues l ON l.id = m.league_id
        LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
        LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
        WHERE l.slug IN ('fifa-world-cup-2026', 'liga-mx', 'mls', 'uefa-champions-league', 'premier-league', 'la-liga', 'serie-a', 'bundesliga', 'brasileirao-serie-a', 'argentina-primera-division')
          AND m.match_date >= NOW() - INTERVAL '14 days'
          AND NOT EXISTS (SELECT 1 FROM football_player_intelligence fpi WHERE fpi.match_id = m.id)
      )
      SELECT *
      FROM (
        SELECT * FROM persisted
        UNION ALL
        SELECT * FROM derived_lineups
      ) x
      ORDER BY observed_at DESC
      LIMIT 250
    `
  );

  const counts = result.rows.reduce((acc: Record<string, number>, row) => {
    const status = String(row.player_intelligence_status || "NO_CONTEXT");
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  return {
    system_status: "FOOTBALL_PLAYER_INTELLIGENCE_READ_ONLY",
    count: result.rows.length,
    counts,
    rows: result.rows,
    recommendation: "Player Intelligence de futbol exige alineaciones/jugadores antes de confirmar Shadow Paper.",
    guardrails: {
      shadow_paper_only: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false
    }
  };
}

export async function getFootballConfirmedPickChain(db: Queryable) {
  const result = await db.query(
    `
      WITH latest_team AS (
        SELECT DISTINCT ON (match_id)
          match_id, team_intelligence_status, source_confidence_score, observed_at
        FROM football_team_intelligence
        ORDER BY match_id, observed_at DESC
      ),
      latest_player AS (
        SELECT
          match_id,
          CASE
            WHEN COUNT(*) FILTER (WHERE player_intelligence_status = 'BLOCK_CONFIRMATION') > 0 THEN 'BLOCK_CONFIRMATION'
            WHEN COUNT(*) FILTER (WHERE player_intelligence_status = 'REQUIRES_MANUAL_REVIEW') > 0 THEN 'REQUIRES_MANUAL_REVIEW'
            WHEN COUNT(*) FILTER (WHERE player_intelligence_status = 'PLAYER_CONTEXT_CONFLICTS') > 0 THEN 'PLAYER_CONTEXT_CONFLICTS'
            WHEN COUNT(*) FILTER (WHERE player_intelligence_status = 'PLAYER_CONTEXT_SUPPORTS') > 0 THEN 'PLAYER_CONTEXT_SUPPORTS'
            WHEN COUNT(*) FILTER (WHERE player_intelligence_status = 'LINEUP_PENDING') > 0 THEN 'LINEUP_PENDING'
            ELSE 'NO_CONTEXT'
          END AS player_intelligence_status,
          MAX(observed_at) AS observed_at
        FROM football_player_intelligence
        GROUP BY match_id
      ),
      latest_odds AS (
        SELECT DISTINCT ON (os.match_id, os.market_type, os.selection)
          os.match_id,
          os.market_type,
          os.selection,
          os.odds,
          os.provider_name,
          os.captured_at,
          os.quality_score,
          os.raw_data,
          os.raw_data->>'feed_status' AS feed_status,
          CASE
            WHEN (os.raw_data->>'model_probability') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (os.raw_data->>'model_probability')::numeric
            ELSE NULL::numeric
          END AS model_probability,
          CASE
            WHEN (os.raw_data->>'expected_value') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (os.raw_data->>'expected_value')::numeric
            ELSE NULL::numeric
          END AS expected_value
        FROM odds_snapshots os
        WHERE os.sport_slug = 'soccer'
        ORDER BY os.match_id, os.market_type, os.selection,
          CASE os.raw_data->>'feed_status'
            WHEN 'SHADOW_CANDIDATE' THEN 0
            WHEN 'MARKET_SNAPSHOT' THEN 1
            ELSE 2
          END,
          os.captured_at DESC
      ),
      picks AS (
        SELECT
          pt.id AS paper_trade_id,
          pt.match_id,
          pt.league_slug AS league_id,
          pt.home_team,
          pt.away_team,
          pt.market_type AS market,
          pt.selection AS pick,
          pt.market_odds AS odds,
          pt.model_probability,
          pt.expected_value,
          pt.odds_source AS provider,
          pt.status AS paper_status,
          pt.placed_at,
          pt.raw_data,
          false AS observation_only
        FROM paper_trades pt
        WHERE pt.league_type = 'soccer'
          AND pt.status IN ('PENDING', 'PENDING_RESULT', 'PENDING_RESULTS', 'OPEN')
        UNION ALL
        SELECT
          NULL::uuid AS paper_trade_id,
          m.id AS match_id,
          l.slug AS league_id,
          home_team.name AS home_team,
          away_team.name AS away_team,
          COALESCE(lo.market_type, 'observation') AS market,
          COALESCE(lo.selection, 'none') AS pick,
          lo.odds,
          lo.model_probability,
          lo.expected_value,
          lo.provider_name AS provider,
          m.status::varchar AS paper_status,
          COALESCE(lo.captured_at, m.match_date) AS placed_at,
          COALESCE(lo.raw_data, m.raw_data) AS raw_data,
          CASE WHEN lo.feed_status = 'SHADOW_CANDIDATE' THEN false ELSE true END AS observation_only
        FROM v_valid_matches m
        JOIN leagues l ON l.id = m.league_id
        LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
        LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
        LEFT JOIN LATERAL (
          SELECT *
          FROM latest_odds lo
          WHERE lo.match_id = m.id
          ORDER BY
            CASE lo.feed_status
              WHEN 'SHADOW_CANDIDATE' THEN 0
              WHEN 'MARKET_SNAPSHOT' THEN 1
              ELSE 2
            END,
            lo.captured_at DESC
          LIMIT 1
        ) lo ON true
        WHERE m.raw_data->>'football_today_universe' = 'true'
          AND m.match_date >= NOW() - INTERVAL '2 days'
          AND NOT EXISTS (
            SELECT 1 FROM paper_trades pt
            WHERE pt.match_id = m.id
              AND pt.league_type = 'soccer'
              AND pt.status IN ('PENDING', 'PENDING_RESULT', 'PENDING_RESULTS', 'OPEN')
          )
      )
      SELECT
        p.*,
        m.match_date AS kickoff,
        m.status AS match_status,
        m.raw_data AS match_raw_data,
        COALESCE(fcr.display_name, ts.league_name, p.league_id) AS league_name,
        COALESCE(fcr.trust_score, ts.trust_score, 50) AS league_trust_score,
        COALESCE(fcr.trust_status, ts.trust_status, 'WATCH') AS league_trust_status,
        COALESCE(fcr.markets_enabled, ts.market_allowed_json, '[]'::jsonb) AS market_allowed_json,
        COALESCE(fcr.enabled, true) AS competition_enabled,
        COALESCE(fcr.manual_only, false) AS competition_manual_only,
        COALESCE(fcr.is_friendly, false) AS competition_is_friendly,
        fcr.tier AS competition_tier,
        COALESCE(lt.team_intelligence_status, CASE WHEN p.observation_only THEN 'CONTEXT_GAPS' ELSE 'NO_CONTEXT' END) AS team_intelligence_status,
        COALESCE(lp.player_intelligence_status, CASE WHEN p.observation_only THEN 'LINEUP_PENDING' ELSE 'NO_CONTEXT' END) AS player_intelligence_status,
        latest_os.captured_at AS odds_timestamp,
        latest_os.quality_score AS odds_quality_score,
        latest_os.raw_data AS odds_raw_data
      FROM picks p
      LEFT JOIN v_valid_matches m ON m.id = p.match_id
      LEFT JOIN football_competition_registry fcr ON fcr.league_id = p.league_id
      LEFT JOIN football_league_trust_scores ts ON ts.league_id = p.league_id
      LEFT JOIN latest_team lt ON lt.match_id = p.match_id
      LEFT JOIN latest_player lp ON lp.match_id = p.match_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM latest_odds os
        WHERE os.match_id = p.match_id
          AND (os.market_type = p.market OR p.market = 'observation')
          AND (os.selection = p.pick OR p.pick = 'none')
        ORDER BY os.captured_at DESC
        LIMIT 1
      ) latest_os ON true
      ORDER BY p.placed_at DESC
      LIMIT 250
    `
  );

  const rows = result.rows.map((row) => {
    const rawData = row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};
    const matchRawData = row.match_raw_data && typeof row.match_raw_data === "object" ? row.match_raw_data : {};
    const isFriendly = isTrue(row.competition_is_friendly) || isTrue(rawData.is_friendly) || isTrue(matchRawData.is_friendly) || String(row.league_id || "").includes("friendly");
    const manualReview = isTrue(rawData.manual_review) || isTrue(rawData.manual_review_required) || isTrue(matchRawData.manual_review);
    const kickoff = row.kickoff ? String(row.kickoff) : null;
    const oddsTimestamp = row.odds_timestamp ? String(row.odds_timestamp) : row.placed_at ? String(row.placed_at) : null;
    const oddsStatus = row.observation_only ? "NO_ODDS_REQUIRED_OBSERVATION" : oddsTimestampStatus({ ...matchRawData, ...rawData }, oddsTimestamp, kickoff);
    const kickStatus = kickoffStatus(matchRawData, kickoff);
    const hasModel = row.model_probability !== null && row.model_probability !== undefined && row.expected_value !== null && row.expected_value !== undefined;
    const final_chain_status = row.observation_only
      ? "OBSERVATION_ONLY"
      : finalStatus({
          market: String(row.market || ""),
          trustScore: toNumber(row.league_trust_score),
          trustStatus: String(row.league_trust_status || "WATCH"),
          isFriendly,
          manualReview,
          competitionEnabled: row.competition_enabled !== false,
          manualOnlyCompetition: isTrue(row.competition_manual_only),
          marketsEnabled: row.market_allowed_json,
          kickoffStatus: kickStatus,
          oddsTimestampStatus: oddsStatus,
          hasModel,
          teamStatus: String(row.team_intelligence_status || "NO_CONTEXT"),
          playerStatus: String(row.player_intelligence_status || "NO_CONTEXT")
        });
    const marketLayer = footballMarketLayer({
      odds: row.odds,
      modelProbability: row.model_probability,
      expectedValue: row.expected_value,
      oddsTimestamp,
      oddsStatus
    });
    const contextCompleteness = footballContextCompleteness({
      leagueTrustScore: toNumber(row.league_trust_score),
      leagueTrustStatus: String(row.league_trust_status || "WATCH"),
      teamStatus: String(row.team_intelligence_status || "NO_CONTEXT"),
      playerStatus: String(row.player_intelligence_status || "NO_CONTEXT"),
      oddsStatus,
      marketLayerStatus: marketLayer.status,
      isFriendly,
      observationOnly: Boolean(row.observation_only)
    });
    const missing_context_fields = [
      kickStatus !== "TRUSTED" && kickStatus !== "OBSERVED" ? "kickoff" : null,
      oddsStatus !== "VALID" && !row.observation_only ? "odds_timestamp" : null,
      !hasModel && !row.observation_only ? "model_probability_or_ev" : null,
      ["NO_CONTEXT", "CONTEXT_GAPS"].includes(String(row.team_intelligence_status)) ? "team_intelligence" : null,
      ["NO_CONTEXT", "LINEUP_PENDING"].includes(String(row.player_intelligence_status)) ? "player_intelligence_lineup" : null,
      contextCompleteness.football_context_completeness_score <= 80 && !row.observation_only ? "football_context_score_below_81" : null
    ].filter(Boolean);

    return {
      match_id: row.match_id,
      paper_trade_id: row.paper_trade_id,
      match: `${row.home_team || "Home"} vs ${row.away_team || "Away"}`,
      league: row.league_name || row.league_id,
      league_id: row.league_id,
      market: row.market,
      pick: row.pick,
      odds: toNullableNumber(row.odds),
      odds_timestamp: oddsTimestamp,
      model_probability: toNullableNumber(row.model_probability),
      expected_value: toNullableNumber(row.expected_value),
      provider: row.provider || "-",
      paper_status: row.paper_status,
      kickoff,
      league_trust_score: toNumber(row.league_trust_score),
      league_trust_status: row.league_trust_status || "WATCH",
      competition_tier: row.competition_tier || null,
      market_allowed_json: row.market_allowed_json || null,
      team_intelligence_status: row.team_intelligence_status || "NO_CONTEXT",
      player_intelligence_status: row.player_intelligence_status || "NO_CONTEXT",
      market_lab_status: String(row.market) === "btts" ? "BLOCKED" : "SHADOW_REVIEW",
      kickoff_status: kickStatus,
      odds_timestamp_status: oddsStatus,
      is_friendly: isFriendly,
      observation_only: Boolean(row.observation_only),
      final_chain_status,
      market_layer: marketLayer,
      ...contextCompleteness,
      missing_context_fields,
      recommendation: row.observation_only
        ? "Observado como universo; no es pick."
        : recommendation(final_chain_status)
    };
  });

  const countStatus = (status: string) => rows.filter((row) => row.final_chain_status === status).length;
  const blockedByLeagueTrust = rows.filter((row) => row.final_chain_status === "FOOTBALL_LEAGUE_TRUST_REVIEW").length;
  const blockedByMarket = rows.filter((row) => row.final_chain_status === "FOOTBALL_MARKET_BLOCKED").length;
  const blockedByFriendly = rows.filter((row) => row.final_chain_status === "FOOTBALL_BLOCKED_BY_FRIENDLY").length;
  const blockedByPlayerNews = rows.filter((row) => row.final_chain_status === "FOOTBALL_PLAYER_NEWS_REVIEW").length;
  const contextGaps = rows.filter((row) => row.final_chain_status === "FOOTBALL_CONTEXT_GAPS").length;
  const contextCompletenessSummary = rows.reduce((acc: Record<string, number>, row) => {
    const tier = String(row.football_tier_classification || "SIN_DATOS").toLowerCase();
    acc[tier] = (acc[tier] || 0) + 1;
    return acc;
  }, {});

  return {
    system_status: "FOOTBALL_CONFIRMED_PICK_CHAIN_SHADOW_ONLY",
    active_football_picks: rows.filter((row) => !row.observation_only).length,
    football_confirmed_paper: countStatus("FOOTBALL_CONFIRMED_PAPER"),
    blocked_by_league_trust: blockedByLeagueTrust,
    blocked_by_market: blockedByMarket,
    blocked_by_friendly: blockedByFriendly,
    blocked_by_player_news: blockedByPlayerNews,
    context_gaps: contextGaps,
    context_completeness_summary: {
      fuerte: contextCompletenessSummary.fuerte || 0,
      revisable: contextCompletenessSummary.revisable || 0,
      incompleto: contextCompletenessSummary.incompleto || 0,
      debil: contextCompletenessSummary.debil || 0
    },
    rows,
    recommendation: countStatus("FOOTBALL_CONFIRMED_PAPER") > 0
      ? "Hay Football Confirmed Paper, pero sigue Shadow Paper only."
      : "Futbol todavia necesita odds/modelo/contexto antes de confirmar picks.",
    guardrails: {
      shadow_paper_only: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}

function hasFootballOdds(row: Record<string, any>): boolean {
  return row.odds !== null && row.odds !== undefined && Number(row.odds) > 1;
}

function hasFootballModel(row: Record<string, any>): boolean {
  return row.model_probability !== null
    && row.model_probability !== undefined
    && row.expected_value !== null
    && row.expected_value !== undefined;
}

function hasTrustedFootballKickoff(row: Record<string, any>): boolean {
  return ["TRUSTED", "OBSERVED"].includes(String(row.kickoff_status || "").toUpperCase());
}

function hasFootballTeamContext(row: Record<string, any>): boolean {
  return ["PARTIAL_CONTEXT_REVIEW", "TEAM_CONTEXT_SUPPORTS"].includes(String(row.team_intelligence_status || "").toUpperCase());
}

function hasFootballPlayerContext(row: Record<string, any>): boolean {
  return String(row.player_intelligence_status || "").toUpperCase() === "PLAYER_CONTEXT_SUPPORTS";
}

function hasFootballLineupGap(row: Record<string, any>): boolean {
  const playerStatus = String(row.player_intelligence_status || "").toUpperCase();
  const missing = Array.isArray(row.missing_context_fields) ? row.missing_context_fields.map(String) : [];
  return playerStatus === "LINEUP_PENDING" || missing.includes("player_intelligence_lineup");
}

function footballReadinessStatus(row: Record<string, any>): string {
  const finalStatus = String(row.final_chain_status || "").toUpperCase();
  if (finalStatus === "FOOTBALL_CONFIRMED_PAPER") return "FOOTBALL_CONFIRMED_PAPER";
  if (finalStatus.includes("FRIENDLY")) return "FRIENDLY_OBSERVATION_ONLY";
  if (finalStatus.includes("LEAGUE_TRUST")) return "LEAGUE_TRUST_REVIEW";
  if (finalStatus.includes("MARKET_BLOCKED")) return "MARKET_BLOCKED";
  if (!hasTrustedFootballKickoff(row)) return "NEEDS_KICKOFF_CONSENSUS";
  if (!hasFootballOdds(row) || !hasFootballModel(row)) return "NEEDS_ODDS_MODEL_EV";
  if (!hasFootballTeamContext(row)) return "NEEDS_TEAM_CONTEXT";
  if (hasFootballLineupGap(row)) return "NEEDS_LINEUP_PLAYER_CONTEXT";
  if (String(row.football_context_actionable_status || "").toUpperCase() === "READY_FOR_SHADOW_REVIEW") return "READY_FOR_SHADOW_REVIEW";
  if (hasFootballTeamContext(row) && hasFootballPlayerContext(row)) return "READY_FOR_SHADOW_REVIEW";
  return "PARTIAL_CONTEXT_REVIEW";
}

function footballReadinessRecommendation(status: string): string {
  switch (status) {
    case "FOOTBALL_CONFIRMED_PAPER":
      return "Cadena completa solo para Shadow Paper; dinero real sigue bloqueado.";
    case "READY_FOR_SHADOW_REVIEW":
      return "Tiene odds/modelo/contexto; revisar cadena antes de crear o mantener candidato paper.";
    case "NEEDS_ODDS_MODEL_EV":
      return "Falta cuota, timestamp, probabilidad del modelo o EV. No puede ser candidato serio.";
    case "NEEDS_LINEUP_PLAYER_CONTEXT":
      return "Falta alineacion oficial o contexto de jugadores. Esperar fuente verificada.";
    case "NEEDS_TEAM_CONTEXT":
      return "Falta forma/contexto de equipo. Cargar team_stats y correr build-consensus.";
    case "NEEDS_KICKOFF_CONSENSUS":
      return "Falta consenso de kickoff. Mantener como observacion.";
    case "LEAGUE_TRUST_REVIEW":
      return "Liga requiere mas confianza o revision manual.";
    case "MARKET_BLOCKED":
      return "Mercado bloqueado para decisiones automaticas.";
    case "FRIENDLY_OBSERVATION_ONLY":
      return "Amistoso: usar solo como informacion, no como promocion automatica.";
    default:
      return "Seguir acumulando informacion sin crear picks.";
  }
}

export async function getFootballReadinessGate(db: Queryable) {
  const chain = await getFootballConfirmedPickChain(db);
  const rows = (chain.rows || []).map((row: Record<string, any>) => {
    const status = footballReadinessStatus(row);
    return {
      match_id: row.match_id,
      match: row.match,
      league: row.league,
      market: row.market,
      pick: row.pick,
      odds: row.odds,
      model_probability: row.model_probability,
      expected_value: row.expected_value,
      final_chain_status: row.final_chain_status,
      readiness_status: status,
      observation_only: Boolean(row.observation_only),
      kickoff_ready: hasTrustedFootballKickoff(row),
      odds_ready: hasFootballOdds(row),
      model_ready: hasFootballModel(row),
      team_context_ready: hasFootballTeamContext(row),
      player_context_ready: hasFootballPlayerContext(row),
      lineup_pending: hasFootballLineupGap(row),
      football_context_completeness_score: row.football_context_completeness_score ?? null,
      football_tier_classification: row.football_tier_classification || "SIN_DATOS",
      football_context_actionable_status: row.football_context_actionable_status || "BLOCKED_LOW_CONTEXT",
      missing_context_fields: row.missing_context_fields || [],
      recommendation: footballReadinessRecommendation(status)
    };
  });

  const count = (predicate: (row: Record<string, any>) => boolean) => rows.filter(predicate).length;
  const gapCounts = [
    { gap: "odds_model_ev", count: count((row) => !row.odds_ready || !row.model_ready), recommendation: "Agregar odds_timestamp, market_odds, model_probability y expected_value solo con datos verificados." },
    { gap: "lineup_player_context", count: count((row) => row.lineup_pending || !row.player_context_ready), recommendation: "Esperar alineacion oficial o cargar player context verificado." },
    { gap: "team_context", count: count((row) => !row.team_context_ready), recommendation: "Cargar forma/equipo/localia y correr build-consensus." },
    { gap: "kickoff_consensus", count: count((row) => !row.kickoff_ready), recommendation: "Cruzar fixture/kickoff antes de aplicar feed." }
  ].sort((a, b) => b.count - a.count);

  const readyForShadowReview = rows.filter((row) => row.readiness_status === "READY_FOR_SHADOW_REVIEW").length;
  const alertRows = rows.filter((row) => row.readiness_status === "READY_FOR_SHADOW_REVIEW");
  const confirmedPaper = rows.filter((row) => row.readiness_status === "FOOTBALL_CONFIRMED_PAPER").length;
  const activeCandidates = rows.filter((row) => !row.observation_only).length;
  const dominantGap = gapCounts[0] || { gap: "none", count: 0, recommendation: "Sin gaps dominantes." };
  const shadowTicketStats = await db.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED', 'ARCHIVED')
      )::int AS open_tickets,
      COUNT(*) FILTER (
        WHERE status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED', 'ARCHIVED')
          AND raw_data->>'bridge_status' = 'READY_FOR_SHADOW_REVIEW'
      )::int AS ready_shadow_from_tickets,
      COUNT(*) FILTER (
        WHERE status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED', 'ARCHIVED')
          AND market_odds IS NOT NULL
          AND model_probability IS NOT NULL
          AND expected_value IS NOT NULL
      )::int AS with_odds_model_ev,
      COUNT(*) FILTER (
        WHERE status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED', 'ARCHIVED')
          AND (
            raw_data->>'closing_odds' IS NULL
            OR raw_data->>'closing_status' = 'MISSING_CLOSING'
            OR raw_data->>'closing_quality' IS DISTINCT FROM 'CAPTURED_ON_TIME'
          )
      )::int AS pending_closing,
      COUNT(*) FILTER (
        WHERE status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED', 'ARCHIVED')
      )::int AS pending_settlement
    FROM paper_trades
    WHERE league_type = 'football_shadow'
  `);
  const shadowStats = shadowTicketStats.rows[0] || {};
  const shadowTicketRowsResult = await db.query(`
    SELECT
      pt.match_id,
      COALESCE(NULLIF(pt.home_team, ''), 'Home') || ' vs ' || COALESCE(NULLIF(pt.away_team, ''), 'Away') AS match,
      pt.league_slug AS league,
      pt.market_type AS market,
      pt.selection AS pick,
      pt.market_odds AS odds,
      pt.model_probability,
      pt.expected_value,
      pt.status,
      pt.raw_data,
      pt.created_at
    FROM paper_trades pt
    WHERE pt.league_type = 'football_shadow'
      AND pt.status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED', 'ARCHIVED')
    ORDER BY pt.created_at DESC
    LIMIT 25
  `);
  const shadowTicketRows = shadowTicketRowsResult.rows.map((row: Record<string, any>) => ({
    match_id: row.match_id,
    match: row.match,
    league: row.league,
    market: row.market,
    pick: row.pick,
    odds: row.odds,
    model_probability: row.model_probability,
    expected_value: row.expected_value,
    final_chain_status: "FOOTBALL_SHADOW_TICKET",
    readiness_status: "READY_FOR_SHADOW_REVIEW",
    observation_only: false,
    kickoff_ready: true,
    odds_ready: true,
    model_ready: true,
    team_context_ready: false,
    player_context_ready: false,
    lineup_pending: true,
    football_context_completeness_score: null,
    football_tier_classification: "SHADOW_REVIEW",
    football_context_actionable_status: "READY_FOR_SHADOW_REVIEW",
    missing_context_fields: [
      ...((row.raw_data as Record<string, unknown> | null)?.requires_closing_snapshot ? ["closing_odds_snapshot"] : []),
      ...(((row.raw_data as Record<string, unknown> | null)?.closing_quality && (row.raw_data as Record<string, unknown>).closing_quality !== "CAPTURED_ON_TIME") ? ["closing_quality_review"] : []),
      ...((row.raw_data as Record<string, unknown> | null)?.requires_shadow_settlement ? ["settlement"] : []),
      "lineup/player context"
    ],
    recommendation: "Ticket Shadow Review registrado; esperar closing, resultado y CLV. No es pick confirmado."
  }));
  const shadowOpenTickets = Number(shadowStats.open_tickets || 0);
  const readyShadowFromTickets = Number(shadowStats.ready_shadow_from_tickets || 0);
  const shadowWithOddsModelEv = Number(shadowStats.with_odds_model_ev || 0);
  const pendingClosing = Number(shadowStats.pending_closing || 0);
  const pendingSettlement = Number(shadowStats.pending_settlement || 0);
  const effectiveReadyForShadowReview = Math.max(readyForShadowReview, readyShadowFromTickets);
  const effectiveWithOdds = Math.max(count((row) => row.odds_ready), shadowWithOddsModelEv);
  const effectiveWithModelEv = Math.max(count((row) => row.model_ready), shadowWithOddsModelEv);

  return {
    system_status: "FOOTBALL_READINESS_GATE_SHADOW_ONLY",
    decision: confirmedPaper > 0
      ? "FOOTBALL_CONFIRMED_PAPER_REVIEW"
      : effectiveReadyForShadowReview > 0
        ? "READY_FOR_SHADOW_REVIEW"
        : "COLLECT_DATA_FIRST",
    observed_matches: rows.length,
    active_candidates: activeCandidates + shadowOpenTickets,
    football_confirmed_paper: confirmedPaper,
    ready_for_shadow_review: effectiveReadyForShadowReview,
    bridge_ready_count: readyForShadowReview,
    ready_shadow_from_chain: readyForShadowReview,
    ticket_ready_count: readyShadowFromTickets,
    ready_shadow_from_tickets: readyShadowFromTickets,
    football_shadow_open_tickets: shadowOpenTickets,
    pending_closing: pendingClosing,
    football_shadow_pending_closing: pendingClosing,
    pending_settlement: pendingSettlement,
    football_shadow_pending_settlement: pendingSettlement,
    confirmed_paper: confirmedPaper,
    shadow_market_signals_with_odds_model: shadowWithOddsModelEv,
    alert_status: effectiveReadyForShadowReview > 0 ? "ALERT_READY_FOR_SHADOW_REVIEW" : "NO_READY_SHADOW_REVIEW",
    alert_rows: [...shadowTicketRows, ...alertRows],
    shadow_ticket_rows: shadowTicketRows,
    with_odds: count((row) => row.odds_ready),
    with_model_ev: count((row) => row.model_ready),
    with_odds_effective: effectiveWithOdds,
    with_model_ev_effective: effectiveWithModelEv,
    with_team_context: count((row) => row.team_context_ready),
    with_player_context: count((row) => row.player_context_ready),
    lineup_pending: count((row) => row.lineup_pending),
    dominant_gap: dominantGap.gap,
    gaps: gapCounts,
    rows: [...shadowTicketRows, ...rows],
    recommendation: confirmedPaper > 0
      ? "Revisar Football Confirmed Paper uno por uno. Sigue Shadow Paper only."
      : effectiveReadyForShadowReview > 0
        ? "Hay tickets Shadow Review con cuota/modelo/EV; exigir closing, settlement y CLV antes de confiar."
        : `Futbol todavia no esta al nivel operativo MLB porque domina el gap: ${dominantGap.gap}. ${dominantGap.recommendation}`,
    guardrails: {
      shadow_paper_only: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}
