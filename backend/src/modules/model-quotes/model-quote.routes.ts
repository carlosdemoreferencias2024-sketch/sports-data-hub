import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { AppError } from "../../shared/http-errors.js";
import { processFootballShadowFeed } from "../../trading/football-market-lab.js";
import { shadowCandidatePreflightPassed } from "../../trading/shadow-candidate-preflight-gate.js";
import {
  asNumber,
  auditParlayLegs,
  auditSelection,
  isManualProvider,
  isRunLineDiagnosticProvider
} from "./audit-guardrails.js";

const ACTIVE_FOOTBALL_FAIR_ODDS_MODEL = process.env.FOOTBALL_FAIR_ODDS_ACTIVE_VERSION === "v2"
  ? "sports_data_hub_football_fair_odds_v2"
  : "sports_data_hub_football_fair_odds_v3";

const opportunitiesQuerySchema = z.object({
  model_name: z.string().min(1).max(80).optional(),
  min_confidence: z.coerce.number().min(0).max(1).default(0),
  max_age_minutes: z.coerce.number().int().positive().max(24 * 60).default(60),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const performanceQuerySchema = z.object({
  model_name: z.string().min(1).max(80).optional(),
  active_only: z.coerce.boolean().default(true),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const liveBoardQuerySchema = z.object({
  sport: z.string().min(1).max(40).optional(),
  model_name: z.string().min(1).max(80).optional(),
  status: z.enum(["scheduled", "live", "finished", "postponed", "cancelled"]).optional(),
  min_confidence: z.coerce.number().min(0).max(1).default(0),
  max_age_minutes: z.coerce.number().int().positive().max(24 * 60).default(180),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const alphaQuerySchema = z.object({
  model_name: z.string().min(1).max(80).optional(),
  sport: z.string().min(1).max(40).optional(),
  processed: z.preprocess((value) => {
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") {
        return true;
      }
      if (value.toLowerCase() === "false") {
        return false;
      }
    }
    return value;
  }, z.boolean().optional()),
  min_ev: z.coerce.number().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const smartSelectionQuerySchema = z.object({
  sport: z.string().min(1).max(40).optional(),
  model_name: z.string().min(1).max(80).optional(),
  min_ev: z.coerce.number().default(0.05),
  min_confidence: z.coerce.number().min(0).max(1).default(0),
  max_model_age_minutes: z.coerce.number().int().positive().max(24 * 60).default(240),
  max_market_age_minutes: z.coerce.number().int().positive().max(24 * 60).default(30),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const ownedFairOddsBridgeQuerySchema = z.object({
  match_id: z.string().uuid().optional(),
  sport: z.string().min(1).max(40).default("soccer"),
  model_name: z.string().min(1).max(80).default(ACTIVE_FOOTBALL_FAIR_ODDS_MODEL),
  mode: z.enum(["live", "historical"]).default("live"),
  date: z.string().optional(),
  min_ev: z.coerce.number().default(0.03),
  min_confidence: z.coerce.number().min(0).max(1).default(0),
  min_shadow_confidence: z.coerce.number().min(0).max(1).default(0.5),
  max_model_age_minutes: z.coerce.number().int().positive().max(90 * 24 * 60).default(1440),
  max_market_age_minutes: z.coerce.number().int().positive().max(90 * 24 * 60).default(240),
  limit: z.coerce.number().int().min(1).max(300).default(80)
});

const ownedFairOddsShadowRegisterQuerySchema = ownedFairOddsBridgeQuerySchema.extend({
  dry_run: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return true;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
      if (["true", "1", "yes", "y", "si", "sí", "on"].includes(normalized)) return true;
    }
    return value;
  }, z.boolean()).default(true),
  apply: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return false;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "y", "si", "sí", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
    }
    return value;
  }, z.boolean()).default(false)
});

const parlayQuerySchema = z.object({
  model_name: z.string().min(1).max(80).optional(),
  sport: z.string().min(1).max(40).optional(),
  processed: z.preprocess((value) => {
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") {
        return true;
      }
      if (value.toLowerCase() === "false") {
        return false;
      }
    }
    return value;
  }, z.boolean().optional().default(false)),
  min_ev: z.coerce.number().default(0.05),
  max_age_minutes: z.coerce.number().int().positive().max(24 * 60).default(1440),
  limit: z.coerce.number().int().min(1).max(200).default(80)
});

const clvLabQuerySchema = z.object({
  sport: z.string().min(1).max(40).optional(),
  league_slug: z.string().min(1).max(80).optional(),
  market_type: z.string().min(1).max(80).optional(),
  min_closed: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const alphaProcessParamsSchema = z.object({
  id: z.string().uuid()
});

const alphaProcessBodySchema = z.object({
  processed: z.boolean().default(true),
  note: z.string().max(500).optional()
});

type ParlayLeg = {
  id: string;
  match_id: string;
  sport_slug: string;
  league_slug: string;
  model_name: string;
  provider_name: string;
  market_type: string;
  line: string | number | null;
  market_selection: string;
  home_team_name: string | null;
  away_team_name: string | null;
  model_probability: string | number;
  market_odds: string | number;
  expected_value: string | number;
  confidence: string | number | null;
  processed: boolean;
  audit_status?: string;
  allow_real_bet?: boolean;
  audit_reason?: string;
  review_type?: string | null;
  age_seconds?: string | number | null;
  detected_at: string;
};

function correlationPenalty(legs: ParlayLeg[]) {
  let sameLeaguePairs = 0;
  let sameSportPairs = 0;
  for (let i = 0; i < legs.length; i += 1) {
    for (let j = i + 1; j < legs.length; j += 1) {
      if (legs[i].league_slug === legs[j].league_slug) {
        sameLeaguePairs += 1;
      } else if (legs[i].sport_slug === legs[j].sport_slug) {
        sameSportPairs += 1;
      }
    }
  }
  return Math.pow(0.94, sameLeaguePairs) * Math.pow(0.98, sameSportPairs);
}

function buildParlay(kind: string, label: string, targetLegs: number, stakeFraction: number, candidates: ParlayLeg[]) {
  const legs = candidates.slice(0, targetLegs);
  if (legs.length < targetLegs) {
    return {
      kind,
      label,
      status: "insufficient_legs",
      needed_legs: targetLegs,
      available_legs: candidates.length,
      stake_fraction: stakeFraction,
      reason: `Faltan ${targetLegs - candidates.length} selecciones para construir este parlay sin forzarlo.`,
      legs
    };
  }

  const estimatedOdds = legs.reduce((acc, leg) => acc * asNumber(leg.market_odds), 1);
  const rawProbability = legs.reduce((acc, leg) => acc * asNumber(leg.model_probability), 1);
  const penalty = correlationPenalty(legs);
  const adjustedProbability = rawProbability * penalty;
  const expectedValue = adjustedProbability * estimatedOdds - 1;
  const parlayAudit = auditParlayLegs(legs);

  return {
    kind,
    label,
    status: parlayAudit.status,
    real_bet_allowed: parlayAudit.real_bet_allowed,
    note: parlayAudit.real_bet_allowed ? "Real bookmaker legs passed audit." : "Contiene picks Shadow/manuales. Solo paper trading.",
    legs_count: legs.length,
    stake_fraction: stakeFraction,
    estimated_odds: Number(estimatedOdds.toFixed(4)),
    raw_model_probability: Number(rawProbability.toFixed(6)),
    correlation_penalty: Number(penalty.toFixed(6)),
    adjusted_probability: Number(adjustedProbability.toFixed(6)),
    expected_value: Number(expectedValue.toFixed(6)),
    legs
  };
}

export async function modelQuoteRoutes(app: FastifyInstance) {
  app.get("/api/v1/internal/model-quotes/opportunities", async (request) => {
    const query = opportunitiesQuerySchema.parse(request.query);
    const values: Array<string | number> = [
      query.min_confidence,
      query.max_age_minutes,
      query.limit
    ];
    const modelFilter = query.model_name
      ? `AND mq.model_name = $${values.push(query.model_name)}`
      : "";

    const result = await db.query(
      `
        WITH latest_model_quotes AS (
          SELECT DISTINCT ON (mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999))
            mq.*
          FROM model_quotes mq
          WHERE mq.confidence >= $1
            AND mq.generated_at >= NOW() - ($2::int * INTERVAL '1 minute')
            ${modelFilter}
          ORDER BY mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999), mq.generated_at DESC
        )
        SELECT
          mq.id,
          mq.match_id,
          mq.model_name,
          mq.market_type,
          mq.line,
          mq.home_probability,
          mq.away_probability,
          mq.draw_probability,
          mq.home_fair_odds,
          mq.away_fair_odds,
          mq.draw_fair_odds,
          mq.confidence,
          mq.generated_at,
          m.match_date,
          m.status,
          pem.provider_name,
          pem.provider_event_id,
          COALESCE(pem.home_team_name, home_comp.team_name) AS home_team_name,
          COALESCE(pem.away_team_name, away_comp.team_name) AS away_team_name
        FROM latest_model_quotes mq
        JOIN v_valid_matches m ON m.id = mq.match_id
        LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = mq.match_id AND pem.is_active = TRUE
        LEFT JOIN LATERAL (
          SELECT t.name AS team_name
          FROM match_competitors mc
          JOIN teams t ON t.id = mc.team_id
          WHERE mc.match_id = mq.match_id AND mc.home_away = 'home'
          LIMIT 1
        ) home_comp ON TRUE
        LEFT JOIN LATERAL (
          SELECT t.name AS team_name
          FROM match_competitors mc
          JOIN teams t ON t.id = mc.team_id
          WHERE mc.match_id = mq.match_id AND mc.home_away = 'away'
          LIMIT 1
        ) away_comp ON TRUE
        ORDER BY mq.confidence DESC, mq.generated_at DESC
        LIMIT $3;
      `,
      values
    );

    const opportunities = result.rows.map((row) => ({
      ...row,
      ...auditSelection({
        provider_name: row.provider_name,
        processed: row.processed,
        sport_slug: row.sport_slug,
        league_slug: row.league_slug,
        market_type: row.market_type,
        market_selection: row.market_selection,
        line: row.line,
        market_odds: row.market_odds,
        model_fair_odds: row.model_fair_odds,
        model_probability: row.model_probability,
        expected_value: row.expected_value,
        market_age_seconds: row.market_age_seconds
      })
    }));

    return {
      count: opportunities.length,
      opportunities
    };
  });

  app.get("/api/v1/internal/model-quotes/performance", async (request) => {
    const query = performanceQuerySchema.parse(request.query);
    const values: Array<string | number | boolean> = [query.limit];
    const modelFilter = query.model_name
      ? `AND model_name = $${values.push(query.model_name)}`
      : "";
    const activeFilter = query.active_only
      ? `AND is_active = $${values.push(true)}`
      : "";

    const result = await db.query(
      `
        SELECT
          id,
          model_name,
          home_pitching_weight,
          home_offense_weight,
          home_bullpen_weight,
          home_field_weight,
          brier_score,
          sample_size,
          accuracy,
          bias_home,
          notes,
          is_active,
          updated_at
        FROM model_parameters
        WHERE TRUE
          ${modelFilter}
          ${activeFilter}
        ORDER BY updated_at DESC
        LIMIT $1;
      `,
      values
    );

    return {
      count: result.rows.length,
      performance: result.rows
    };
  });

  app.get("/api/v1/internal/model-quotes/live-board", async (request) => {
    const query = liveBoardQuerySchema.parse(request.query);
    const values: Array<string | number> = [
      query.min_confidence,
      query.max_age_minutes,
      query.limit
    ];
    const sportFilter = query.sport
      ? `AND s.slug = $${values.push(query.sport)}`
      : "";
    const modelFilter = query.model_name
      ? `AND mq.model_name = $${values.push(query.model_name)}`
      : "";
    const statusFilter = query.status
      ? `AND m.status::text = $${values.push(query.status)}`
      : `AND m.status::text IN ('scheduled', 'live')`;

    const result = await db.query(
      `
        WITH latest_model_quotes AS (
          SELECT DISTINCT ON (mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999))
            mq.*
          FROM model_quotes mq
          JOIN v_valid_matches m ON m.id = mq.match_id
          JOIN leagues l ON l.id = m.league_id
          JOIN sports s ON s.id = l.sport_id
          WHERE mq.confidence >= $1
            AND mq.generated_at >= NOW() - ($2::int * INTERVAL '1 minute')
            ${modelFilter}
            ${sportFilter}
            ${statusFilter}
          ORDER BY mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999), mq.generated_at DESC
        )
        , enriched AS (
          SELECT
            mq.id,
            mq.match_id,
            s.slug AS sport_slug,
            l.slug AS league_slug,
            mq.model_name,
            mq.market_type,
            mq.line,
            m.status,
            m.match_date,
            COALESCE(pem.home_team_name, home_comp.team_name) AS home_team_name,
            COALESCE(pem.away_team_name, away_comp.team_name) AS away_team_name,
            mq.home_probability,
            mq.draw_probability,
            mq.away_probability,
            mq.home_fair_odds,
            mq.draw_fair_odds,
            mq.away_fair_odds,
            mq.confidence,
            CASE
              WHEN mq.draw_probability IS NOT NULL
                AND mq.draw_probability >= mq.home_probability
                AND mq.draw_probability >= mq.away_probability
                THEN COALESCE(mq.raw_data #>> '{selection_map,draw}', 'draw')
              WHEN mq.home_probability >= mq.away_probability THEN COALESCE(mq.raw_data #>> '{selection_map,home}', 'home')
              ELSE COALESCE(mq.raw_data #>> '{selection_map,away}', 'away')
            END AS best_selection,
            CASE
              WHEN mq.draw_probability IS NOT NULL
                AND mq.draw_probability >= mq.home_probability
                AND mq.draw_probability >= mq.away_probability
                THEN mq.draw_fair_odds
              WHEN mq.home_probability >= mq.away_probability THEN mq.home_fair_odds
              ELSE mq.away_fair_odds
            END AS best_fair_odds,
            mq.generated_at
          FROM latest_model_quotes mq
          JOIN v_valid_matches m ON m.id = mq.match_id
          JOIN leagues l ON l.id = m.league_id
          JOIN sports s ON s.id = l.sport_id
          LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = mq.match_id AND pem.is_active = TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = mq.match_id AND mc.home_away = 'home'
            LIMIT 1
          ) home_comp ON TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = mq.match_id AND mc.home_away = 'away'
            LIMIT 1
          ) away_comp ON TRUE
        ),
        deduped AS (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY
                league_slug,
                LEAST(
                  regexp_replace(lower(COALESCE(home_team_name, match_id::text)), '[^a-z0-9]+', '', 'g'),
                  regexp_replace(lower(COALESCE(away_team_name, match_id::text)), '[^a-z0-9]+', '', 'g')
                ),
                GREATEST(
                  regexp_replace(lower(COALESCE(home_team_name, match_id::text)), '[^a-z0-9]+', '', 'g'),
                  regexp_replace(lower(COALESCE(away_team_name, match_id::text)), '[^a-z0-9]+', '', 'g')
                ),
                model_name,
                market_type,
                COALESCE(line, -9999)
              ORDER BY confidence DESC, generated_at DESC, match_date DESC
            ) AS event_rank
          FROM enriched
        )
        SELECT
          id,
          match_id,
          sport_slug,
          league_slug,
          model_name,
          market_type,
          line,
          status,
          match_date,
          home_team_name,
          away_team_name,
          home_probability,
          draw_probability,
          away_probability,
          home_fair_odds,
          draw_fair_odds,
          away_fair_odds,
          confidence,
          best_selection,
          best_fair_odds,
          generated_at
        FROM deduped
        WHERE event_rank = 1
        ORDER BY confidence DESC, generated_at DESC
        LIMIT $3;
      `,
      values
    );

    return {
      count: result.rows.length,
      board: result.rows
    };
  });

  async function buildOwnedFairOddsBridge(rawQuery: unknown = {}) {
    const query = ownedFairOddsBridgeQuerySchema.parse(rawQuery);
    const maxModelAgeMinutes = query.mode === "historical"
      ? Math.max(query.max_model_age_minutes, 90 * 24 * 60)
      : query.max_model_age_minutes;
    const maxMarketAgeMinutes = query.mode === "historical"
      ? Math.max(query.max_market_age_minutes, 90 * 24 * 60)
      : query.max_market_age_minutes;
    const values: Array<string | number> = [
      query.model_name,
      query.sport,
      query.min_confidence,
      maxModelAgeMinutes,
      maxMarketAgeMinutes,
      query.min_ev,
      query.limit,
      query.date ?? "",
      query.mode,
      query.min_shadow_confidence,
      query.match_id ?? ""
    ];

    const result = await db.query(
      `
        WITH latest_model_quotes AS (
          SELECT DISTINCT ON (mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999))
            mq.*
          FROM model_quotes mq
          JOIN v_valid_matches m ON m.id = mq.match_id
          JOIN leagues l ON l.id = m.league_id
          JOIN sports s ON s.id = l.sport_id
          WHERE mq.model_name = $1
            AND s.slug = $2
            AND mq.confidence >= $3
            AND ($11::text = '' OR mq.match_id = $11::uuid)
            AND (
              ($8::text = '' AND mq.generated_at >= NOW() - ($4::int * INTERVAL '1 minute'))
              OR (
                $8::text <> ''
                AND m.match_date >= (($8::date)::timestamp AT TIME ZONE 'America/Matamoros')
                AND m.match_date < ((($8::date + 1)::timestamp) AT TIME ZONE 'America/Matamoros')
              )
            )
            AND (
              ($9::text = 'historical' AND m.status::text IN ('scheduled', 'live', 'finished', 'postponed', 'cancelled'))
              OR ($9::text = 'live' AND m.status::text IN ('scheduled', 'live'))
            )
          ORDER BY mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999), mq.generated_at DESC
        ),
        model_selections AS (
          SELECT
            mq.id AS model_quote_id,
            mq.match_id,
            s.slug AS sport_slug,
            l.slug AS league_slug,
            mq.model_name,
            mq.market_type,
            mq.line,
            m.status,
            m.match_date,
            COALESCE(pem.home_team_name, home_comp.team_name) AS home_team_name,
            COALESCE(pem.away_team_name, away_comp.team_name) AS away_team_name,
            mq.confidence,
            mq.generated_at,
            COALESCE(mq.raw_data->>'model_family', 'unknown') AS model_family,
            COALESCE(mq.raw_data->>'calibration_state', 'UNKNOWN') AS calibration_state,
            COALESCE((mq.raw_data->>'champion_model_ready')::boolean, false) AS champion_model_ready,
            COALESCE((mq.raw_data->>'analysis_only')::boolean, false) AS analysis_only,
            CASE
              WHEN s.slug = 'soccer'
                AND mq.market_type <> 'over_under_2_5'
                AND l.slug LIKE 'football-observed-uefa-%'
                AND (
                  l.slug LIKE '%champions-league-qualification%'
                  OR l.slug LIKE '%europa-league-qualification%'
                  OR l.slug LIKE '%europa-conference-league%'
                )
              THEN TRUE
              ELSE COALESCE((mq.raw_data->>'promotion_allowed')::boolean, true)
            END AS promotion_allowed,
            selection.market_selection,
            selection.model_probability,
            selection.model_fair_odds,
            selection.min_market_odds_for_ev
          FROM latest_model_quotes mq
          JOIN v_valid_matches m ON m.id = mq.match_id
          JOIN leagues l ON l.id = m.league_id
          JOIN sports s ON s.id = l.sport_id
          LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = mq.match_id AND pem.is_active = TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = mq.match_id AND mc.home_away = 'home'
            LIMIT 1
          ) home_comp ON TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = mq.match_id AND mc.home_away = 'away'
            LIMIT 1
          ) away_comp ON TRUE
          CROSS JOIN LATERAL (
            VALUES
              (
                COALESCE(
                  mq.raw_data #>> ARRAY['selection_map', 'home'],
                  CASE WHEN mq.market_type LIKE 'over_under%' THEN 'over' ELSE 'home' END
                ),
                mq.home_probability,
                mq.home_fair_odds,
                ((mq.raw_data #>> ARRAY['min_market_odds_for_ev', 'home'])::numeric)
              ),
              (
                COALESCE(
                  mq.raw_data #>> ARRAY['selection_map', 'away'],
                  CASE WHEN mq.market_type LIKE 'over_under%' THEN 'under' ELSE 'away' END
                ),
                mq.away_probability,
                mq.away_fair_odds,
                ((mq.raw_data #>> ARRAY['min_market_odds_for_ev', 'away'])::numeric)
              ),
              (
                COALESCE(mq.raw_data #>> ARRAY['selection_map', 'draw'], 'draw'),
                mq.draw_probability,
                mq.draw_fair_odds,
                ((mq.raw_data #>> ARRAY['min_market_odds_for_ev', 'draw'])::numeric)
              )
          ) AS selection(market_selection, model_probability, model_fair_odds, min_market_odds_for_ev)
          WHERE selection.model_probability IS NOT NULL
            AND selection.model_fair_odds IS NOT NULL
            AND NOT (COALESCE(mq.raw_data->'disabled_selections', '[]'::jsonb) ? selection.market_selection)
        ),
        latest_market_quotes AS (
          SELECT DISTINCT ON (mk.match_id, mk.provider_name, mk.market_type, COALESCE(mk.line, -9999))
            mk.*
          FROM market_quotes mk
          ORDER BY mk.match_id, mk.provider_name, mk.market_type, COALESCE(mk.line, -9999), mk.captured_at DESC
        ),
        bridged AS (
          SELECT
            ms.*,
            best_market.market_quote_id,
            best_market.provider_name,
            best_market.bookmaker,
            best_market.source_label,
            best_market.source_url,
            best_market.verified_by,
            best_market.captured_at,
            best_market.market_odds,
            best_market.market_implied_probability,
            best_market.market_no_vig_probability,
            best_market.market_overround,
            CASE
              WHEN best_market.market_odds IS NULL THEN NULL
              ELSE ROUND(((ms.model_probability * best_market.market_odds) - 1)::numeric, 6)
            END AS expected_value,
            CASE
              WHEN best_market.market_odds IS NULL OR ms.model_fair_odds IS NULL THEN NULL
              ELSE ROUND(((best_market.market_odds / ms.model_fair_odds) - 1)::numeric, 6)
            END AS edge_to_fair,
            CASE
              WHEN ms.model_probability IS NULL OR ms.model_probability = 0 THEN NULL
              ELSE ROUND((1.03 / ms.model_probability)::numeric, 4)
            END AS min_odds_for_ev_3,
            CASE
              WHEN ms.model_probability IS NULL OR ms.model_probability = 0 THEN NULL
              ELSE ROUND((1.05 / ms.model_probability)::numeric, 4)
            END AS min_odds_for_ev_5,
            CASE
              WHEN best_market.market_no_vig_probability IS NULL OR ms.model_probability IS NULL THEN NULL
              ELSE ROUND((ms.model_probability - best_market.market_no_vig_probability)::numeric, 6)
            END AS model_vs_market_gap
          FROM model_selections ms
          LEFT JOIN LATERAL (
            SELECT
              mk.id AS market_quote_id,
              mk.provider_name,
              NULLIF(mk.raw_data->>'bookmaker', '') AS bookmaker,
              NULLIF(mk.raw_data->>'source_label', '') AS source_label,
              NULLIF(COALESCE(mk.raw_data->>'source_url', mk.raw_data->>'source_reference'), '') AS source_url,
              NULLIF(mk.raw_data->>'verified_by', '') AS verified_by,
              mk.captured_at,
              market_selection.market_odds,
              CASE
                WHEN market_selection.market_odds IS NULL OR market_selection.market_odds <= 1 THEN NULL
                ELSE ROUND((1 / market_selection.market_odds)::numeric, 6)
              END AS market_implied_probability,
              CASE
                WHEN market_selection.market_odds IS NULL OR market_selection.market_odds <= 1 OR market_probabilities.market_overround IS NULL OR market_probabilities.market_overround = 0 THEN NULL
                ELSE ROUND(((1 / market_selection.market_odds) / market_probabilities.market_overround)::numeric, 6)
              END AS market_no_vig_probability,
              ROUND(market_probabilities.market_overround::numeric, 6) AS market_overround
            FROM latest_market_quotes mk
            CROSS JOIN LATERAL (
              VALUES
                (
                  COALESCE(
                    mk.raw_data #>> ARRAY['selection_map', 'home'],
                    CASE WHEN mk.market_type LIKE 'over_under%' THEN 'over' ELSE 'home' END
                  ),
                  mk.home_odds
                ),
                (
                  COALESCE(
                    mk.raw_data #>> ARRAY['selection_map', 'away'],
                    CASE WHEN mk.market_type LIKE 'over_under%' THEN 'under' ELSE 'away' END
                  ),
                  mk.away_odds
                ),
                (COALESCE(mk.raw_data #>> ARRAY['selection_map', 'draw'], 'draw'), mk.draw_odds)
            ) AS market_selection(market_selection, market_odds)
            CROSS JOIN LATERAL (
              SELECT SUM(1 / odds_value)::numeric AS market_overround
              FROM (
                VALUES (mk.home_odds), (mk.away_odds), (mk.draw_odds)
              ) AS odds(odds_value)
              WHERE odds_value IS NOT NULL AND odds_value > 1
            ) market_probabilities
            WHERE mk.match_id = ms.match_id
              AND mk.market_type = ms.market_type
              AND COALESCE(mk.line, -9999) = COALESCE(ms.line, -9999)
              AND market_selection.market_selection = ms.market_selection
              AND market_selection.market_odds IS NOT NULL
            ORDER BY
              CASE WHEN mk.captured_at >= NOW() - ($5::int * INTERVAL '1 minute') THEN 0 ELSE 1 END,
              market_selection.market_odds DESC,
              mk.captured_at DESC
            LIMIT 1
          ) best_market ON TRUE
        )
        SELECT
          *,
          CASE
            WHEN analysis_only THEN 'ANALYSIS_ONLY'
            WHEN NOT promotion_allowed THEN 'PROMOTION_NOT_ALLOWED'
            WHEN $9::text = 'historical' AND market_quote_id IS NOT NULL THEN 'HISTORICAL_COMPARISON'
            WHEN market_quote_id IS NULL THEN 'MARKET_ODDS_MISSING'
            WHEN LOWER(provider_name) LIKE '%manual%' AND verified_by IS NULL THEN 'MANUAL_ODDS_UNVERIFIED'
            WHEN captured_at < NOW() - ($5::int * INTERVAL '1 minute') THEN 'STALE_MARKET_ODDS'
            WHEN sport_slug = 'soccer' AND calibration_state IN ('UNCALIBRATED_PRIOR', 'CALIBRATING') AND expected_value > 0 THEN 'CALIBRATING'
            WHEN expected_value >= $6 AND confidence >= $10 THEN 'READY_FOR_SHADOW_REVIEW'
            WHEN expected_value >= $6 THEN 'MODEL_CONFIDENCE_REVIEW'
            WHEN expected_value > 0 THEN 'POSITIVE_EV_WATCH'
            WHEN market_odds < COALESCE(min_market_odds_for_ev, min_odds_for_ev_3) THEN 'NO_BET_PRICE_TOO_LOW'
            ELSE 'NO_EDGE'
          END AS bridge_status,
          CASE
            WHEN analysis_only THEN 'Modelo preparado, pero este mercado sigue analysis-only.'
            WHEN NOT promotion_allowed THEN 'Cuota real comparada, pero la liga/mercado no permite promocion automatica.'
            WHEN $9::text = 'historical' AND market_quote_id IS NOT NULL THEN 'Comparacion historica contra cuota real antigua; auditoria solamente, no promueve picks.'
            WHEN market_quote_id IS NULL THEN 'Falta cuota real de mercado para comparar contra nuestra linea.'
            WHEN sport_slug = 'soccer' AND calibration_state IN ('UNCALIBRATED_PRIOR', 'CALIBRATING') AND expected_value > 0 THEN 'EV detectado, pero el modelo de futbol esta en CALIBRATING; exige Brier/log loss/CLV antes de Shadow serio.'
            WHEN expected_value >= $6 AND confidence >= $10 THEN 'Cuota real supera nuestra cuota minima y la confianza minima; revisar Shadow Paper.'
            WHEN expected_value >= $6 THEN 'EV positivo, pero la confianza del modelo propio aun no alcanza para Shadow Review.'
            WHEN expected_value > 0 THEN 'EV positivo pequeño; observar sin promover.'
            ELSE 'La cuota real no supera nuestra linea propia.'
          END AS recommendation,
          EXTRACT(EPOCH FROM (NOW() - generated_at))::int AS model_age_seconds,
          EXTRACT(EPOCH FROM (NOW() - captured_at))::int AS market_age_seconds
        FROM bridged
        ORDER BY
          CASE
            WHEN analysis_only THEN 5
            WHEN NOT promotion_allowed THEN 4
            WHEN market_quote_id IS NULL THEN 2
            WHEN LOWER(provider_name) LIKE '%manual%' AND verified_by IS NULL THEN 2
            WHEN captured_at < NOW() - ($5::int * INTERVAL '1 minute') THEN 2
            WHEN sport_slug = 'soccer' AND calibration_state IN ('UNCALIBRATED_PRIOR', 'CALIBRATING') AND expected_value > 0 THEN 1
            WHEN expected_value >= $6 AND confidence >= $10 THEN 0
            WHEN expected_value >= $6 THEN 1
            WHEN expected_value > 0 THEN 1
            WHEN market_odds < COALESCE(min_market_odds_for_ev, min_odds_for_ev_3) THEN 3
            ELSE 3
          END,
          expected_value DESC NULLS LAST,
          confidence DESC,
          generated_at DESC
        LIMIT $7;
      `,
      values
    );

    const toNumberOrNull = (value: unknown): number | null => {
      if (value === null || value === undefined || value === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const rows = result.rows.map((row) => {
      const bridgeStatus = String(row.bridge_status ?? "");
      const sportSlug = String(row.sport_slug ?? query.sport ?? "").toLowerCase();
      const marketType = String(row.market_type ?? "").toLowerCase();
      const calibrationState = String(row.calibration_state ?? "").toUpperCase();
      const expectedValue = toNumberOrNull(row.expected_value);
      const marketOdds = toNumberOrNull(row.market_odds);
      const modelProbability = toNumberOrNull(row.model_probability);
      const marketNoVigProbability = toNumberOrNull(row.market_no_vig_probability);
      const modelVsMarketGap = toNumberOrNull(row.model_vs_market_gap);
      const flags: string[] = [];
      const whyYes: string[] = [];
      const whyNo: string[] = [];

      if (row.market_quote_id) whyYes.push("cuota real verificada");
      if (expectedValue !== null && expectedValue > 0) whyYes.push("EV positivo contra fair odds propia");
      if (row.verified_by) whyYes.push("fuente con verificador");
      if (marketNoVigProbability !== null) whyYes.push("probabilidad de mercado sin vig calculada");

      if (sportSlug === "soccer" && expectedValue !== null) {
        if (expectedValue >= 0.6) flags.push("EXTREME_EV_AUDIT");
        if (expectedValue >= 0.3) flags.push("AGGRESSIVE_VALUE_AUDIT");
      }
      if (
        sportSlug === "soccer" &&
        marketType === "moneyline_3way" &&
        marketOdds !== null &&
        expectedValue !== null &&
        marketOdds >= 4 &&
        expectedValue >= 0.25
      ) {
        flags.push("AGGRESSIVE_UNDERDOG");
      }
      if (sportSlug === "soccer" && marketOdds !== null && marketOdds >= 7) {
        flags.push("LONGSHOT_AUDIT");
      }
      if (sportSlug === "soccer" && modelVsMarketGap !== null && Math.abs(modelVsMarketGap) >= 0.12) {
        flags.push("MODEL_MARKET_GAP_HIGH");
      }
      if (sportSlug === "soccer" && ["UNCALIBRATED_PRIOR", "CALIBRATING"].includes(calibrationState)) {
        flags.push(calibrationState === "CALIBRATING" ? "CALIBRATING_CAP" : "UNCALIBRATED_PRIOR_CAP");
        whyNo.push("modelo de futbol en calibracion; no permite Football Confirmed Paper");
      }
      if (flags.includes("AGGRESSIVE_VALUE_AUDIT")) {
        whyNo.push("EV muy alto; requiere closing, settlement y CLV antes de confiar");
      }
      if (flags.includes("MODEL_MARKET_GAP_HIGH") && modelProbability !== null && marketNoVigProbability !== null) {
        whyNo.push("gap modelo vs mercado no-vig alto");
      }
      if (!row.market_quote_id) whyNo.push("falta cuota real usable");
      if (bridgeStatus === "STALE_MARKET_ODDS") whyNo.push("cuota real vieja para el umbral configurado");
      if (bridgeStatus === "MANUAL_ODDS_UNVERIFIED") whyNo.push("cuota manual sin verified_by");
      if (bridgeStatus === "NO_BET_PRICE_TOO_LOW") whyNo.push("precio real debajo del minimo EV");

      const auditStatus = flags.includes("EXTREME_EV_AUDIT")
        ? "EXTREME_EV_AUDIT"
        : flags.includes("AGGRESSIVE_VALUE_AUDIT")
          ? "AGGRESSIVE_VALUE_AUDIT"
          : flags.includes("MODEL_MARKET_GAP_HIGH")
            ? "MODEL_MARKET_GAP_REVIEW"
            : "NORMAL_MARKET_AUDIT";
      const enrichedRow = {
        ...row,
        audit_status: auditStatus,
        audit_flags: Array.from(new Set(flags)),
        why_yes: Array.from(new Set(whyYes)),
        why_no: Array.from(new Set(whyNo)),
        confirmed_pick: false,
        football_confirmed_paper_allowed: false
      };
      if (bridgeStatus === "STALE_MARKET_ODDS") {
        return { ...enrichedRow, recommendation: "La cuota real existe, pero esta vieja para el umbral configurado." };
      }
      if (bridgeStatus === "MANUAL_ODDS_UNVERIFIED") {
        return { ...enrichedRow, recommendation: "Cuota manual sin verified_by; no se usa para Shadow Review." };
      }
      if (bridgeStatus === "NO_BET_PRICE_TOO_LOW") {
        return { ...enrichedRow, recommendation: "La cuota real no paga suficiente contra nuestra fair odds; no hay EV minimo." };
      }
      if (flags.includes("AGGRESSIVE_VALUE_AUDIT") && bridgeStatus === "READY_FOR_SHADOW_REVIEW") {
        return { ...enrichedRow, recommendation: "Shadow Review valido, pero con auditoria agresiva por EV/gap; exigir closing y settlement." };
      }
      return enrichedRow;
    });
    const count = (status: string) => rows.filter((row) => row.bridge_status === status).length;
    const countFlag = (flag: string) => rows.filter((row) => (row.audit_flags || []).includes(flag)).length;

    return {
      system_status: "OWNED_FAIR_ODDS_MARKET_BRIDGE",
      model_name: query.model_name,
      sport: query.sport,
      mode: query.mode,
      match_id: query.match_id ?? null,
      date: query.date ?? null,
      min_ev: query.min_ev,
      min_shadow_confidence: query.min_shadow_confidence,
      count: rows.length,
      summary: {
        ready_for_shadow_review: count("READY_FOR_SHADOW_REVIEW"),
        calibrating: count("CALIBRATING"),
        model_confidence_review: count("MODEL_CONFIDENCE_REVIEW"),
        positive_ev_watch: count("POSITIVE_EV_WATCH"),
        market_odds_missing: count("MARKET_ODDS_MISSING"),
        stale_market_odds: count("STALE_MARKET_ODDS"),
        manual_odds_unverified: count("MANUAL_ODDS_UNVERIFIED"),
        no_bet_price_too_low: count("NO_BET_PRICE_TOO_LOW"),
        historical_comparison: count("HISTORICAL_COMPARISON"),
        promotion_not_allowed: count("PROMOTION_NOT_ALLOWED"),
        analysis_only: count("ANALYSIS_ONLY"),
        no_edge: count("NO_EDGE"),
        aggressive_value_audit: countFlag("AGGRESSIVE_VALUE_AUDIT"),
        extreme_ev_audit: countFlag("EXTREME_EV_AUDIT"),
        aggressive_underdog: countFlag("AGGRESSIVE_UNDERDOG"),
        longshot_audit: countFlag("LONGSHOT_AUDIT"),
        model_market_gap_high: countFlag("MODEL_MARKET_GAP_HIGH"),
        uncalibrated_prior_cap: countFlag("UNCALIBRATED_PRIOR_CAP"),
        calibrating_cap: countFlag("CALIBRATING_CAP")
      },
      rows,
      recommendation: count("READY_FOR_SHADOW_REVIEW") > 0
        ? "Hay señales con cuota real arriba de nuestra linea; revisar solo Shadow Paper."
        : "La linea propia ya existe; falta mercado real o EV suficiente para Shadow Review.",
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        shadow_paper_only_for_football: true
      }
    };
  }

  async function registerOwnedFairOddsShadowReview(rawQuery: unknown = {}, rawBody: unknown = {}) {
    const input = {
      ...(rawQuery && typeof rawQuery === "object" ? rawQuery as Record<string, unknown> : {}),
      ...(rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {})
    };
    const query = ownedFairOddsShadowRegisterQuerySchema.parse(input);
    if (query.apply && !query.match_id) {
      throw new AppError(400, "match_id is required when apply=true");
    }
    const dryRun = query.apply ? false : query.dry_run;
    const bridge = await buildOwnedFairOddsBridge({
      match_id: query.match_id,
      sport: query.sport,
      model_name: query.model_name,
      mode: query.mode,
      date: query.date,
      min_ev: query.min_ev,
      min_confidence: query.min_confidence,
      min_shadow_confidence: query.min_shadow_confidence,
      max_model_age_minutes: query.max_model_age_minutes,
      max_market_age_minutes: query.max_market_age_minutes,
      limit: query.limit
    }) as Record<string, any>;

    const rows = Array.isArray(bridge.rows) ? bridge.rows as Array<Record<string, any>> : [];
    const readyRows = rows.filter((row) => String(row.bridge_status || "") === "READY_FOR_SHADOW_REVIEW");
    const hardAuditFlags = new Set([
      "CALIBRATING_CAP",
      "UNCALIBRATED_PRIOR_CAP",
      "MODEL_MARKET_GAP_HIGH",
      "EXTREME_EV_AUDIT"
    ]);
    const auditBlockedRows = readyRows.filter((row) => {
      const flags = Array.isArray(row.audit_flags) ? row.audit_flags.map(String) : [];
      return flags.some((flag) => hardAuditFlags.has(flag));
    });
    const eligibleReadyRows = readyRows.filter((row) => !auditBlockedRows.includes(row));
    const candidateMatchIds = Array.from(new Set(
      eligibleReadyRows.map((row) => String(row.match_id || "")).filter(Boolean)
    ));
    const candidateSnapshots = candidateMatchIds.length > 0
      ? await db.query(
        `
          SELECT DISTINCT ON (match_id)
            match_id,
            id,
            verdict,
            reasons_json,
            decision_as_of,
            verify_candidate_snapshot(id) AS hash_valid
          FROM forecast_candidate_snapshots
          WHERE match_id = ANY($1::uuid[])
            AND decision_as_of >= NOW() - INTERVAL '5 minutes'
          ORDER BY match_id, decision_as_of DESC, created_at DESC
        `,
        [candidateMatchIds]
      )
      : { rows: [] as Record<string, any>[] };
    const candidateSnapshotByMatch = new Map(
      candidateSnapshots.rows.map((row) => [String(row.match_id), row])
    );
    const candidateBlockedRows = eligibleReadyRows.filter((row) => {
      const snapshot = candidateSnapshotByMatch.get(String(row.match_id || ""));
      return !shadowCandidatePreflightPassed(snapshot);
    });
    const candidateEligibleRows = eligibleReadyRows.filter((row) => !candidateBlockedRows.includes(row));
    const selectedMatchIds = new Set<string>();
    const selectedRows = candidateEligibleRows.filter((row) => {
      const matchId = String(row.match_id || "");
      if (!matchId || selectedMatchIds.has(matchId)) return false;
      selectedMatchIds.add(matchId);
      return true;
    });
    const now = new Date();
    const signals = selectedRows
      .filter((row) => {
        const kickoff = new Date(String(row.match_date || ""));
        return Number.isNaN(kickoff.getTime()) || kickoff.getTime() > now.getTime();
      })
      .map((row) => {
        const sourceUrl = String(row.source_url || "").trim();
        const sourceLabel = String(row.source_label || row.bookmaker || row.provider_name || "verified_market_quote").trim();
        const consensusEvidence = sourceUrl || sourceLabel;
        const auditFlags = Array.isArray(row.audit_flags) ? row.audit_flags : [];
        return {
          match_id: String(row.match_id),
          league_id: String(row.league_slug || ""),
          league: String(row.league_slug || ""),
          market: String(row.market_type),
          selection: String(row.market_selection),
          home_team: String(row.home_team_name || ""),
          away_team: String(row.away_team_name || ""),
          model_version: String(row.model_name || query.model_name),
          provider: String(row.provider_name || "verified_market_quote_bridge"),
          model_probability: Number(row.model_probability),
          market_odds: Number(row.market_odds),
          expected_value: Number(row.expected_value),
          bankroll_allocation: 0.01,
          raw_data: {
            source: sourceLabel,
            source_label: sourceLabel,
            source_url: sourceUrl || null,
            bookmaker: row.bookmaker || row.provider_name || "verified_market_quote",
            verified_by: row.verified_by || "sports_data_hub_market_bridge",
            odds_timestamp: row.captured_at,
            entry_odds: Number(row.market_odds),
            entry_odds_timestamp: row.captured_at,
            model_quote_id: row.model_quote_id,
            market_quote_id: row.market_quote_id,
            model_name: row.model_name || query.model_name,
            model_family: row.model_family || "football_context_prior_v1",
            calibration_state: row.calibration_state || "UNKNOWN",
            champion_model_ready: row.champion_model_ready === true,
            market_implied_probability: row.market_implied_probability ?? null,
            market_no_vig_probability: row.market_no_vig_probability ?? null,
            market_overround: row.market_overround ?? null,
            model_vs_market_gap: row.model_vs_market_gap ?? null,
            edge_to_fair: row.edge_to_fair ?? null,
            min_odds_for_ev_3: row.min_odds_for_ev_3 ?? null,
            min_odds_for_ev_5: row.min_odds_for_ev_5 ?? null,
            bridge_status: row.bridge_status,
            bridge_recommendation: row.recommendation,
            audit_status: row.audit_status,
            audit_flags: auditFlags,
            why_yes: row.why_yes || [],
            why_no: row.why_no || [],
            settlement_type: "SHADOW_REVIEW_RESULT",
            shadow_review_registered_from_bridge: true,
            shadow_paper_only: true,
            confirmed_pick: false,
            football_confirmed_paper_allowed: false,
            real_money_enabled: false,
            kelly_enabled: false,
            telegram_auto_enabled: false,
            requires_closing_snapshot: true,
            requires_shadow_settlement: true,
            requires_segment_calibration: true,
            kickoff_trusted: true,
            validation_status: "VERIFIED_MARKET_BRIDGE",
            source_consensus: "official_or_verified_market_quote_bridge",
            consensus_verified: true,
            consensus_evidence_url: consensusEvidence
          }
        };
      })
      .filter((signal) => {
        return signal.match_id
          && signal.league_id
          && signal.market
          && signal.selection
          && signal.home_team
          && signal.away_team
          && Number.isFinite(signal.model_probability)
          && Number.isFinite(signal.market_odds)
          && Number.isFinite(signal.expected_value);
      });

    const postKickoffSkipped = selectedRows.length - signals.length;
    const feed = await processFootballShadowFeed(db, {
      dry_run: dryRun,
      signals: signals as Parameters<typeof processFootballShadowFeed>[1]["signals"]
    }) as Record<string, any>;

    return {
      system_status: "FOOTBALL_OWNED_FAIR_ODDS_SHADOW_REVIEW_REGISTER",
      match_id: query.match_id ?? null,
      date: query.date ?? null,
      dry_run: dryRun,
      apply_requested: query.apply,
      bridge_summary: bridge.summary,
      scanned_bridge_rows: rows.length,
      ready_for_shadow_review: readyRows.length,
      audit_blocked: auditBlockedRows.length,
      candidate_preflight_blocked: candidateBlockedRows.length,
      candidate_preflight_required: true,
      selected_one_per_match: selectedRows.length,
      post_kickoff_skipped: postKickoffSkipped,
      signals_prepared: signals.length,
      feed_summary: {
        would_insert: feed.would_insert,
        inserted: feed.inserted,
        duplicates: feed.duplicates,
        skipped: feed.skipped,
        blocked: feed.blocked,
        errors: feed.errors ?? 0
      },
      rows: feed.rows,
      recommendation: dryRun
        ? "Dry-run listo. Si no hay bloqueos ni placeholders, repetir con apply=true para crear tickets Shadow Paper."
        : "Tickets Shadow Paper registrados; ahora closing/settlement pueden calcular CLV y performance por segmento.",
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        shadow_paper_only_for_football: true,
        football_confirmed_paper_allowed: false
      }
    };
  }

  app.get("/api/v1/internal/model-quotes/owned-fair-odds-bridge", async (request) => buildOwnedFairOddsBridge(request.query));
  app.get("/api/v1/trading/football-owned-fair-odds/bridge", async (request) => buildOwnedFairOddsBridge(request.query));
  app.get("/api/trading/football-owned-fair-odds/bridge", async (request) => buildOwnedFairOddsBridge(request.query));
  app.post("/api/v1/internal/model-quotes/owned-fair-odds-bridge/register-shadow-review", async (request) => registerOwnedFairOddsShadowReview(request.query, request.body));
  app.post("/api/v1/trading/football-owned-fair-odds/bridge/register-shadow-review", async (request) => registerOwnedFairOddsShadowReview(request.query, request.body));
  app.post("/api/trading/football-owned-fair-odds/bridge/register-shadow-review", async (request) => registerOwnedFairOddsShadowReview(request.query, request.body));

  app.get("/api/v1/internal/model-quotes/performance-summary", async (request) => {
    const result = await db.query(
      `
        WITH latest_finished_quotes AS (
          SELECT DISTINCT ON (mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999))
            mq.*,
            settlement_match.home_score,
            settlement_match.away_score,
            s.slug AS sport_slug,
            l.slug AS league_slug
          FROM model_quotes mq
          JOIN v_valid_matches m ON m.id = mq.match_id
          JOIN match_competitors mq_home
            ON mq_home.match_id = m.id
           AND mq_home.home_away = 'home'
          JOIN match_competitors mq_away
            ON mq_away.match_id = m.id
           AND mq_away.home_away = 'away'
          JOIN leagues l ON l.id = m.league_id
          JOIN sports s ON s.id = l.sport_id
          JOIN LATERAL (
            SELECT fm.id, fm.home_score, fm.away_score
            FROM v_valid_matches fm
            JOIN match_competitors final_home
              ON final_home.match_id = fm.id
             AND final_home.home_away = 'home'
             AND final_home.team_id = mq_home.team_id
            JOIN match_competitors final_away
              ON final_away.match_id = fm.id
             AND final_away.home_away = 'away'
             AND final_away.team_id = mq_away.team_id
            WHERE fm.league_id = m.league_id
              AND fm.status = 'finished'
              AND fm.home_score IS NOT NULL
              AND fm.away_score IS NOT NULL
              AND ABS(EXTRACT(EPOCH FROM (fm.match_date - m.match_date))) <= 60 * 60 * 24 * 14
            ORDER BY
              CASE WHEN fm.id = m.id THEN 0 ELSE 1 END,
              fm.match_date DESC,
              fm.updated_at DESC
            LIMIT 1
          ) settlement_match ON TRUE
          WHERE settlement_match.home_score IS NOT NULL
            AND settlement_match.away_score IS NOT NULL
          ORDER BY mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999), mq.generated_at DESC
        ),
        quote_probs AS (
          SELECT
            model_name,
            sport_slug,
            league_slug,
            market_type,
            line,
            home_score,
            away_score,
            COALESCE(raw_data #>> ARRAY['selection_map', 'home'], 'home') AS home_selection,
            COALESCE(raw_data #>> ARRAY['selection_map', 'away'], 'away') AS away_selection,
            'draw' AS draw_selection,
            CASE
              WHEN draw_probability IS NOT NULL
                AND draw_probability >= home_probability
                AND draw_probability >= away_probability
                THEN 'draw'
              WHEN home_probability >= away_probability THEN 'home'
              ELSE 'away'
            END AS best_slot,
            CASE
              WHEN draw_probability IS NOT NULL
                AND draw_probability >= home_probability
                AND draw_probability >= away_probability
                THEN draw_probability
              WHEN home_probability >= away_probability THEN home_probability
              ELSE away_probability
            END AS best_probability,
            CASE
              WHEN draw_probability IS NOT NULL
                AND draw_probability >= home_probability
                AND draw_probability >= away_probability
                THEN draw_fair_odds
              WHEN home_probability >= away_probability THEN home_fair_odds
              ELSE away_fair_odds
            END AS best_fair_odds,
            home_probability,
            away_probability,
            draw_probability
          FROM latest_finished_quotes
        ),
        settled AS (
          SELECT
            model_name,
            sport_slug,
            league_slug,
            market_type,
            line,
            CASE
              WHEN market_type IN ('moneyline_2way', 'moneyline_3way', 'draw_no_bet') THEN 'moneyline'
              WHEN market_type IN ('total_goals_2_5', 'total_runs', 'total_points') THEN 'totals'
              WHEN market_type IN ('run_line', 'spread') THEN 'spread_run_line'
              ELSE market_type
            END AS market_group,
            CASE
              WHEN best_slot = 'home' THEN home_selection
              WHEN best_slot = 'away' THEN away_selection
              ELSE draw_selection
            END AS best_selection,
            best_probability,
            best_fair_odds,
            CASE
              WHEN market_type IN ('draw_no_bet', 'moneyline_2way') AND home_score = away_score THEN 'push'
              WHEN market_type IN ('moneyline_2way', 'moneyline_3way', 'draw_no_bet') AND home_score > away_score THEN 'home'
              WHEN market_type IN ('moneyline_2way', 'moneyline_3way', 'draw_no_bet') AND home_score < away_score THEN 'away'
              WHEN market_type = 'moneyline_3way' AND home_score = away_score THEN 'draw'
              WHEN market_type IN ('total_goals_2_5', 'total_runs', 'total_points') AND line IS NOT NULL AND (home_score + away_score) = line THEN 'push'
              WHEN market_type IN ('total_goals_2_5', 'total_runs', 'total_points') AND line IS NOT NULL AND (home_score + away_score) > line THEN 'over'
              WHEN market_type IN ('total_goals_2_5', 'total_runs', 'total_points') AND line IS NOT NULL AND (home_score + away_score) < line THEN 'under'
              WHEN market_type = 'btts' AND home_score > 0 AND away_score > 0 THEN 'yes'
              WHEN market_type = 'btts' THEN 'no'
              WHEN market_type IN ('run_line', 'spread') AND line IS NOT NULL
                AND (
                  CASE
                    WHEN best_slot = 'home' THEN (home_score - away_score) + line
                    ELSE (away_score - home_score) + line
                  END
                ) = 0 THEN 'push'
              WHEN market_type IN ('run_line', 'spread') AND line IS NOT NULL
                AND (
                  CASE
                    WHEN best_slot = 'home' THEN (home_score - away_score) + line
                    ELSE (away_score - home_score) + line
                  END
                ) > 0 THEN
                  CASE WHEN best_slot = 'home' THEN home_selection ELSE away_selection END
              WHEN market_type IN ('run_line', 'spread') AND line IS NOT NULL THEN
                  CASE WHEN best_slot = 'home' THEN away_selection ELSE home_selection END
              ELSE NULL
            END AS outcome,
            CASE
              WHEN (
                CASE
                  WHEN market_type IN ('draw_no_bet', 'moneyline_2way') AND home_score = away_score THEN 'push'
                  WHEN market_type IN ('moneyline_2way', 'moneyline_3way', 'draw_no_bet') AND home_score > away_score THEN 'home'
                  WHEN market_type IN ('moneyline_2way', 'moneyline_3way', 'draw_no_bet') AND home_score < away_score THEN 'away'
                  WHEN market_type = 'moneyline_3way' AND home_score = away_score THEN 'draw'
                  WHEN market_type IN ('total_goals_2_5', 'total_runs', 'total_points') AND line IS NOT NULL AND (home_score + away_score) = line THEN 'push'
                  WHEN market_type IN ('total_goals_2_5', 'total_runs', 'total_points') AND line IS NOT NULL AND (home_score + away_score) > line THEN 'over'
                  WHEN market_type IN ('total_goals_2_5', 'total_runs', 'total_points') AND line IS NOT NULL AND (home_score + away_score) < line THEN 'under'
                  WHEN market_type = 'btts' AND home_score > 0 AND away_score > 0 THEN 'yes'
                  WHEN market_type = 'btts' THEN 'no'
                  ELSE NULL
                END
              ) = 'push' THEN 0
              WHEN (
                CASE
                  WHEN market_type IN ('draw_no_bet', 'moneyline_2way') AND home_score = away_score THEN 'push'
                  WHEN market_type IN ('moneyline_2way', 'moneyline_3way', 'draw_no_bet') AND home_score > away_score THEN 'home'
                  WHEN market_type IN ('moneyline_2way', 'moneyline_3way', 'draw_no_bet') AND home_score < away_score THEN 'away'
                  WHEN market_type = 'moneyline_3way' AND home_score = away_score THEN 'draw'
                  WHEN market_type IN ('total_goals_2_5', 'total_runs', 'total_points') AND line IS NOT NULL AND (home_score + away_score) > line THEN 'over'
                  WHEN market_type IN ('total_goals_2_5', 'total_runs', 'total_points') AND line IS NOT NULL AND (home_score + away_score) < line THEN 'under'
                  WHEN market_type = 'btts' AND home_score > 0 AND away_score > 0 THEN 'yes'
                  WHEN market_type = 'btts' THEN 'no'
                  ELSE NULL
                END
              ) = (
                CASE WHEN best_slot = 'home' THEN home_selection WHEN best_slot = 'away' THEN away_selection ELSE draw_selection END
              ) THEN best_fair_odds - 1
              ELSE -1
            END AS winning_selection_profit
          FROM quote_probs
        ),
        scored AS (
          SELECT
            model_name,
            sport_slug,
            league_slug,
            market_type,
            line,
            market_group,
            best_selection,
            best_probability,
            best_fair_odds,
            outcome,
            winning_selection_profit,
            CASE
              WHEN outcome = 'push' OR outcome IS NULL THEN NULL
              WHEN outcome = best_selection THEN 1
              ELSE 0
            END AS correct,
            CASE
              WHEN outcome = 'push' OR outcome IS NULL THEN NULL
              WHEN outcome = best_selection
                THEN POWER(best_probability - 1, 2)
              ELSE POWER(best_probability, 2)
            END AS brier_score
          FROM settled
        )
        SELECT
          model_name,
          sport_slug,
          league_slug,
          market_type,
          market_group,
          line,
          COUNT(*)::int AS total_predictions,
          COUNT(*) FILTER (WHERE outcome = 'push')::int AS pushes,
          ROUND(COALESCE(AVG(correct), 0)::numeric, 4) AS accuracy,
          ROUND((COALESCE(AVG(correct), 0) * 100)::numeric, 2) AS accuracy_pct,
          ROUND(AVG(brier_score)::numeric, 6) AS avg_brier_score,
          ROUND(SUM(CASE WHEN correct = 1 THEN winning_selection_profit ELSE -1 END)::numeric, 4) AS theoretical_flat_profit_units
        FROM scored
        GROUP BY model_name, sport_slug, league_slug, market_type, market_group, line
        ORDER BY sport_slug ASC, market_group ASC, avg_brier_score ASC NULLS LAST, total_predictions DESC;
      `
    );

    return {
      count: result.rows.length,
      performance: result.rows
    };
  });

  app.get("/api/v1/internal/model-quotes/alpha-opportunities", async (request) => {
    const query = alphaQuerySchema.parse(request.query);
    const values: Array<string | number | boolean> = [query.min_ev, query.limit];
    const modelFilter = query.model_name
      ? `AND ao.model_name = $${values.push(query.model_name)}`
      : "";
    const sportFilter = query.sport
      ? `AND ao.sport_slug = $${values.push(query.sport)}`
      : "";
    const processedFilter = query.processed !== undefined
      ? `AND ao.processed = $${values.push(query.processed)}`
      : "";

    const result = await db.query(
      `
        WITH enriched AS (
          SELECT
            ao.id,
            ao.match_id,
            ao.sport_slug,
            ao.league_slug,
            ao.model_name,
            ao.provider_name,
            ao.market_type,
            ao.line,
            ao.market_selection,
            COALESCE(pem.home_team_name, home_comp.team_name) AS home_team_name,
            COALESCE(pem.away_team_name, away_comp.team_name) AS away_team_name,
            ao.model_probability,
            ao.model_fair_odds,
            ao.market_odds,
            ao.expected_value,
            ao.processed,
            EXTRACT(EPOCH FROM (NOW() - ao.detected_at))::int AS age_seconds,
            ao.detected_at
          FROM alpha_opportunities ao
          JOIN v_valid_matches m ON m.id = ao.match_id
          LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = ao.match_id AND pem.is_active = TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = ao.match_id AND mc.home_away = 'home'
            LIMIT 1
          ) home_comp ON TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = ao.match_id AND mc.home_away = 'away'
            LIMIT 1
          ) away_comp ON TRUE
          WHERE ao.expected_value >= $1
            ${modelFilter}
            ${sportFilter}
            ${processedFilter}
        ),
        ranked AS (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY
                league_slug,
                LEAST(
                  regexp_replace(lower(COALESCE(home_team_name, match_id::text)), '[^a-z0-9]+', '', 'g'),
                  regexp_replace(lower(COALESCE(away_team_name, match_id::text)), '[^a-z0-9]+', '', 'g')
                ),
                GREATEST(
                  regexp_replace(lower(COALESCE(home_team_name, match_id::text)), '[^a-z0-9]+', '', 'g'),
                  regexp_replace(lower(COALESCE(away_team_name, match_id::text)), '[^a-z0-9]+', '', 'g')
                ),
                model_name,
                provider_name,
                market_type,
                COALESCE(line, -9999),
                market_selection
              ORDER BY detected_at DESC, expected_value DESC
            ) AS event_rank
          FROM enriched
        )
        SELECT
          id,
          match_id,
          sport_slug,
          league_slug,
          model_name,
          provider_name,
          market_type,
          line,
          market_selection,
          home_team_name,
          away_team_name,
          model_probability,
          model_fair_odds,
          market_odds,
          expected_value,
          processed,
          age_seconds,
          detected_at
        FROM ranked
        WHERE event_rank = 1
        ORDER BY expected_value DESC, detected_at DESC
        LIMIT $2;
      `,
      values
    );

    const opportunities = result.rows.map((row) => ({
      ...row,
      ...auditSelection({
        provider_name: row.provider_name,
        processed: row.processed,
        sport_slug: row.sport_slug,
        league_slug: row.league_slug,
        market_type: row.market_type,
        market_selection: row.market_selection,
        line: row.line,
        market_odds: row.market_odds,
        model_fair_odds: row.model_fair_odds,
        model_probability: row.model_probability,
        expected_value: row.expected_value,
        age_seconds: row.age_seconds
      })
    }));

    return {
      count: opportunities.length,
      opportunities
    };
  });

  app.get("/api/v1/internal/model-quotes/alpha-summary", async () => {
    const result = await db.query(
      `
        SELECT
          sport_slug,
          league_slug,
          model_name,
          provider_name,
          market_type,
          line,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE processed = FALSE)::int AS pending,
          COUNT(*) FILTER (WHERE processed = TRUE)::int AS processed,
          ROUND(AVG(expected_value)::numeric, 6) AS avg_expected_value,
          ROUND(AVG(clv)::numeric, 6) AS avg_clv,
          ROUND(MAX(expected_value)::numeric, 6) AS max_expected_value,
          MAX(detected_at) AS latest_detected_at
        FROM alpha_opportunities
        GROUP BY sport_slug, league_slug, model_name, provider_name, market_type, line
        ORDER BY pending DESC, max_expected_value DESC, latest_detected_at DESC;
      `
    );

    return {
      count: result.rows.length,
      summary: result.rows
    };
  });

  app.get("/api/v1/internal/model-quotes/data-health", async () => {
    const result = await db.query(
      `
        SELECT
          ao.sport_slug,
          ao.league_slug,
          ao.provider_name,
          ao.processed AS alpha_processed,
          COALESCE((mk.raw_data->>'processed')::boolean, false) AS quote_processed,
          ao.market_type,
          ao.line,
          ao.market_selection,
          ao.model_probability,
          ao.model_fair_odds,
          ao.market_odds,
          ao.expected_value,
          EXTRACT(EPOCH FROM (NOW() - ao.detected_at))::int AS age_seconds,
          ao.detected_at
        FROM alpha_opportunities ao
        JOIN market_quotes mk ON mk.id = ao.market_quote_id
        ORDER BY ao.detected_at DESC
        LIMIT 2000;
      `
    );

    const counts = {
      total_picks: 0,
      real_candidate: 0,
      real_paper_candidate: 0,
      radar_only: 0,
      review: 0,
      no_bet: 0,
      processed_true: 0,
      processed_false: 0
    };
    const realProviders = new Set<string>();
    const shadowProviders = new Set<string>();
    const reviewTypes = new Map<string, number>();
    let latestReal: string | null = null;
    let latestShadow: string | null = null;

    for (const row of result.rows) {
      const audit = auditSelection({
        provider_name: row.provider_name,
        processed: row.quote_processed,
        sport_slug: row.sport_slug,
        league_slug: row.league_slug,
        market_type: row.market_type,
        market_selection: row.market_selection,
        line: row.line,
        market_odds: row.market_odds,
        model_fair_odds: row.model_fair_odds,
        model_probability: row.model_probability,
        expected_value: row.expected_value,
        age_seconds: row.age_seconds
      });
      const provider = String(row.provider_name ?? "");
      const manual = isManualProvider(provider);

      counts.total_picks += 1;
      if (row.quote_processed === true) {
        counts.processed_true += 1;
      } else {
        counts.processed_false += 1;
      }
      if (manual) {
        shadowProviders.add(provider);
        latestShadow ??= row.detected_at;
      } else if (provider) {
        realProviders.add(provider);
        latestReal ??= row.detected_at;
      }

      if (audit.audit_status === "REAL_CANDIDATE") {
        counts.real_candidate += 1;
      } else if (audit.audit_status === "REAL_PAPER_CANDIDATE") {
        counts.real_paper_candidate += 1;
      } else if (audit.audit_status === "REVIEW") {
        counts.review += 1;
        const reviewType = String(audit.review_type ?? "UNKNOWN_REVIEW");
        reviewTypes.set(reviewType, (reviewTypes.get(reviewType) ?? 0) + 1);
      } else if (audit.audit_status === "NO_BET") {
        counts.no_bet += 1;
      } else {
        counts.radar_only += 1;
      }
    }

    return {
      counts,
      providers: {
        real_active: realProviders.size,
        shadow_active: shadowProviders.size,
        real: Array.from(realProviders).sort(),
        shadow: Array.from(shadowProviders).sort()
      },
      latest: {
        real: latestReal,
        shadow: latestShadow
      },
      review_types: Array.from(reviewTypes.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count)
    };
  });

  app.get("/api/v1/internal/model-quotes/real-paper-summary", async () => {
    const result = await db.query(
      `
        WITH canonical AS (
          SELECT
            rps.*,
            (
              rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
              AND rps.clv IS NOT NULL
              AND rps.raw_data->>'closing_quality' = 'CAPTURED_ON_TIME'
              AND rps.raw_data->>'result_source_verified' = 'true'
              AND rps.raw_data->>'settlement_final' = 'true'
              AND rps.raw_data->>'clv_valid' = 'true'
              AND rps.raw_data->>'clean_v2_eligible' = 'true'
              AND COALESCE(rps.raw_data->>'audit_only', 'true') = 'false'
            ) AS is_clean_v2
          FROM real_paper_snapshots rps
          WHERE rps.duplicate_of_id IS NULL
            AND COALESCE(rps.data_state, 'FRESH') <> 'DUPLICATE'
        )
        SELECT
          sport_slug,
          league_slug,
          model_name,
          market_type,
          line,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
          COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED'))::int AS settled,
          COUNT(*) FILTER (WHERE is_clean_v2)::int AS clean_v2_closed,
          COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED') AND NOT is_clean_v2)::int AS legacy_only_closed,
          ROUND(AVG(expected_value)::numeric, 6) AS avg_expected_value,
          ROUND(AVG(clv) FILTER (WHERE is_clean_v2)::numeric, 6) AS clean_v2_avg_clv,
          ROUND(AVG(clv) FILTER (WHERE NOT is_clean_v2)::numeric, 6) AS legacy_avg_clv,
          ROUND((COALESCE(SUM(profit_loss) FILTER (WHERE is_clean_v2), 0) / 100.0)::numeric, 4) AS clean_v2_profit_units,
          ROUND((COALESCE(SUM(profit_loss) FILTER (WHERE NOT is_clean_v2), 0) / 100.0)::numeric, 4) AS legacy_profit_units,
          ROUND((COALESCE(SUM(profit_loss), 0) / 100.0)::numeric, 4) AS profit_loss_units,
          MAX(entry_timestamp) AS latest_entry_timestamp
        FROM canonical
        GROUP BY sport_slug, league_slug, model_name, market_type, line
        ORDER BY latest_entry_timestamp DESC NULLS LAST, total DESC;
      `
    );

    const excluded = await db.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED'))::int AS legacy_all_closed,
          COUNT(*) FILTER (
            WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
              AND duplicate_of_id IS NULL
              AND COALESCE(data_state, 'FRESH') <> 'DUPLICATE'
              AND COALESCE(raw_data->>'clean_v2_eligible', 'false') <> 'true'
          )::int AS canonical_legacy_closed,
          COUNT(*) FILTER (WHERE duplicate_of_id IS NOT NULL OR COALESCE(data_state, 'FRESH') = 'DUPLICATE')::int AS duplicate_excluded,
          COUNT(*) FILTER (WHERE COALESCE(raw_data->>'audit_only', 'false') = 'true')::int AS audit_only
        FROM real_paper_snapshots;
      `
    );
    const rows = result.rows;
    return {
      count: result.rows.length,
      real_paper: rows,
      summary: {
        clean_v2_closed: rows.reduce((sum, row) => sum + Number(row.clean_v2_closed || 0), 0),
        legacy_only_closed: rows.reduce((sum, row) => sum + Number(row.legacy_only_closed || 0), 0),
        legacy_all_closed: Number(excluded.rows[0]?.legacy_all_closed || 0),
        canonical_legacy_closed: Number(excluded.rows[0]?.canonical_legacy_closed || 0),
        duplicate_excluded: Number(excluded.rows[0]?.duplicate_excluded || 0),
        audit_only: Number(excluded.rows[0]?.audit_only || 0),
        profit_unit_definition: "1u = PAPER_BANKROLL_BASE * 1% (profit_loss stored in bankroll currency and divided by 100 for units)"
      }
    };
  });

  app.get("/api/v1/internal/model-quotes/real-paper-pending-closing", async () => {
    const result = await db.query(
      `
        SELECT
          rps.id,
          rps.event_id,
          rps.match_id,
          rps.sport_slug,
          rps.league_slug,
          rps.model_name,
          rps.market_type,
          rps.line,
          rps.pick,
          rps.bookmaker,
          entry_quote.provider_name,
          rps.entry_odds,
          rps.entry_timestamp,
          rps.model_probability,
          rps.implied_probability,
          rps.expected_value,
          rps.status,
          rps.raw_data->>'closing_odds_source' AS closing_odds_source,
          rps.raw_data->>'closing_required' AS closing_required,
          m.status AS match_status,
          m.match_date,
          m.home_score,
          m.away_score,
          COALESCE(pem.home_team_name, home_comp.team_name) AS home_team_name,
          COALESCE(pem.away_team_name, away_comp.team_name) AS away_team_name,
          latest_quote.id AS latest_quote_id,
          latest_quote.captured_at AS latest_quote_captured_at,
          latest_quote.bookmaker AS latest_quote_bookmaker,
          CASE
            WHEN rps.pick = 'home' THEN latest_quote.home_odds
            WHEN rps.pick = 'away' THEN latest_quote.away_odds
            WHEN rps.pick = 'draw' THEN latest_quote.draw_odds
            ELSE NULL
          END AS latest_same_provider_odds
        FROM real_paper_snapshots rps
        JOIN v_valid_matches m ON m.id = rps.match_id
        JOIN market_quotes entry_quote ON entry_quote.id = rps.market_quote_id
        LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = rps.match_id AND pem.is_active = TRUE
        LEFT JOIN LATERAL (
          SELECT t.name AS team_name
          FROM match_competitors mc
          JOIN teams t ON t.id = mc.team_id
          WHERE mc.match_id = rps.match_id AND mc.home_away = 'home'
          LIMIT 1
        ) home_comp ON TRUE
        LEFT JOIN LATERAL (
          SELECT t.name AS team_name
          FROM match_competitors mc
          JOIN teams t ON t.id = mc.team_id
          WHERE mc.match_id = rps.match_id AND mc.home_away = 'away'
          LIMIT 1
        ) away_comp ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            mq.id,
            mq.captured_at,
            mq.home_odds,
            mq.away_odds,
            mq.draw_odds,
            mq.raw_data->>'bookmaker' AS bookmaker
          FROM market_quotes mq
          WHERE mq.match_id = rps.match_id
            AND mq.provider_name = entry_quote.provider_name
            AND mq.market_type = rps.market_type
            AND COALESCE(mq.line, -9999) = COALESCE(rps.line, -9999)
            AND mq.captured_at > rps.entry_timestamp
          ORDER BY mq.captured_at DESC
          LIMIT 1
        ) latest_quote ON TRUE
        WHERE rps.status = 'PENDING_CLOSING'
        ORDER BY rps.entry_timestamp ASC
        LIMIT 100;
      `
    );

    return {
      count: result.rows.length,
      pending_closing: result.rows
    };
  });

  app.get("/api/v1/internal/model-quotes/portfolio-summary", async () => {
    const realPaperResult = await db.query(
      `
        SELECT
          'real_paper' AS flow,
          sport_slug,
          league_slug,
          model_name,
          market_type,
          line,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
          COUNT(*) FILTER (WHERE status = 'PENDING_CLOSING')::int AS pending_closing,
          COUNT(*) FILTER (WHERE status = 'PENDING_RESULTS')::int AS pending_results,
          COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED'))::int AS closed,
          COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
          COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
          ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
          ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
          ROUND(AVG(expected_value)::numeric, 6) AS avg_expected_value,
          MAX(entry_timestamp) AS latest_activity
        FROM real_paper_snapshots
        GROUP BY sport_slug, league_slug, model_name, market_type, line
      `
    );

    const shadowPaperResult = await db.query(
      `
        SELECT
          'shadow_paper' AS flow,
          CASE
            WHEN league_slug IN ('mlb', 'baseball/mlb') THEN 'baseball'
            WHEN league_slug = 'nba' THEN 'basketball'
            WHEN league_slug LIKE '%world-cup%' OR league_type = 'soccer' THEN 'soccer'
            ELSE league_type
          END AS sport_slug,
          league_slug,
          model_version AS model_name,
          market_type,
          line,
          COUNT(*)::int AS total,
          0::int AS open,
          0::int AS pending_closing,
          COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_results,
          COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED'))::int AS closed,
          COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
          COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
          ROUND(COALESCE(SUM(net_profit), 0)::numeric, 4) AS profit_units,
          NULL::numeric AS avg_clv,
          ROUND(AVG(expected_value)::numeric, 6) AS avg_expected_value,
          MAX(COALESCE(settled_at, placed_at)) AS latest_activity
        FROM paper_trades
        GROUP BY sport_slug, league_slug, model_version, market_type, line
      `
    );

    const rows = [...realPaperResult.rows, ...shadowPaperResult.rows];
    const totals = rows.reduce(
      (acc, row) => {
        acc.total += Number(row.total ?? 0);
        acc.open += Number(row.open ?? 0);
        acc.pending_closing += Number(row.pending_closing ?? 0);
        acc.pending_results += Number(row.pending_results ?? 0);
        acc.closed += Number(row.closed ?? 0);
        acc.wins += Number(row.wins ?? 0);
        acc.losses += Number(row.losses ?? 0);
        acc.profit_units += Number(row.profit_units ?? 0);
        return acc;
      },
      {
        total: 0,
        open: 0,
        pending_closing: 0,
        pending_results: 0,
        closed: 0,
        wins: 0,
        losses: 0,
        profit_units: 0
      }
    );

    const calibration = rows.map((row) => {
      const closed = Number(row.closed ?? 0);
      return {
        flow: row.flow,
        sport_slug: row.sport_slug,
        league_slug: row.league_slug,
        market_type: row.market_type,
        line: row.line,
        closed,
        target_closed: 50,
        remaining_to_50: Math.max(0, 50 - closed),
        ready_for_review: closed >= 50
      };
    });

    return {
      totals: {
        ...totals,
        win_rate: totals.wins + totals.losses > 0 ? totals.wins / (totals.wins + totals.losses) : null,
        profit_units: Number(totals.profit_units.toFixed(4))
      },
      count: rows.length,
      rows,
      calibration,
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        note: "Portfolio combina operacion MLB + Mundial, pero la calibracion y Kelly siguen separados por deporte/mercado."
      }
    };
  });

  app.get("/api/v1/internal/model-quotes/mlb-real-paper-audit", async (request) => {
    const query = clvLabQuerySchema.parse(request.query);
    const result = await db.query(
      `
        WITH base AS (
          SELECT
            *,
            status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED') AS is_closed,
            CASE
              WHEN entry_odds IS NULL THEN 'unknown'
              WHEN entry_odds < 1.30 THEN '<1.30'
              WHEN entry_odds < 1.61 THEN '1.30-1.60'
              WHEN entry_odds < 2.01 THEN '1.61-2.00'
              ELSE '2.01+'
            END AS odds_band,
            CASE
              WHEN pick IN ('home', 'away') THEN pick
              ELSE COALESCE(pick, 'unknown')
            END AS pick_group,
            CASE
              WHEN entry_odds IS NULL THEN 'unknown'
              WHEN entry_odds < 1.95 THEN 'favorite'
              WHEN entry_odds <= 2.05 THEN 'pickem'
              ELSE 'underdog'
            END AS price_role,
            CASE
              WHEN model_probability IS NULL THEN 'unknown'
              WHEN model_probability < 0.55 THEN '52-55%'
              WHEN model_probability < 0.60 THEN '55-60%'
              ELSE '60%+'
            END AS model_prob_band
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
        ),
        metrics AS (
          SELECT 'overall' AS group_type, 'all' AS group_value, * FROM (
            SELECT
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_closed)::int AS closed,
              COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
              COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
              COUNT(*) FILTER (WHERE status = 'PUSH')::int AS pushes,
              ROUND(AVG(entry_odds) FILTER (WHERE is_closed)::numeric, 4) AS avg_entry_odds,
              ROUND(AVG(closing_odds) FILTER (WHERE is_closed AND closing_odds IS NOT NULL)::numeric, 4) AS avg_closing_odds,
              ROUND(AVG(expected_value) FILTER (WHERE is_closed)::numeric, 6) AS avg_expected_value,
              ROUND(AVG(clv) FILTER (WHERE is_closed AND clv IS NOT NULL)::numeric, 6) AS avg_clv,
              COUNT(*) FILTER (WHERE is_closed AND clv > 0)::int AS positive_clv,
              ROUND(COALESCE(SUM(profit_loss) FILTER (WHERE is_closed), 0)::numeric, 4) AS profit_units
            FROM base
          ) s
          UNION ALL
          SELECT 'odds_band', odds_band, total, closed, wins, losses, pushes, avg_entry_odds, avg_closing_odds,
            avg_expected_value, avg_clv, positive_clv, profit_units FROM (
            SELECT
              odds_band,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_closed)::int AS closed,
              COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
              COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
              COUNT(*) FILTER (WHERE status = 'PUSH')::int AS pushes,
              ROUND(AVG(entry_odds) FILTER (WHERE is_closed)::numeric, 4) AS avg_entry_odds,
              ROUND(AVG(closing_odds) FILTER (WHERE is_closed AND closing_odds IS NOT NULL)::numeric, 4) AS avg_closing_odds,
              ROUND(AVG(expected_value) FILTER (WHERE is_closed)::numeric, 6) AS avg_expected_value,
              ROUND(AVG(clv) FILTER (WHERE is_closed AND clv IS NOT NULL)::numeric, 6) AS avg_clv,
              COUNT(*) FILTER (WHERE is_closed AND clv > 0)::int AS positive_clv,
              ROUND(COALESCE(SUM(profit_loss) FILTER (WHERE is_closed), 0)::numeric, 4) AS profit_units
            FROM base
            GROUP BY odds_band
          ) s
          UNION ALL
          SELECT 'pick', pick_group, total, closed, wins, losses, pushes, avg_entry_odds, avg_closing_odds,
            avg_expected_value, avg_clv, positive_clv, profit_units FROM (
            SELECT
              pick_group,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_closed)::int AS closed,
              COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
              COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
              COUNT(*) FILTER (WHERE status = 'PUSH')::int AS pushes,
              ROUND(AVG(entry_odds) FILTER (WHERE is_closed)::numeric, 4) AS avg_entry_odds,
              ROUND(AVG(closing_odds) FILTER (WHERE is_closed AND closing_odds IS NOT NULL)::numeric, 4) AS avg_closing_odds,
              ROUND(AVG(expected_value) FILTER (WHERE is_closed)::numeric, 6) AS avg_expected_value,
              ROUND(AVG(clv) FILTER (WHERE is_closed AND clv IS NOT NULL)::numeric, 6) AS avg_clv,
              COUNT(*) FILTER (WHERE is_closed AND clv > 0)::int AS positive_clv,
              ROUND(COALESCE(SUM(profit_loss) FILTER (WHERE is_closed), 0)::numeric, 4) AS profit_units
            FROM base
            GROUP BY pick_group
          ) s
          UNION ALL
          SELECT 'price_role', price_role, total, closed, wins, losses, pushes, avg_entry_odds, avg_closing_odds,
            avg_expected_value, avg_clv, positive_clv, profit_units FROM (
            SELECT
              price_role,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_closed)::int AS closed,
              COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
              COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
              COUNT(*) FILTER (WHERE status = 'PUSH')::int AS pushes,
              ROUND(AVG(entry_odds) FILTER (WHERE is_closed)::numeric, 4) AS avg_entry_odds,
              ROUND(AVG(closing_odds) FILTER (WHERE is_closed AND closing_odds IS NOT NULL)::numeric, 4) AS avg_closing_odds,
              ROUND(AVG(expected_value) FILTER (WHERE is_closed)::numeric, 6) AS avg_expected_value,
              ROUND(AVG(clv) FILTER (WHERE is_closed AND clv IS NOT NULL)::numeric, 6) AS avg_clv,
              COUNT(*) FILTER (WHERE is_closed AND clv > 0)::int AS positive_clv,
              ROUND(COALESCE(SUM(profit_loss) FILTER (WHERE is_closed), 0)::numeric, 4) AS profit_units
            FROM base
            GROUP BY price_role
          ) s
          UNION ALL
          SELECT 'model_prob', model_prob_band, total, closed, wins, losses, pushes, avg_entry_odds, avg_closing_odds,
            avg_expected_value, avg_clv, positive_clv, profit_units FROM (
            SELECT
              model_prob_band,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_closed)::int AS closed,
              COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
              COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
              COUNT(*) FILTER (WHERE status = 'PUSH')::int AS pushes,
              ROUND(AVG(entry_odds) FILTER (WHERE is_closed)::numeric, 4) AS avg_entry_odds,
              ROUND(AVG(closing_odds) FILTER (WHERE is_closed AND closing_odds IS NOT NULL)::numeric, 4) AS avg_closing_odds,
              ROUND(AVG(expected_value) FILTER (WHERE is_closed)::numeric, 6) AS avg_expected_value,
              ROUND(AVG(clv) FILTER (WHERE is_closed AND clv IS NOT NULL)::numeric, 6) AS avg_clv,
              COUNT(*) FILTER (WHERE is_closed AND clv > 0)::int AS positive_clv,
              ROUND(COALESCE(SUM(profit_loss) FILTER (WHERE is_closed), 0)::numeric, 4) AS profit_units
            FROM base
            GROUP BY model_prob_band
          ) s
        )
        SELECT
          *,
          CASE WHEN wins + losses > 0 THEN ROUND((wins::numeric / (wins + losses)), 6) ELSE NULL END AS win_rate,
          CASE WHEN closed > 0 THEN ROUND((positive_clv::numeric / closed), 6) ELSE NULL END AS positive_clv_rate,
          CASE
            WHEN closed < $1 THEN 'ACCUMULATE'
            WHEN COALESCE(avg_clv, 0) > 0 AND profit_units > 0 THEN 'READY_FOR_REVIEW'
            WHEN COALESCE(avg_clv, 0) <= 0 THEN 'CLV_REVIEW'
            ELSE 'PROFIT_REVIEW'
          END AS decision
        FROM metrics
        ORDER BY
          CASE group_type
            WHEN 'overall' THEN 0
            WHEN 'odds_band' THEN 1
            WHEN 'price_role' THEN 2
            WHEN 'pick' THEN 3
            WHEN 'model_prob' THEN 4
            ELSE 9
          END,
          group_value
        LIMIT $2
      `,
      [query.min_closed, query.limit]
    );

    const overall = result.rows.find((row) => row.group_type === "overall");
    return {
      target: {
        sport_slug: "baseball",
        league_slug: "mlb",
        market_type: "moneyline_2way",
        min_closed: query.min_closed
      },
      overall,
      rows: result.rows,
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        note: "Auditoria formal MLB Real Paper. Sirve para decidir revision manual, no para activar dinero real."
      }
    };
  });

  app.get("/api/v1/internal/model-quotes/clv-lab", async (request) => {
    const query = clvLabQuerySchema.parse(request.query);
    const values: Array<string | number> = [query.min_closed, query.limit];
    const filters: string[] = [];
    if (query.sport) {
      filters.push(`sport_slug = $${values.push(query.sport)}`);
    }
    if (query.league_slug) {
      filters.push(`league_slug = $${values.push(query.league_slug)}`);
    }
    if (query.market_type) {
      filters.push(`market_type = $${values.push(query.market_type)}`);
    }
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await db.query(
      `
        WITH base AS (
          SELECT
            *,
            status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED') AS is_closed,
            CASE
              WHEN entry_odds IS NULL THEN 'unknown'
              WHEN entry_odds < 1.30 THEN '<1.30'
              WHEN entry_odds < 1.61 THEN '1.30-1.60'
              WHEN entry_odds < 2.01 THEN '1.61-2.00'
              ELSE '2.01+'
            END AS odds_band
          FROM real_paper_snapshots
          ${whereClause}
        ),
        metrics AS (
          SELECT 'overall' AS group_type, 'all' AS group_value, COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_closed)::int AS closed,
            COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
            COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
            COUNT(*) FILTER (WHERE status = 'PUSH')::int AS pushes,
            ROUND(AVG(entry_odds) FILTER (WHERE is_closed)::numeric, 4) AS avg_entry_odds,
            ROUND(AVG(closing_odds) FILTER (WHERE is_closed AND closing_odds IS NOT NULL)::numeric, 4) AS avg_closing_odds,
            ROUND(AVG(expected_value) FILTER (WHERE is_closed)::numeric, 6) AS avg_expected_value,
            ROUND(AVG(clv) FILTER (WHERE is_closed AND clv IS NOT NULL)::numeric, 6) AS avg_clv,
            COUNT(*) FILTER (WHERE is_closed AND clv > 0)::int AS positive_clv,
            ROUND(COALESCE(SUM(profit_loss) FILTER (WHERE is_closed), 0)::numeric, 4) AS profit_units
          FROM base
          UNION ALL
          SELECT 'market', market_type, COUNT(*)::int, COUNT(*) FILTER (WHERE is_closed)::int,
            COUNT(*) FILTER (WHERE status = 'WIN')::int, COUNT(*) FILTER (WHERE status = 'LOSS')::int,
            COUNT(*) FILTER (WHERE status = 'PUSH')::int,
            ROUND(AVG(entry_odds) FILTER (WHERE is_closed)::numeric, 4),
            ROUND(AVG(closing_odds) FILTER (WHERE is_closed AND closing_odds IS NOT NULL)::numeric, 4),
            ROUND(AVG(expected_value) FILTER (WHERE is_closed)::numeric, 6),
            ROUND(AVG(clv) FILTER (WHERE is_closed AND clv IS NOT NULL)::numeric, 6),
            COUNT(*) FILTER (WHERE is_closed AND clv > 0)::int,
            ROUND(COALESCE(SUM(profit_loss) FILTER (WHERE is_closed), 0)::numeric, 4)
          FROM base
          GROUP BY market_type
          UNION ALL
          SELECT 'bookmaker', COALESCE(bookmaker, 'unknown'), COUNT(*)::int, COUNT(*) FILTER (WHERE is_closed)::int,
            COUNT(*) FILTER (WHERE status = 'WIN')::int, COUNT(*) FILTER (WHERE status = 'LOSS')::int,
            COUNT(*) FILTER (WHERE status = 'PUSH')::int,
            ROUND(AVG(entry_odds) FILTER (WHERE is_closed)::numeric, 4),
            ROUND(AVG(closing_odds) FILTER (WHERE is_closed AND closing_odds IS NOT NULL)::numeric, 4),
            ROUND(AVG(expected_value) FILTER (WHERE is_closed)::numeric, 6),
            ROUND(AVG(clv) FILTER (WHERE is_closed AND clv IS NOT NULL)::numeric, 6),
            COUNT(*) FILTER (WHERE is_closed AND clv > 0)::int,
            ROUND(COALESCE(SUM(profit_loss) FILTER (WHERE is_closed), 0)::numeric, 4)
          FROM base
          GROUP BY bookmaker
          UNION ALL
          SELECT 'odds_band', odds_band, COUNT(*)::int, COUNT(*) FILTER (WHERE is_closed)::int,
            COUNT(*) FILTER (WHERE status = 'WIN')::int, COUNT(*) FILTER (WHERE status = 'LOSS')::int,
            COUNT(*) FILTER (WHERE status = 'PUSH')::int,
            ROUND(AVG(entry_odds) FILTER (WHERE is_closed)::numeric, 4),
            ROUND(AVG(closing_odds) FILTER (WHERE is_closed AND closing_odds IS NOT NULL)::numeric, 4),
            ROUND(AVG(expected_value) FILTER (WHERE is_closed)::numeric, 6),
            ROUND(AVG(clv) FILTER (WHERE is_closed AND clv IS NOT NULL)::numeric, 6),
            COUNT(*) FILTER (WHERE is_closed AND clv > 0)::int,
            ROUND(COALESCE(SUM(profit_loss) FILTER (WHERE is_closed), 0)::numeric, 4)
          FROM base
          GROUP BY odds_band
          UNION ALL
          SELECT 'pick', COALESCE(pick, 'unknown'), COUNT(*)::int, COUNT(*) FILTER (WHERE is_closed)::int,
            COUNT(*) FILTER (WHERE status = 'WIN')::int, COUNT(*) FILTER (WHERE status = 'LOSS')::int,
            COUNT(*) FILTER (WHERE status = 'PUSH')::int,
            ROUND(AVG(entry_odds) FILTER (WHERE is_closed)::numeric, 4),
            ROUND(AVG(closing_odds) FILTER (WHERE is_closed AND closing_odds IS NOT NULL)::numeric, 4),
            ROUND(AVG(expected_value) FILTER (WHERE is_closed)::numeric, 6),
            ROUND(AVG(clv) FILTER (WHERE is_closed AND clv IS NOT NULL)::numeric, 6),
            COUNT(*) FILTER (WHERE is_closed AND clv > 0)::int,
            ROUND(COALESCE(SUM(profit_loss) FILTER (WHERE is_closed), 0)::numeric, 4)
          FROM base
          GROUP BY pick
        )
        SELECT
          *,
          CASE WHEN wins + losses > 0 THEN ROUND((wins::numeric / (wins + losses)), 6) ELSE NULL END AS win_rate,
          CASE WHEN closed > 0 THEN ROUND((positive_clv::numeric / closed), 6) ELSE NULL END AS positive_clv_rate,
          CASE
            WHEN closed < $1 THEN 'ACCUMULATE'
            WHEN COALESCE(avg_clv, 0) > 0 AND profit_units > 0 THEN 'READY_FOR_REVIEW'
            WHEN COALESCE(avg_clv, 0) <= 0 THEN 'CLV_REVIEW'
            ELSE 'PROFIT_REVIEW'
          END AS decision
        FROM metrics
        ORDER BY
          CASE group_type
            WHEN 'overall' THEN 0
            WHEN 'market' THEN 1
            WHEN 'bookmaker' THEN 2
            WHEN 'odds_band' THEN 3
            WHEN 'pick' THEN 4
            ELSE 9
          END,
          group_value
        LIMIT $2
      `,
      values
    );

    return {
      filters: query,
      rows: result.rows,
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false
      }
    };
  });

  app.get("/api/v1/internal/model-quotes/smart-selection", async (request) => {
    const query = smartSelectionQuerySchema.parse(request.query);
    const values: Array<string | number> = [
      query.max_model_age_minutes,
      query.max_market_age_minutes,
      query.min_confidence,
      query.min_ev,
      query.limit
    ];
    const modelFilter = query.model_name
      ? `AND mq.model_name = $${values.push(query.model_name)}`
      : "";
    const sportFilter = query.sport
      ? `AND s.slug = $${values.push(query.sport)}`
      : "";

    const result = await db.query(
      `
        WITH latest_model_quotes AS (
          SELECT DISTINCT ON (mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999))
            mq.*
          FROM model_quotes mq
          JOIN v_valid_matches m ON m.id = mq.match_id
          JOIN leagues l ON l.id = m.league_id
          JOIN sports s ON s.id = l.sport_id
          WHERE m.status::text IN ('scheduled', 'live')
            AND mq.generated_at >= NOW() - ($1::int * INTERVAL '1 minute')
            AND mq.confidence >= $3
            ${modelFilter}
            ${sportFilter}
          ORDER BY mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999), mq.generated_at DESC
        ),
        latest_market_quotes AS (
          SELECT DISTINCT ON (mk.match_id, mk.market_type, COALESCE(mk.line, -9999))
            mk.*
          FROM market_quotes mk
          WHERE mk.captured_at >= NOW() - ($2::int * INTERVAL '1 minute')
          ORDER BY mk.match_id, mk.market_type, COALESCE(mk.line, -9999), mk.captured_at DESC
        ),
        selections AS (
          SELECT
            mq.id AS model_quote_id,
            mk.id AS market_quote_id,
            mq.match_id,
            s.slug AS sport_slug,
            l.slug AS league_slug,
            mq.model_name,
            mk.provider_name,
            COALESCE((mk.raw_data->>'processed')::boolean, false) AS quote_processed,
            mq.market_type,
            mq.line,
            m.status,
            m.match_date,
            COALESCE(pem.home_team_name, home_comp.team_name) AS home_team_name,
            COALESCE(pem.away_team_name, away_comp.team_name) AS away_team_name,
            mq.confidence,
            mq.generated_at,
            mk.captured_at,
            COALESCE(mq.raw_data #>> ARRAY['selection_map', selection.market_selection], selection.market_selection) AS market_selection,
            selection.model_probability,
            selection.model_fair_odds,
            selection.market_odds,
            (selection.model_probability * selection.market_odds) - 1 AS expected_value
          FROM latest_model_quotes mq
          JOIN latest_market_quotes mk
            ON mk.match_id = mq.match_id
           AND mk.market_type = mq.market_type
           AND COALESCE(mk.line, -9999) = COALESCE(mq.line, -9999)
          JOIN v_valid_matches m ON m.id = mq.match_id
          JOIN leagues l ON l.id = m.league_id
          JOIN sports s ON s.id = l.sport_id
          LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = mq.match_id AND pem.is_active = TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = mq.match_id AND mc.home_away = 'home'
            LIMIT 1
          ) home_comp ON TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = mq.match_id AND mc.home_away = 'away'
            LIMIT 1
          ) away_comp ON TRUE
          CROSS JOIN LATERAL (
            VALUES
              (COALESCE(mq.raw_data #>> ARRAY['selection_map', 'home'], 'home'), mq.home_probability, mq.home_fair_odds, mk.home_odds),
              (COALESCE(mq.raw_data #>> ARRAY['selection_map', 'away'], 'away'), mq.away_probability, mq.away_fair_odds, mk.away_odds),
              ('draw', mq.draw_probability, mq.draw_fair_odds, mk.draw_odds)
          ) AS selection(market_selection, model_probability, model_fair_odds, market_odds)
          WHERE selection.model_probability IS NOT NULL
            AND selection.model_fair_odds IS NOT NULL
            AND selection.market_odds IS NOT NULL
            AND NOT (COALESCE(mq.raw_data->'disabled_selections', '[]'::jsonb) ? selection.market_selection)
        ),
        ranked AS (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY
                league_slug,
                LEAST(
                  regexp_replace(lower(COALESCE(home_team_name, match_id::text)), '[^a-z0-9]+', '', 'g'),
                  regexp_replace(lower(COALESCE(away_team_name, match_id::text)), '[^a-z0-9]+', '', 'g')
                ),
                GREATEST(
                  regexp_replace(lower(COALESCE(home_team_name, match_id::text)), '[^a-z0-9]+', '', 'g'),
                  regexp_replace(lower(COALESCE(away_team_name, match_id::text)), '[^a-z0-9]+', '', 'g')
                ),
                model_name,
                provider_name,
                market_type,
                COALESCE(line, -9999),
                market_selection
              ORDER BY expected_value DESC, confidence DESC, captured_at DESC
            ) AS event_rank
          FROM selections
          WHERE expected_value >= $4
        )
        SELECT
          model_quote_id,
          market_quote_id,
          match_id,
          sport_slug,
          league_slug,
          model_name,
          provider_name,
          quote_processed,
          market_type,
          line,
          market_selection,
          home_team_name,
          away_team_name,
          confidence,
          model_probability,
          model_fair_odds,
          market_odds,
          ROUND(expected_value::numeric, 6) AS expected_value,
          status,
          match_date,
          generated_at,
          captured_at,
          EXTRACT(EPOCH FROM (NOW() - captured_at))::int AS market_age_seconds
        FROM ranked
        WHERE event_rank = 1
        ORDER BY expected_value DESC, confidence DESC, captured_at DESC
        LIMIT $5;
      `,
      values
    );

    const selections = result.rows.map((row) => ({
      ...row,
      ...auditSelection({
        provider_name: row.provider_name,
        processed: isManualProvider(row.provider_name) ? false : row.quote_processed,
        sport_slug: row.sport_slug,
        league_slug: row.league_slug,
        market_type: row.market_type,
        market_selection: row.market_selection,
        line: row.line,
        market_odds: row.market_odds,
        model_fair_odds: row.model_fair_odds,
        model_probability: row.model_probability,
        expected_value: row.expected_value
      })
    }));

    return {
      count: selections.length,
      selections
    };
  });

  app.get("/api/v1/internal/model-quotes/parlay-suggestions", async (request) => {
    const query = parlayQuerySchema.parse(request.query);
    const values: Array<string | number | boolean> = [query.min_ev, query.processed, query.max_age_minutes, query.limit];
    const modelFilter = query.model_name
      ? `AND ao.model_name = $${values.push(query.model_name)}`
      : "";
    const sportFilter = query.sport
      ? `AND ao.sport_slug = $${values.push(query.sport)}`
      : "";

    const result = await db.query<ParlayLeg>(
      `
        WITH enriched AS (
          SELECT
            ao.id,
            ao.match_id,
            ao.sport_slug,
            ao.league_slug,
            ao.model_name,
            ao.provider_name,
            ao.market_type,
            ao.line,
            ao.market_selection,
            COALESCE(pem.home_team_name, home_comp.team_name) AS home_team_name,
            COALESCE(pem.away_team_name, away_comp.team_name) AS away_team_name,
            ao.model_probability,
            ao.market_odds,
            ao.expected_value,
            ao.processed,
            mq.confidence,
            EXTRACT(EPOCH FROM (NOW() - ao.detected_at))::int AS age_seconds,
            ao.detected_at
          FROM alpha_opportunities ao
          JOIN v_valid_matches m ON m.id = ao.match_id
          JOIN model_quotes mq ON mq.id = ao.model_quote_id
          LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = ao.match_id AND pem.is_active = TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = ao.match_id AND mc.home_away = 'home'
            LIMIT 1
          ) home_comp ON TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = ao.match_id AND mc.home_away = 'away'
            LIMIT 1
          ) away_comp ON TRUE
          WHERE m.status::text IN ('scheduled', 'live')
            AND ao.expected_value >= $1
            AND ao.processed = $2
            AND ao.detected_at >= NOW() - ($3::int * INTERVAL '1 minute')
            ${modelFilter}
            ${sportFilter}
        ),
        ranked AS (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY
                league_slug,
                LEAST(
                  regexp_replace(lower(COALESCE(home_team_name, match_id::text)), '[^a-z0-9]+', '', 'g'),
                  regexp_replace(lower(COALESCE(away_team_name, match_id::text)), '[^a-z0-9]+', '', 'g')
                ),
                GREATEST(
                  regexp_replace(lower(COALESCE(home_team_name, match_id::text)), '[^a-z0-9]+', '', 'g'),
                  regexp_replace(lower(COALESCE(away_team_name, match_id::text)), '[^a-z0-9]+', '', 'g')
                )
              ORDER BY detected_at DESC, expected_value DESC, confidence DESC
            ) AS row_rank
          FROM enriched
        )
        SELECT *
        FROM ranked
        WHERE row_rank = 1
        ORDER BY expected_value DESC, confidence DESC, detected_at DESC
        LIMIT $4;
      `,
      values
    );

    const legs = result.rows
      .filter((leg) => !isRunLineDiagnosticProvider(leg.provider_name))
      .map((leg) => ({
        ...leg,
        ...auditSelection({
          provider_name: leg.provider_name,
          processed: leg.processed,
          sport_slug: leg.sport_slug,
          league_slug: leg.league_slug,
          market_type: leg.market_type,
          market_selection: leg.market_selection,
          line: leg.line,
          market_odds: leg.market_odds,
          model_probability: leg.model_probability,
          expected_value: leg.expected_value,
          age_seconds: leg.age_seconds
        })
      }));
    const steadyLegs = legs
      .filter((leg) => asNumber(leg.confidence) >= 0.5 && asNumber(leg.expected_value) >= 0.05 && asNumber(leg.expected_value) <= 0.07)
      .sort((a, b) => asNumber(b.confidence) - asNumber(a.confidence) || asNumber(b.expected_value) - asNumber(a.expected_value));
    const dreamerLegs = legs
      .filter((leg) => asNumber(leg.expected_value) >= 0.05)
      .sort((a, b) => asNumber(b.expected_value) - asNumber(a.expected_value) || asNumber(b.confidence) - asNumber(a.confidence));
    const blackSwanLegs = legs
      .filter((leg) => asNumber(leg.expected_value) >= 0.05 && asNumber(leg.market_odds) >= 2.5)
      .sort((a, b) => {
        const crossSport = Number(a.sport_slug !== b.sport_slug);
        if (crossSport) {
          return a.sport_slug.localeCompare(b.sport_slug);
        }
        return asNumber(b.market_odds) - asNumber(a.market_odds);
      });

    return {
      count: legs.length,
      source: {
        min_ev: query.min_ev,
        processed: query.processed,
        max_age_minutes: query.max_age_minutes
      },
      parlays: [
        buildParlay("steady", "Parlay Seguro", 2, 0.015, steadyLegs),
        buildParlay("value_hunter", "Parlay Soñador", 3, 0.005, dreamerLegs),
        buildParlay("black_swan", "Parlay Jubilador", 6, 0.001, blackSwanLegs)
      ]
    };
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/internal/model-quotes/alpha-opportunities/:id/process",
    async (request) => {
      const params = alphaProcessParamsSchema.parse(request.params);
      const body = alphaProcessBodySchema.parse(request.body ?? {});

      const result = await db.query(
        `
          WITH updated AS (
            UPDATE alpha_opportunities
            SET
              processed = $2::boolean,
              raw_data = raw_data || jsonb_build_object(
                'processed_via', 'internal_api',
                'processed_note', $3::text,
                'processed_flag', $2::boolean,
                'processed_at', NOW()
              )
            WHERE id = $1
            RETURNING *
          )
          SELECT
            updated.id,
            updated.match_id,
            updated.sport_slug,
            updated.league_slug,
            updated.model_name,
            updated.provider_name,
            updated.market_type,
            updated.line,
            updated.market_selection,
            COALESCE(pem.home_team_name, home_comp.team_name) AS home_team_name,
            COALESCE(pem.away_team_name, away_comp.team_name) AS away_team_name,
            updated.expected_value,
            updated.processed,
            updated.detected_at
          FROM updated
          JOIN v_valid_matches m ON m.id = updated.match_id
          LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = updated.match_id AND pem.is_active = TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = updated.match_id AND mc.home_away = 'home'
            LIMIT 1
          ) home_comp ON TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = updated.match_id AND mc.home_away = 'away'
            LIMIT 1
          ) away_comp ON TRUE;
        `,
        [params.id, body.processed, body.note ?? null]
      );

      if (!result.rows[0]) {
        throw new AppError(404, "Alpha opportunity no encontrada");
      }

      return {
        status: "success",
        opportunity: result.rows[0]
      };
    }
  );
}
