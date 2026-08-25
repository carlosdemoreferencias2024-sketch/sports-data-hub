import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type NbaResultObservation = {
  matchId: string;
  playedAt: string;
  pointsFor: number;
  pointsAgainst: number;
  isHome: boolean;
  isPreseason: boolean;
  source: string;
  sourceConfidenceScore: number;
  evidenceSha256: string;
  capturedAt: string;
  featureAsOf: string;
  restDays?: number | null;
  teamEloBefore?: number | null;
  teamEloAfter?: number | null;
  opponentEloBefore?: number | null;
};

export type NbaFairOddsInput = {
  homeTeam: string;
  awayTeam: string;
  asOf: string;
  kickoff: string;
  targetCompetitionType: "preseason" | "regular" | "postseason";
  homeForm: NbaResultObservation[];
  awayForm: NbaResultObservation[];
};

export const NBA_FAIR_ODDS_CONFIG = Object.freeze({
  model_family: "elo_margin_rest_recency_logit_v1",
  feature_schema_version: "nba_results_elo_margin_rest_v1",
  fair_odds_method_version: "owned_fair_odds_nba_v1",
  max_form_matches: 20,
  min_form_matches: 12,
  min_source_confidence: 90,
  half_life_days: 55,
  regular_home_field_points: 2.4,
  preseason_home_field_points: 1.0,
  regular_home_field_elo: 60,
  preseason_home_field_elo: 25,
  elo_scale: 400,
  margin_logistic_scale: 11.5,
  elo_weight: 0.42,
  form_weight: 0.58,
  rest_points_per_day: 0.65,
  max_rest_edge_days: 3,
  preseason_result_weight: 0.3,
  preseason_target_shrink: 0.5,
  max_probability: 0.9,
  min_probability: 0.1
});

export const NBA_FAIR_ODDS_LOGIC_VERSION = "nba-fair-odds-model.ts:v1.0.0";

const DAY_MS = 86_400_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function sha256(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function nbaFairOddsConfigSha256() {
  return sha256(NBA_FAIR_ODDS_CONFIG);
}

export function nbaFairOddsArtifactSha256(provenance: {
  sourceCodeSha256?: string;
  gitCommit?: string;
} = {}) {
  const executedModuleSha256 = crypto.createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex");
  const sourceCodeSha256 = provenance.sourceCodeSha256
    || process.env.NBA_FAIR_ODDS_SOURCE_SHA256
    || executedModuleSha256;
  if (!SHA256_PATTERN.test(sourceCodeSha256)) throw new Error("nba_fair_odds_source_sha256_invalid");
  return sha256({
    config: NBA_FAIR_ODDS_CONFIG,
    logic_version: NBA_FAIR_ODDS_LOGIC_VERSION,
    source_code_sha256: sourceCodeSha256,
    git_commit: provenance.gitCommit || process.env.GIT_COMMIT_SHA || null
  });
}

function normalizedForm(rows: NbaResultObservation[], asOf: Date) {
  return rows
    .map((row) => ({
      ...row,
      playedAtDate: new Date(row.playedAt),
      capturedAtDate: new Date(row.capturedAt),
      featureAsOfDate: new Date(row.featureAsOf)
    }))
    .filter((row) => !Number.isNaN(row.playedAtDate.getTime()))
    .filter((row) => !Number.isNaN(row.capturedAtDate.getTime()) && row.capturedAtDate.getTime() <= asOf.getTime())
    .filter((row) => !Number.isNaN(row.featureAsOfDate.getTime()) && row.featureAsOfDate.getTime() <= asOf.getTime())
    .filter((row) => row.playedAtDate.getTime() < asOf.getTime())
    .filter((row) => Number.isFinite(row.pointsFor) && Number.isFinite(row.pointsAgainst))
    .filter((row) => row.pointsFor >= 0 && row.pointsAgainst >= 0)
    .filter((row) => row.sourceConfidenceScore >= NBA_FAIR_ODDS_CONFIG.min_source_confidence)
    .filter((row) => SHA256_PATTERN.test(row.evidenceSha256))
    .sort((left, right) => right.playedAtDate.getTime() - left.playedAtDate.getTime())
    .slice(0, NBA_FAIR_ODDS_CONFIG.max_form_matches);
}

function weightedTeamSignal(rows: ReturnType<typeof normalizedForm>, asOf: Date) {
  let marginTotal = 0;
  let scoringTotal = 0;
  let weightTotal = 0;
  for (const row of rows) {
    const ageDays = Math.max(0, (asOf.getTime() - row.playedAtDate.getTime()) / DAY_MS);
    const recencyWeight = Math.pow(0.5, ageDays / NBA_FAIR_ODDS_CONFIG.half_life_days);
    const competitionWeight = row.isPreseason ? NBA_FAIR_ODDS_CONFIG.preseason_result_weight : 1;
    const venueAdjustment = row.isHome
      ? -NBA_FAIR_ODDS_CONFIG.regular_home_field_points
      : NBA_FAIR_ODDS_CONFIG.regular_home_field_points;
    const opponentAdjustment = Number.isFinite(row.opponentEloBefore)
      ? clamp((Number(row.opponentEloBefore) - 1500) / 35, -6, 6)
      : 0;
    const weight = recencyWeight * competitionWeight;
    marginTotal += ((row.pointsFor - row.pointsAgainst) + venueAdjustment + opponentAdjustment) * weight;
    scoringTotal += ((row.pointsFor + row.pointsAgainst) / 2) * weight;
    weightTotal += weight;
  }
  const latestElo = rows.find((row) => Number.isFinite(row.teamEloAfter))?.teamEloAfter;
  return {
    neutralMargin: marginTotal / weightTotal,
    scoringEnvironment: scoringTotal / weightTotal,
    latestElo: Number.isFinite(latestElo) ? Number(latestElo) : 1500
  };
}

function logistic(value: number) {
  return 1 / (1 + Math.exp(-value));
}

function round(value: number, digits = 6) {
  return Number(value.toFixed(digits));
}

function targetRestDays(rows: ReturnType<typeof normalizedForm>, kickoff: Date) {
  const latest = rows[0]?.playedAtDate;
  if (!latest) return 2;
  return clamp((kickoff.getTime() - latest.getTime()) / DAY_MS, 0, 7);
}

export function computeNbaFairOdds(input: NbaFairOddsInput) {
  const asOf = new Date(input.asOf);
  const kickoff = new Date(input.kickoff);
  if (Number.isNaN(asOf.getTime())) throw new Error("nba_fair_odds_as_of_invalid");
  if (Number.isNaN(kickoff.getTime()) || kickoff.getTime() <= asOf.getTime()) {
    throw new Error("nba_fair_odds_kickoff_invalid_or_started");
  }
  const homeForm = normalizedForm(input.homeForm, asOf);
  const awayForm = normalizedForm(input.awayForm, asOf);
  if (homeForm.length < NBA_FAIR_ODDS_CONFIG.min_form_matches
      || awayForm.length < NBA_FAIR_ODDS_CONFIG.min_form_matches) {
    throw new Error("nba_fair_odds_verified_history_insufficient");
  }

  const home = weightedTeamSignal(homeForm, asOf);
  const away = weightedTeamSignal(awayForm, asOf);
  const preseasonTarget = input.targetCompetitionType === "preseason";
  const homeFieldPoints = preseasonTarget
    ? NBA_FAIR_ODDS_CONFIG.preseason_home_field_points
    : NBA_FAIR_ODDS_CONFIG.regular_home_field_points;
  const homeFieldElo = preseasonTarget
    ? NBA_FAIR_ODDS_CONFIG.preseason_home_field_elo
    : NBA_FAIR_ODDS_CONFIG.regular_home_field_elo;
  const homeRestDays = targetRestDays(homeForm, kickoff);
  const awayRestDays = targetRestDays(awayForm, kickoff);
  const restEdgeDays = clamp(homeRestDays - awayRestDays, -NBA_FAIR_ODDS_CONFIG.max_rest_edge_days, NBA_FAIR_ODDS_CONFIG.max_rest_edge_days);
  const restAdjustmentPoints = restEdgeDays * NBA_FAIR_ODDS_CONFIG.rest_points_per_day;
  const scoringEnvironment = (home.scoringEnvironment + away.scoringEnvironment) / 2;
  const paceMultiplier = clamp(scoringEnvironment / 114, 0.94, 1.06);
  const projectedMargin = (((home.neutralMargin - away.neutralMargin) / 2) + homeFieldPoints + restAdjustmentPoints) * paceMultiplier;
  const marginProbability = logistic(projectedMargin / NBA_FAIR_ODDS_CONFIG.margin_logistic_scale);
  const eloProbability = 1 / (1 + Math.pow(10, -((home.latestElo + homeFieldElo - away.latestElo) / NBA_FAIR_ODDS_CONFIG.elo_scale)));
  const rawProbability = (eloProbability * NBA_FAIR_ODDS_CONFIG.elo_weight)
    + (marginProbability * NBA_FAIR_ODDS_CONFIG.form_weight);
  const sampleCoverage = Math.min(homeForm.length, awayForm.length) / NBA_FAIR_ODDS_CONFIG.max_form_matches;
  const reliability = clamp(0.58 + sampleCoverage * 0.32, 0.58, 0.9);
  let homeProbability = 0.5 + (rawProbability - 0.5) * reliability;
  if (preseasonTarget) {
    homeProbability = 0.5 + (homeProbability - 0.5) * NBA_FAIR_ODDS_CONFIG.preseason_target_shrink;
  }
  homeProbability = clamp(homeProbability, NBA_FAIR_ODDS_CONFIG.min_probability, NBA_FAIR_ODDS_CONFIG.max_probability);
  const awayProbability = 1 - homeProbability;

  const selectedRows = [...homeForm, ...awayForm];
  const latestFeatureAt = selectedRows
    .map((row) => row.playedAtDate)
    .sort((left, right) => right.getTime() - left.getTime())[0];
  const latestAgeDays = Math.max(0, (asOf.getTime() - latestFeatureAt.getTime()) / DAY_MS);
  const recencyScore = clamp(1 - latestAgeDays / 150, 0, 1);
  const minimumSourceConfidence = Math.min(...selectedRows.map((row) => row.sourceConfidenceScore));
  const confidenceCeiling = preseasonTarget ? 0.62 : 0.8;
  const confidence = clamp(
    0.35 + sampleCoverage * 0.2 + (minimumSourceConfidence / 100) * 0.14 + recencyScore * 0.11
      - (preseasonTarget ? 0.09 : 0),
    0.3,
    confidenceCeiling
  );
  const evidenceSha256 = [...new Set(selectedRows.map((row) => row.evidenceSha256))].sort();
  const featureMatchIds = [...new Set(selectedRows.map((row) => row.matchId))].sort();
  const formSnapshot = (rows: ReturnType<typeof normalizedForm>) => rows.map((row) => ({
    match_id: row.matchId,
    played_at: row.playedAtDate.toISOString(),
    points_for: row.pointsFor,
    points_against: row.pointsAgainst,
    is_home: row.isHome,
    is_preseason: row.isPreseason,
    rest_days: row.restDays ?? null,
    team_elo_after: row.teamEloAfter ?? null,
    opponent_elo_before: row.opponentEloBefore ?? null,
    evidence_sha256: row.evidenceSha256
  }));
  const inputSnapshot = {
    home_team: input.homeTeam,
    away_team: input.awayTeam,
    as_of: asOf.toISOString(),
    kickoff: kickoff.toISOString(),
    target_competition_type: input.targetCompetitionType,
    home_form: formSnapshot(homeForm),
    away_form: formSnapshot(awayForm)
  };
  const inputSnapshotSha256 = sha256(inputSnapshot);
  const probabilities = { home: round(homeProbability), away: round(awayProbability) };
  const outputSha256 = sha256({
    probabilities,
    projected_margin: round(projectedMargin, 4),
    confidence: round(confidence, 4),
    input_snapshot_sha256: inputSnapshotSha256
  });

  return {
    probabilities,
    fair_odds: {
      home: round(1 / homeProbability, 4),
      away: round(1 / awayProbability, 4)
    },
    projected_margin: round(projectedMargin, 4),
    confidence: round(confidence, 4),
    uncertainty: round(1 - confidence, 4),
    training_cutoff_date: latestFeatureAt.toISOString().slice(0, 10),
    input_snapshot_sha256: inputSnapshotSha256,
    output_sha256: outputSha256,
    basis: {
      method: NBA_FAIR_ODDS_CONFIG.model_family,
      logic_version: NBA_FAIR_ODDS_LOGIC_VERSION,
      feature_schema_version: NBA_FAIR_ODDS_CONFIG.feature_schema_version,
      market_inputs_used: false,
      as_of: asOf.toISOString(),
      kickoff: kickoff.toISOString(),
      target_competition_type: input.targetCompetitionType,
      home_team: input.homeTeam,
      away_team: input.awayTeam,
      home_sample_size: homeForm.length,
      away_sample_size: awayForm.length,
      sample_coverage: round(sampleCoverage),
      home_neutral_margin: round(home.neutralMargin),
      away_neutral_margin: round(away.neutralMargin),
      home_scoring_environment: round(home.scoringEnvironment),
      away_scoring_environment: round(away.scoringEnvironment),
      home_latest_elo: round(home.latestElo, 3),
      away_latest_elo: round(away.latestElo, 3),
      home_rest_days: round(homeRestDays, 3),
      away_rest_days: round(awayRestDays, 3),
      rest_adjustment_points: round(restAdjustmentPoints, 4),
      projected_margin: round(projectedMargin, 4),
      elo_probability: round(eloProbability),
      margin_probability: round(marginProbability),
      minimum_source_confidence: minimumSourceConfidence,
      evidence_sha256: evidenceSha256,
      feature_match_ids: featureMatchIds,
      input_snapshot_sha256: inputSnapshotSha256,
      output_sha256: outputSha256
    }
  };
}
