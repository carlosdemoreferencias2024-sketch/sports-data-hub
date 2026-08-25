import { z } from "zod";
import { db } from "../db/index.js";
import { registerForecastModelVersion } from "./forecast-chain.js";
import {
  computeNflFairOdds,
  NFL_FAIR_ODDS_CONFIG,
  nflFairOddsArtifactSha256,
  nflFairOddsConfigSha256,
  type NflResultObservation
} from "./nfl-fair-odds-model.js";
import { tradingLocalDateWindow } from "./timezone.js";

const booleanValue = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return value;
}, z.boolean()).default(false);

const inputSchema = z.object({
  date: z.string().optional(),
  match_id: z.string().uuid().optional(),
  decision_as_of: z.string().datetime({ offset: true }).optional(),
  apply: booleanValue,
  include_post_kickoff: booleanValue,
  limit: z.coerce.number().int().min(1).max(32).default(1)
});

const MODEL_NAME = "sports_data_hub_nfl_fair_odds_v1";

function normalizeTeamName(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function numericOrNull(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

async function verifiedHistoryFor(teamName: string, asOf: string): Promise<NflResultObservation[]> {
  const result = await db.query(
    `
      SELECT
        tms.match_id,
        mh.match_date,
        tms.points_for,
        tms.points_against,
        tms.is_home,
        mh.is_preseason,
        tms.source,
        tms.source_confidence_score,
        COALESCE(
          NULLIF(tms.raw_data->>'captured_at', '')::timestamptz,
          mh.source_observed_at,
          tms.created_at
        ) AS captured_at,
        COALESCE(
          tms.raw_data->>'provider_raw_sha256',
          mh.raw_data->>'provider_raw_sha256'
        ) AS evidence_sha256,
        CASE WHEN COALESCE(tms.raw_data->>'team_elo_before', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (tms.raw_data->>'team_elo_before')::numeric END AS team_elo_before,
        CASE WHEN COALESCE(tms.raw_data->>'team_elo_after', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (tms.raw_data->>'team_elo_after')::numeric END AS team_elo_after,
        CASE WHEN COALESCE(tms.raw_data->>'opponent_elo_before', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (tms.raw_data->>'opponent_elo_before')::numeric END AS opponent_elo_before
      FROM sports_team_match_stats tms
      JOIN sports_match_history mh ON mh.match_id = tms.match_id
      WHERE tms.sport = 'american_football'
        AND tms.league_id = 'nfl'
        AND tms.normalized_team_name = $1
        AND mh.match_date < $2::timestamptz
        AND COALESCE(mh.source_observed_at, tms.created_at) <= $2::timestamptz
        AND UPPER(mh.status) IN ('FINAL', 'FINISHED', 'FT')
        AND tms.points_for IS NOT NULL
        AND tms.points_against IS NOT NULL
        AND tms.source_confidence_score >= $3
        AND COALESCE(tms.raw_data->>'provider_raw_sha256', mh.raw_data->>'provider_raw_sha256', '') ~ '^[a-fA-F0-9]{64}$'
      ORDER BY mh.match_date DESC
      LIMIT $4
    `,
    [normalizeTeamName(teamName), asOf, NFL_FAIR_ODDS_CONFIG.min_source_confidence, NFL_FAIR_ODDS_CONFIG.max_form_matches]
  );
  return result.rows.map((row: Record<string, unknown>) => ({
    matchId: String(row.match_id),
    playedAt: new Date(String(row.match_date)).toISOString(),
    pointsFor: Number(row.points_for),
    pointsAgainst: Number(row.points_against),
    isHome: Boolean(row.is_home),
    isPreseason: Boolean(row.is_preseason),
    source: String(row.source),
    sourceConfidenceScore: Number(row.source_confidence_score),
    evidenceSha256: String(row.evidence_sha256),
    capturedAt: new Date(String(row.captured_at)).toISOString(),
    featureAsOf: new Date(String(row.match_date)).toISOString(),
    teamEloBefore: numericOrNull(row.team_elo_before),
    teamEloAfter: numericOrNull(row.team_elo_after),
    opponentEloBefore: numericOrNull(row.opponent_elo_before)
  }));
}

export async function runNflOwnedFairOdds(rawQuery: unknown = {}, rawBody: unknown = {}) {
  const input = inputSchema.parse({
    ...(rawQuery && typeof rawQuery === "object" ? rawQuery as Record<string, unknown> : {}),
    ...(rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {})
  });
  const generatedAt = input.decision_as_of ? new Date(input.decision_as_of) : new Date();
  const generatedAtIso = generatedAt.toISOString();
  const window = tradingLocalDateWindow(input.date);
  const values: unknown[] = [window.start, window.end, generatedAtIso, input.limit];
  const matchFilter = input.match_id ? `AND match.id = $${values.push(input.match_id)}::uuid` : "";
  const kickoffFilter = input.include_post_kickoff ? "" : "AND match.match_date > $3::timestamptz";
  const matches = await db.query(
    `
      SELECT
        match.id AS match_id,
        match.match_date AS kickoff,
        match.status AS match_status,
        match.raw_data,
        home.name AS home_team,
        away.name AS away_team,
        league.slug AS league_slug,
        CASE
          WHEN COALESCE(match.raw_data->'season'->>'slug', '') = 'preseason'
            OR COALESCE(match.raw_data->'season'->>'type', '') = '1'
            THEN 'preseason'
          WHEN COALESCE(match.raw_data->'season'->>'slug', '') = 'post-season'
            OR COALESCE(match.raw_data->'season'->>'type', '') = '3'
            THEN 'postseason'
          ELSE 'regular'
        END AS competition_type
      FROM v_valid_matches match
      JOIN match_competitors home_competitor
        ON home_competitor.match_id = match.id AND home_competitor.home_away = 'home'
      JOIN match_competitors away_competitor
        ON away_competitor.match_id = match.id AND away_competitor.home_away = 'away'
      JOIN teams home ON home.id = home_competitor.team_id
      JOIN teams away ON away.id = away_competitor.team_id
      JOIN leagues league ON league.id = match.league_id
      JOIN sports sport ON sport.id = league.sport_id
      WHERE league.slug = 'nfl'
        AND sport.slug = 'american-football'
        AND match.match_date >= $1::timestamptz
        AND match.match_date < $2::timestamptz
        ${kickoffFilter}
        ${matchFilter}
      ORDER BY match.match_date, match.id
      LIMIT $4
    `,
    values
  );

  const artifactSha256 = nflFairOddsArtifactSha256();
  const configSha256 = nflFairOddsConfigSha256();
  const rows: Array<Record<string, unknown>> = [];
  let inserted = 0;
  let reused = 0;
  let blocked = 0;

  for (const match of matches.rows as Array<Record<string, unknown>>) {
    const matchId = String(match.match_id);
    const kickoff = new Date(String(match.kickoff)).toISOString();
    const homeTeam = String(match.home_team);
    const awayTeam = String(match.away_team);
    const targetCompetitionType = String(match.competition_type) as "preseason" | "regular" | "postseason";
    const [homeForm, awayForm] = await Promise.all([
      verifiedHistoryFor(homeTeam, generatedAtIso),
      verifiedHistoryFor(awayTeam, generatedAtIso)
    ]);
    try {
      const model = computeNflFairOdds({
        homeTeam,
        awayTeam,
        asOf: generatedAtIso,
        targetCompetitionType,
        homeForm,
        awayForm
      });
      const modelVersionLabel = `${NFL_FAIR_ODDS_CONFIG.model_family}-${artifactSha256.slice(0, 12)}-cutoff-${model.training_cutoff_date}`;
      const modelVersion = input.apply
        ? await registerForecastModelVersion({
            versionLabel: modelVersionLabel,
            sportSlug: "american_football",
            modelName: MODEL_NAME,
            trainingCutoffDate: model.training_cutoff_date,
            trainedAt: generatedAtIso,
            artifactSha256,
            configSha256,
            featureSchemaVersion: NFL_FAIR_ODDS_CONFIG.feature_schema_version,
            notes: "NFL Elo and recency-weighted score-margin model. Market odds are excluded. Historical inputs require formal SHA-256 evidence."
          })
        : null;
      const rawData = {
        owned_fair_odds: true,
        fair_odds_only: true,
        not_market_odds: true,
        source: "sports_data_hub_owned_api",
        sport: "american_football",
        league_slug: "nfl",
        model_name: MODEL_NAME,
        model_family: NFL_FAIR_ODDS_CONFIG.model_family,
        model_version_label: modelVersionLabel,
        model_version_id: modelVersion?.id ?? null,
        training_cutoff_date: model.training_cutoff_date,
        trained_at: generatedAtIso,
        artifact_sha256: artifactSha256,
        config_sha256: configSha256,
        feature_schema_version: NFL_FAIR_ODDS_CONFIG.feature_schema_version,
        fair_odds_method_version: NFL_FAIR_ODDS_CONFIG.fair_odds_method_version,
        market_inputs_used: false,
        independence_attestation: "No bookmaker line, moneyline, spread, total or consensus price entered the model.",
        immutable_candidate_input: true,
        input_snapshot_sha256: model.input_snapshot_sha256,
        output_sha256: model.output_sha256,
        generated_at: generatedAtIso,
        kickoff,
        target_competition_type: targetCompetitionType,
        calibration_state: "UNCALIBRATED_PROSPECTIVE_SHADOW",
        calibration_required_before_real_money: true,
        promotion_allowed: false,
        shadow_only: true,
        real_candidate: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        autopost_enabled: false,
        kill_switch_enabled: true,
        basis: model.basis
      };
      let quoteId: string | null = null;
      if (input.apply && modelVersion) {
        await db.query("SELECT register_forecast_match($1::uuid)", [matchId]);
        const result = await db.query(
          `
            INSERT INTO model_quotes (
              match_id, model_name, market_type, line,
              home_probability, away_probability, draw_probability,
              home_fair_odds, away_fair_odds, draw_fair_odds,
              confidence, generated_at, raw_data
            )
            SELECT
              $1::uuid, $2::varchar, 'moneyline_2way', NULL,
              $3, $4, NULL, $5, $6, NULL, $7, $8::timestamptz, $9::jsonb
            WHERE NOT EXISTS (
              SELECT 1
              FROM model_quotes existing
              WHERE existing.match_id = $1::uuid
                AND existing.model_name = $2::varchar
                AND existing.market_type = 'moneyline_2way'
                AND existing.raw_data->>'input_snapshot_sha256' = $10
                AND existing.raw_data->>'artifact_sha256' = $11
            )
            RETURNING id
          `,
          [
            matchId,
            MODEL_NAME,
            model.probabilities.home,
            model.probabilities.away,
            model.fair_odds.home,
            model.fair_odds.away,
            model.confidence,
            generatedAtIso,
            JSON.stringify(rawData),
            model.input_snapshot_sha256,
            artifactSha256
          ]
        );
        quoteId = result.rows[0]?.id ? String(result.rows[0].id) : null;
        if (quoteId) inserted += 1;
        else {
          const existing = await db.query(
            `
              SELECT id
              FROM model_quotes
              WHERE match_id = $1::uuid
                AND model_name = $2
                AND market_type = 'moneyline_2way'
                AND raw_data->>'input_snapshot_sha256' = $3
                AND raw_data->>'artifact_sha256' = $4
              ORDER BY generated_at DESC
              LIMIT 1
            `,
            [matchId, MODEL_NAME, model.input_snapshot_sha256, artifactSha256]
          );
          quoteId = existing.rows[0]?.id ? String(existing.rows[0].id) : null;
          reused += 1;
        }
      }
      rows.push({
        match_id: matchId,
        match: `${homeTeam} vs ${awayTeam}`,
        kickoff,
        target_competition_type: targetCompetitionType,
        model_name: MODEL_NAME,
        model_version_label: modelVersionLabel,
        model_version_id: modelVersion?.id ?? null,
        quote_id: quoteId,
        market_type: "moneyline_2way",
        probabilities: model.probabilities,
        fair_odds: model.fair_odds,
        confidence: model.confidence,
        uncertainty: model.uncertainty,
        training_cutoff_date: model.training_cutoff_date,
        artifact_sha256: artifactSha256,
        config_sha256: configSha256,
        input_snapshot_sha256: model.input_snapshot_sha256,
        output_sha256: model.output_sha256,
        market_inputs_used: false,
        status: input.apply ? (quoteId ? "NFL_FAIR_ODDS_RECORDED" : "NFL_FAIR_ODDS_REUSED") : "NFL_FAIR_ODDS_READY_DRY_RUN",
        basis: model.basis
      });
    } catch (error) {
      blocked += 1;
      rows.push({
        match_id: matchId,
        match: `${homeTeam} vs ${awayTeam}`,
        kickoff,
        status: "NFL_FAIR_ODDS_BLOCKED",
        reason: error instanceof Error ? error.message : String(error),
        verified_history: { home: homeForm.length, away: awayForm.length },
        required_history_per_team: NFL_FAIR_ODDS_CONFIG.min_form_matches,
        market_inputs_used: false
      });
    }
  }

  return {
    system_status: blocked > 0 && rows.length === blocked
      ? "NFL_FAIR_ODDS_BLOCKED"
      : input.apply
        ? "NFL_FAIR_ODDS_APPLIED"
        : "NFL_FAIR_ODDS_DRY_RUN",
    generated_at: generatedAtIso,
    selected_date: window.selectedDate,
    apply: input.apply,
    matches_considered: matches.rows.length,
    inserted,
    reused,
    blocked,
    rows,
    guardrails: {
      real_candidate: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      autopost_enabled: false,
      kill_switch_enabled: true
    }
  };
}
