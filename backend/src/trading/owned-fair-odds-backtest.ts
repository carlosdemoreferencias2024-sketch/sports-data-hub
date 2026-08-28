import {
  computeFootballFairOddsV3,
  FOOTBALL_FAIR_ODDS_V3_CONFIG,
  type FootballFormObservation
} from "./football-fair-odds-model.js";
import {
  computeNflFairOdds,
  NFL_FAIR_ODDS_CONFIG,
  type NflResultObservation
} from "./nfl-fair-odds-model.js";
import {
  computeNbaFairOdds,
  NBA_FAIR_ODDS_CONFIG,
  type NbaResultObservation
} from "./nba-fair-odds-model.js";

export type BacktestSport = "soccer" | "nfl" | "nba";
export type BacktestMode = "persisted" | "event-time" | "ingested-time";

type QueryResult = { rows: Array<Record<string, unknown>> };
export type BacktestQueryable = {
  query: (text: string, values?: unknown[]) => Promise<QueryResult>;
};

export type OwnedFairOddsBacktestOptions = {
  sports: BacktestSport[];
  from: string;
  to: string;
  league?: string | null;
  mode: BacktestMode;
  requireContext?: boolean;
  allowUnverifiedResults?: boolean;
  limit?: number;
};

type Outcome = "home" | "draw" | "away";
type ScoredPrediction = {
  sport: BacktestSport;
  league: string;
  matchId: string;
  kickoff: string;
  modelName: string;
  marketType: "moneyline_2way" | "moneyline_3way";
  homeProbability: number;
  drawProbability: number | null;
  awayProbability: number;
  actual: Outcome;
  predicted: Outcome;
  confidence: number | null;
  contextComplete: boolean;
};

type HistoryRow = {
  matchId: string;
  playedAt: string;
  normalizedTeamName: string;
  pointsFor: number;
  pointsAgainst: number;
  isHome: boolean;
  isPreseason: boolean;
  restDays: number | null;
  source: string;
  sourceConfidenceScore: number;
  evidenceSha256: string;
  capturedAt: string;
  featureAsOf: string;
  teamEloBefore: number | null;
  teamEloAfter: number | null;
  opponentEloBefore: number | null;
  xgFor: number | null;
  xgAgainst: number | null;
  opponentElo: number | null;
  trustedFootballIdentity: boolean;
};

const SHA256 = /^[a-f0-9]{64}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const clampProbability = (value: number) => Math.max(1e-12, Math.min(1 - 1e-12, value));
const numericOrNull = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

function normalizeTeamName(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function outcome(homeScore: unknown, awayScore: unknown): Outcome {
  const home = Number(homeScore);
  const away = Number(awayScore);
  if (home > away) return "home";
  if (home < away) return "away";
  return "draw";
}

function predictedOutcome(home: number, draw: number | null, away: number): Outcome {
  const candidates: Array<[Outcome, number]> = [["home", home], ["away", away]];
  if (draw !== null) candidates.push(["draw", draw]);
  return candidates.sort((left, right) => right[1] - left[1])[0][0];
}

function sourceResultTrusted(rawData: unknown) {
  const raw = rawData && typeof rawData === "object" ? rawData as Record<string, unknown> : {};
  const source = [raw.source, raw.source_name, raw.source_match_id, raw.provider_name, raw.provider_event_id]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
  return source.includes("espn-")
    || source.includes("espn_")
    || source.includes("mlb_stats")
    || source.includes("mlb.com")
    || source.includes("official")
    || source.includes("manual_verified");
}

function explicitFalse(value: unknown) {
  return !["true", "1", "yes"].includes(String(value ?? "").toLowerCase());
}

function footballIdentityTrusted(row: Record<string, unknown>) {
  return Boolean(String(row.provider_event_id ?? "").trim())
    && String(row.identity_validation ?? "").toUpperCase() === "VALID"
    && String(row.schedule_validation ?? "").toUpperCase() === "VALID"
    && explicitFalse(row.synthetic)
    && explicitFalse(row.invalidated);
}

function metricSummary(rows: ScoredPrediction[]) {
  if (!rows.length) {
    return {
      sample_size: 0,
      accuracy: null,
      brier_score: null,
      log_loss: null,
      home_probability_ece: null,
      empirical_baseline_brier: null,
      brier_skill_vs_empirical: null,
      class_counts: { home: 0, draw: 0, away: 0 },
      calibration_bins: []
    };
  }
  const marketTypes = [...new Set(rows.map((row) => row.marketType))];
  const mixedMarketTypes = marketTypes.length > 1;
  let correct = 0;
  let brier = 0;
  let logLoss = 0;
  const counts = { home: 0, draw: 0, away: 0 };
  const bins = Array.from({ length: 10 }, (_, index) => ({
    lower: index / 10,
    upper: (index + 1) / 10,
    count: 0,
    probabilityTotal: 0,
    outcomeTotal: 0
  }));
  for (const row of rows) {
    counts[row.actual] += 1;
    if (row.predicted === row.actual) correct += 1;
    const actualHome = row.actual === "home" ? 1 : 0;
    const actualAway = row.actual === "away" ? 1 : 0;
    if (row.marketType === "moneyline_3way") {
      const drawProbability = Number(row.drawProbability ?? 0);
      const actualDraw = row.actual === "draw" ? 1 : 0;
      brier += Math.pow(row.homeProbability - actualHome, 2)
        + Math.pow(drawProbability - actualDraw, 2)
        + Math.pow(row.awayProbability - actualAway, 2);
      const actualProbability = row.actual === "home"
        ? row.homeProbability
        : row.actual === "draw"
          ? drawProbability
          : row.awayProbability;
      logLoss += -Math.log(clampProbability(actualProbability));
    } else {
      brier += Math.pow(row.homeProbability - actualHome, 2);
      logLoss += -(actualHome * Math.log(clampProbability(row.homeProbability))
        + (1 - actualHome) * Math.log(clampProbability(1 - row.homeProbability)));
    }
    const index = Math.min(9, Math.floor(row.homeProbability * 10));
    bins[index].count += 1;
    bins[index].probabilityTotal += row.homeProbability;
    bins[index].outcomeTotal += actualHome;
  }
  const classProbabilities = {
    home: counts.home / rows.length,
    draw: counts.draw / rows.length,
    away: counts.away / rows.length
  };
  const threeWay = !mixedMarketTypes && rows[0].marketType === "moneyline_3way";
  const empiricalBaselineBrier = mixedMarketTypes ? null : threeWay
    ? rows.reduce((sum, row) => sum
      + Math.pow(classProbabilities.home - (row.actual === "home" ? 1 : 0), 2)
      + Math.pow(classProbabilities.draw - (row.actual === "draw" ? 1 : 0), 2)
      + Math.pow(classProbabilities.away - (row.actual === "away" ? 1 : 0), 2), 0) / rows.length
    : rows.reduce((sum, row) => sum
      + Math.pow(classProbabilities.home - (row.actual === "home" ? 1 : 0), 2), 0) / rows.length;
  const brierScore = mixedMarketTypes ? null : brier / rows.length;
  const populatedBins = bins.filter((bin) => bin.count > 0).map((bin) => ({
    lower: bin.lower,
    upper: bin.upper,
    count: bin.count,
    mean_probability: Number((bin.probabilityTotal / bin.count).toFixed(6)),
    observed_home_rate: Number((bin.outcomeTotal / bin.count).toFixed(6))
  }));
  const ece = populatedBins.reduce((sum, bin) => sum
    + (bin.count / rows.length) * Math.abs(bin.mean_probability - bin.observed_home_rate), 0);
  return {
    sample_size: rows.length,
    mixed_market_types: mixedMarketTypes,
    market_types: marketTypes,
    accuracy: Number((correct / rows.length).toFixed(6)),
    brier_score: brierScore === null ? null : Number(brierScore.toFixed(6)),
    log_loss: Number((logLoss / rows.length).toFixed(6)),
    home_probability_ece: Number(ece.toFixed(6)),
    empirical_baseline_brier: empiricalBaselineBrier === null ? null : Number(empiricalBaselineBrier.toFixed(6)),
    brier_skill_vs_empirical: empiricalBaselineBrier !== null && empiricalBaselineBrier > 0 && brierScore !== null
      ? Number((1 - brierScore / empiricalBaselineBrier).toFixed(6))
      : null,
    class_counts: counts,
    calibration_bins: populatedBins
  };
}

function summarizePredictions(rows: ScoredPrediction[]) {
  const groups = new Map<string, ScoredPrediction[]>();
  for (const row of rows) {
    const key = `${row.sport}|${row.league}|${row.modelName}|${row.marketType}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, groupRows]) => {
    const [sport, league, modelName, marketType] = key.split("|");
    return {
      sport,
      league,
      model_name: modelName,
      market_type: marketType,
      context_complete_count: groupRows.filter((row) => row.contextComplete).length,
      ...metricSummary(groupRows)
    };
  });
}

function sportDbValues(sport: BacktestSport) {
  if (sport === "soccer") return ["soccer", "football"];
  if (sport === "nfl") return ["american_football"];
  return ["basketball"];
}

function sportModelName(sport: BacktestSport) {
  if (sport === "soccer") return "sports_data_hub_football_fair_odds_v3";
  if (sport === "nfl") return "sports_data_hub_nfl_fair_odds_v1";
  return "sports_data_hub_nba_fair_odds_v1";
}

async function persistedBacktest(db: BacktestQueryable, options: OwnedFairOddsBacktestOptions) {
  const modelNames = options.sports.map(sportModelName);
  const result = await db.query(
    `
      WITH ranked AS (
        SELECT
          mq.*,
          match.match_date AS kickoff,
          match.home_score,
          match.away_score,
          match.raw_data AS match_raw_data,
          league.slug AS league_slug,
          sport.slug AS sport_slug,
          EXISTS (
            SELECT 1 FROM forecast_context_snapshots context
            WHERE context.match_id = match.id
              AND context.captured_at < match.match_date
              AND context.completeness_flag = 'complete'
          ) AS context_complete,
          ROW_NUMBER() OVER (
            PARTITION BY mq.match_id, mq.model_name, mq.market_type
            ORDER BY mq.generated_at DESC, mq.id DESC
          ) AS row_number
        FROM model_quotes mq
        JOIN matches match ON match.id = mq.match_id
        JOIN leagues league ON league.id = match.league_id
        JOIN sports sport ON sport.id = league.sport_id
        WHERE mq.model_name = ANY($1::text[])
          AND COALESCE((mq.raw_data->>'owned_fair_odds')::boolean, false)
          AND mq.market_type IN ('moneyline_2way', 'moneyline_3way')
          AND mq.generated_at < match.match_date
          AND match.status = 'finished'
          AND match.home_score IS NOT NULL
          AND match.away_score IS NOT NULL
          AND match.match_date >= $2::timestamptz
          AND match.match_date < $3::timestamptz
          AND match.data_quality_flag = 'AUTHENTIC'
          AND match.invalidated_at IS NULL
          AND match.duplicate_of_match_id IS NULL
          AND ($4::text IS NULL OR league.slug = $4)
      )
      SELECT * FROM ranked
      WHERE row_number = 1
      ORDER BY kickoff, match_id
      LIMIT $5
    `,
    [modelNames, options.from, options.to, options.league ?? null, options.limit ?? 10_000]
  );
  const blocked: Record<string, number> = {};
  const predictions: ScoredPrediction[] = [];
  for (const row of result.rows) {
    if (options.requireContext && row.context_complete !== true) {
      blocked.CONTEXT_COMPLETE_MISSING = (blocked.CONTEXT_COMPLETE_MISSING ?? 0) + 1;
      continue;
    }
    if (!options.allowUnverifiedResults && !sourceResultTrusted(row.match_raw_data)) {
      blocked.RESULT_SOURCE_NOT_VERIFIED = (blocked.RESULT_SOURCE_NOT_VERIFIED ?? 0) + 1;
      continue;
    }
    const actual = outcome(row.home_score, row.away_score);
    if (row.market_type === "moneyline_2way" && actual === "draw") {
      blocked.DRAW_UNSUPPORTED_BY_2WAY = (blocked.DRAW_UNSUPPORTED_BY_2WAY ?? 0) + 1;
      continue;
    }
    const sport = String(row.model_name).includes("nfl") ? "nfl"
      : String(row.model_name).includes("nba") ? "nba" : "soccer";
    const homeProbability = Number(row.home_probability);
    const awayProbability = Number(row.away_probability);
    const drawProbability = numericOrNull(row.draw_probability);
    predictions.push({
      sport,
      league: String(row.league_slug),
      matchId: String(row.match_id),
      kickoff: new Date(String(row.kickoff)).toISOString(),
      modelName: String(row.model_name),
      marketType: String(row.market_type) as "moneyline_2way" | "moneyline_3way",
      homeProbability,
      drawProbability,
      awayProbability,
      actual,
      predicted: predictedOutcome(homeProbability, drawProbability, awayProbability),
      confidence: numericOrNull(row.confidence),
      contextComplete: row.context_complete === true
    });
  }
  return { predictions, blocked, targetsScanned: result.rows.length };
}

async function loadReplayTargets(db: BacktestQueryable, sport: BacktestSport, options: OwnedFairOddsBacktestOptions) {
  return db.query(
    `
      SELECT
        mh.*,
        COALESCE(mh.provider_match_id, mh.raw_data->>'provider_event_id') AS provider_event_id,
        mh.raw_data->>'identity_validation' AS identity_validation,
        mh.raw_data->>'schedule_validation' AS schedule_validation,
        mh.raw_data->>'synthetic' AS synthetic,
        mh.raw_data->>'invalidated' AS invalidated,
        CASE
          WHEN COALESCE(mh.canonical_match_id, '') ~* $6
          THEN EXISTS (
            SELECT 1 FROM forecast_context_snapshots context
            WHERE context.match_id = mh.canonical_match_id::uuid
              AND context.captured_at < mh.match_date
              AND context.completeness_flag = 'complete'
          )
          ELSE false
        END AS context_complete
      FROM sports_match_history mh
      WHERE mh.sport = ANY($1::text[])
        AND mh.match_date >= $2::timestamptz
        AND mh.match_date < $3::timestamptz
        AND UPPER(mh.status) IN ('FINAL', 'FINISHED', 'FT')
        AND mh.home_score IS NOT NULL
        AND mh.away_score IS NOT NULL
        AND ($4::text IS NULL OR mh.league_id = $4)
      ORDER BY mh.match_date, mh.match_id
      LIMIT $5
    `,
    [sportDbValues(sport), options.from, options.to, options.league ?? null, options.limit ?? 10_000, UUID.source]
  );
}

async function loadHistory(db: BacktestQueryable, sport: BacktestSport, options: OwnedFairOddsBacktestOptions) {
  const result = await db.query(
    `
      SELECT
        tms.match_id,
        mh.match_date,
        tms.normalized_team_name,
        tms.points_for,
        tms.points_against,
        tms.is_home,
        mh.is_preseason,
        tms.rest_days,
        tms.source,
        tms.source_confidence_score,
        COALESCE(NULLIF(tms.raw_data->>'captured_at', '')::timestamptz, mh.source_observed_at, tms.created_at) AS captured_at,
        COALESCE(tms.raw_data->>'provider_raw_sha256', mh.raw_data->>'provider_raw_sha256') AS evidence_sha256,
        CASE WHEN COALESCE(tms.raw_data->>'team_elo_before', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (tms.raw_data->>'team_elo_before')::numeric END AS team_elo_before,
        CASE WHEN COALESCE(tms.raw_data->>'team_elo_after', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (tms.raw_data->>'team_elo_after')::numeric END AS team_elo_after,
        CASE WHEN COALESCE(tms.raw_data->>'opponent_elo_before', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (tms.raw_data->>'opponent_elo_before')::numeric END AS opponent_elo_before,
        CASE WHEN COALESCE(tms.raw_data->>'xg_for', tms.raw_data->>'xgFor', '') ~ '^[0-9]+(\\.[0-9]+)?$'
          THEN COALESCE(tms.raw_data->>'xg_for', tms.raw_data->>'xgFor')::numeric END AS xg_for,
        CASE WHEN COALESCE(tms.raw_data->>'xg_against', tms.raw_data->>'xgAgainst', '') ~ '^[0-9]+(\\.[0-9]+)?$'
          THEN COALESCE(tms.raw_data->>'xg_against', tms.raw_data->>'xgAgainst')::numeric END AS xg_against,
        CASE WHEN COALESCE(tms.raw_data->>'opponent_elo', tms.raw_data->>'opponentElo', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN COALESCE(tms.raw_data->>'opponent_elo', tms.raw_data->>'opponentElo')::numeric END AS opponent_elo,
        COALESCE(mh.provider_match_id, mh.raw_data->>'provider_event_id', tms.raw_data->>'provider_event_id') AS provider_event_id,
        COALESCE(mh.raw_data->>'identity_validation', tms.raw_data->>'identity_validation') AS identity_validation,
        COALESCE(mh.raw_data->>'schedule_validation', tms.raw_data->>'schedule_validation') AS schedule_validation,
        COALESCE(mh.raw_data->>'synthetic', tms.raw_data->>'synthetic') AS synthetic,
        COALESCE(mh.raw_data->>'invalidated', tms.raw_data->>'invalidated') AS invalidated
      FROM sports_team_match_stats tms
      JOIN sports_match_history mh ON mh.match_id = tms.match_id
      WHERE tms.sport = ANY($1::text[])
        AND mh.match_date < $2::timestamptz
        AND UPPER(mh.status) IN ('FINAL', 'FINISHED', 'FT')
        AND tms.points_for IS NOT NULL
        AND tms.points_against IS NOT NULL
        AND ($3::text IS NULL OR tms.league_id = $3)
      ORDER BY mh.match_date
    `,
    [sportDbValues(sport), options.to, options.league ?? null]
  );
  const byTeam = new Map<string, HistoryRow[]>();
  for (const row of result.rows) {
    const playedAt = new Date(String(row.match_date)).toISOString();
    const actualCapturedAt = new Date(String(row.captured_at)).toISOString();
    const item: HistoryRow = {
      matchId: String(row.match_id),
      playedAt,
      normalizedTeamName: String(row.normalized_team_name),
      pointsFor: Number(row.points_for),
      pointsAgainst: Number(row.points_against),
      isHome: Boolean(row.is_home),
      isPreseason: Boolean(row.is_preseason),
      restDays: numericOrNull(row.rest_days),
      source: String(row.source),
      sourceConfidenceScore: Number(row.source_confidence_score),
      evidenceSha256: String(row.evidence_sha256 ?? ""),
      capturedAt: options.mode === "event-time" ? playedAt : actualCapturedAt,
      featureAsOf: playedAt,
      teamEloBefore: numericOrNull(row.team_elo_before),
      teamEloAfter: numericOrNull(row.team_elo_after),
      opponentEloBefore: numericOrNull(row.opponent_elo_before),
      xgFor: numericOrNull(row.xg_for),
      xgAgainst: numericOrNull(row.xg_against),
      opponentElo: numericOrNull(row.opponent_elo),
      trustedFootballIdentity: footballIdentityTrusted(row)
    };
    byTeam.set(item.normalizedTeamName, [...(byTeam.get(item.normalizedTeamName) ?? []), item]);
  }
  return byTeam;
}

function competitionType(row: Record<string, unknown>): "preseason" | "regular" | "postseason" {
  if (row.is_preseason === true) return "preseason";
  const value = String(row.competition_type ?? "").toLowerCase();
  return value.includes("post") ? "postseason" : "regular";
}

async function replayBacktest(db: BacktestQueryable, sport: BacktestSport, options: OwnedFairOddsBacktestOptions) {
  const [targetResult, historyByTeam] = await Promise.all([
    loadReplayTargets(db, sport, options),
    loadHistory(db, sport, options)
  ]);
  const predictions: ScoredPrediction[] = [];
  const blocked: Record<string, number> = {};
  const block = (reason: string) => { blocked[reason] = (blocked[reason] ?? 0) + 1; };
  const minimumConfidence = sport === "soccer"
    ? FOOTBALL_FAIR_ODDS_V3_CONFIG.min_source_confidence
    : sport === "nfl" ? NFL_FAIR_ODDS_CONFIG.min_source_confidence : NBA_FAIR_ODDS_CONFIG.min_source_confidence;

  for (const target of targetResult.rows) {
    if (options.requireContext && target.context_complete !== true) {
      block("CONTEXT_COMPLETE_MISSING");
      continue;
    }
    const targetHash = String((target.raw_data as Record<string, unknown> | undefined)?.provider_raw_sha256 ?? "");
    if (!options.allowUnverifiedResults
        && (!SHA256.test(targetHash) || Number(target.source_confidence_score ?? 0) < minimumConfidence)) {
      block("RESULT_SOURCE_NOT_VERIFIED");
      continue;
    }
    if (sport === "soccer" && !footballIdentityTrusted(target)) {
      block("TARGET_IDENTITY_NOT_REPLAYABLE");
      continue;
    }
    const actual = outcome(target.home_score, target.away_score);
    if (sport !== "soccer" && actual === "draw") {
      block("DRAW_UNSUPPORTED_BY_2WAY");
      continue;
    }
    const kickoff = new Date(String(target.match_date));
    const asOf = new Date(kickoff.getTime() - 1).toISOString();
    const homeTeam = String(target.home_team);
    const awayTeam = String(target.away_team);
    const validHistory = (team: string) => (historyByTeam.get(normalizeTeamName(team)) ?? [])
      .filter((row) => new Date(row.playedAt).getTime() < kickoff.getTime())
      .filter((row) => row.sourceConfidenceScore >= minimumConfidence)
      .filter((row) => SHA256.test(row.evidenceSha256))
      .filter((row) => sport !== "soccer" || row.trustedFootballIdentity);
    const homeHistory = validHistory(homeTeam);
    const awayHistory = validHistory(awayTeam);
    try {
      let homeProbability: number;
      let drawProbability: number | null;
      let awayProbability: number;
      let confidence: number | null;
      if (sport === "soccer") {
        const toFootball = (rows: HistoryRow[]): FootballFormObservation[] => rows.map((row) => ({
          matchId: row.matchId,
          playedAt: row.playedAt,
          goalsFor: row.pointsFor,
          goalsAgainst: row.pointsAgainst,
          isHome: row.isHome,
          source: row.source,
          sourceConfidenceScore: row.sourceConfidenceScore,
          evidenceSha256: row.evidenceSha256,
          capturedAt: row.capturedAt,
          featureAsOf: row.featureAsOf,
          xgFor: row.xgFor,
          xgAgainst: row.xgAgainst,
          opponentElo: row.opponentElo
        }));
        const model = computeFootballFairOddsV3({
          targetMatchId: String(target.match_id),
          homeTeam,
          awayTeam,
          asOf,
          targetKickoffAt: kickoff.toISOString(),
          homeForm: toFootball(homeHistory),
          awayForm: toFootball(awayHistory)
        });
        homeProbability = model.probabilities.home;
        drawProbability = model.probabilities.draw;
        awayProbability = model.probabilities.away;
        confidence = model.confidence;
      } else if (sport === "nfl") {
        const toNfl = (rows: HistoryRow[]): NflResultObservation[] => rows.map((row) => ({
          matchId: row.matchId,
          playedAt: row.playedAt,
          pointsFor: row.pointsFor,
          pointsAgainst: row.pointsAgainst,
          isHome: row.isHome,
          isPreseason: row.isPreseason,
          source: row.source,
          sourceConfidenceScore: row.sourceConfidenceScore,
          evidenceSha256: row.evidenceSha256,
          capturedAt: row.capturedAt,
          featureAsOf: row.featureAsOf,
          teamEloBefore: row.teamEloBefore,
          teamEloAfter: row.teamEloAfter,
          opponentEloBefore: row.opponentEloBefore
        }));
        const model = computeNflFairOdds({
          homeTeam,
          awayTeam,
          asOf,
          targetCompetitionType: competitionType(target),
          homeForm: toNfl(homeHistory),
          awayForm: toNfl(awayHistory)
        });
        homeProbability = model.probabilities.home;
        drawProbability = null;
        awayProbability = model.probabilities.away;
        confidence = model.confidence;
      } else {
        const toNba = (rows: HistoryRow[]): NbaResultObservation[] => rows.map((row) => ({
          matchId: row.matchId,
          playedAt: row.playedAt,
          pointsFor: row.pointsFor,
          pointsAgainst: row.pointsAgainst,
          isHome: row.isHome,
          isPreseason: row.isPreseason,
          restDays: row.restDays,
          source: row.source,
          sourceConfidenceScore: row.sourceConfidenceScore,
          evidenceSha256: row.evidenceSha256,
          capturedAt: row.capturedAt,
          featureAsOf: row.featureAsOf,
          teamEloBefore: row.teamEloBefore,
          teamEloAfter: row.teamEloAfter,
          opponentEloBefore: row.opponentEloBefore
        }));
        const model = computeNbaFairOdds({
          homeTeam,
          awayTeam,
          asOf,
          kickoff: kickoff.toISOString(),
          targetCompetitionType: competitionType(target),
          homeForm: toNba(homeHistory),
          awayForm: toNba(awayHistory)
        });
        homeProbability = model.probabilities.home;
        drawProbability = null;
        awayProbability = model.probabilities.away;
        confidence = model.confidence;
      }
      predictions.push({
        sport,
        league: String(target.league_id),
        matchId: String(target.match_id),
        kickoff: kickoff.toISOString(),
        modelName: sportModelName(sport),
        marketType: sport === "soccer" ? "moneyline_3way" : "moneyline_2way",
        homeProbability,
        drawProbability,
        awayProbability,
        actual,
        predicted: predictedOutcome(homeProbability, drawProbability, awayProbability),
        confidence,
        contextComplete: target.context_complete === true
      });
    } catch (error) {
      block(error instanceof Error ? error.message : String(error));
    }
  }
  return { predictions, blocked, targetsScanned: targetResult.rows.length };
}

export async function runOwnedFairOddsBacktest(db: BacktestQueryable, options: OwnedFairOddsBacktestOptions) {
  const startedAt = new Date();
  const predictions: ScoredPrediction[] = [];
  const blocked: Record<string, number> = {};
  let targetsScanned = 0;
  if (options.mode === "persisted") {
    const result = await persistedBacktest(db, options);
    predictions.push(...result.predictions);
    targetsScanned += result.targetsScanned;
    Object.assign(blocked, result.blocked);
  } else {
    for (const sport of options.sports) {
      const result = await replayBacktest(db, sport, options);
      predictions.push(...result.predictions);
      targetsScanned += result.targetsScanned;
      for (const [reason, count] of Object.entries(result.blocked)) {
        blocked[reason] = (blocked[reason] ?? 0) + count;
      }
    }
  }
  return {
    system_status: predictions.length ? "BACKTEST_COMPLETE" : "INSUFFICIENT_REPLAYABLE_SAMPLE",
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    mode: options.mode,
    cohort_semantics: options.mode === "persisted"
      ? "Operationally auditable quotes actually persisted before kickoff."
      : options.mode === "ingested-time"
        ? "Strict replay using only history captured by the hub before each target kickoff."
        : "Model replay by event time. Historical results were backfilled later, so this is not an operational availability claim.",
    filters: {
      sports: options.sports,
      from: options.from,
      to: options.to,
      league: options.league ?? null,
      require_context: options.requireContext === true,
      require_verified_result: options.allowUnverifiedResults !== true,
      limit: options.limit ?? 10_000
    },
    targets_scanned: targetsScanned,
    predictions_scored: predictions.length,
    blocked,
    overall: metricSummary(predictions),
    segments: summarizePredictions(predictions),
    guardrails: {
      read_only: true,
      writes_performed: 0,
      market_odds_used_as_model_input: false,
      real_candidate: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      autopost_enabled: false
    }
  };
}

export const backtestMetricsForTest = metricSummary;
