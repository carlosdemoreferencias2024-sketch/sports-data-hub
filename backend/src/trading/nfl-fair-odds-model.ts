import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type NflResultObservation = {
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
  teamEloBefore?: number | null;
  teamEloAfter?: number | null;
  opponentEloBefore?: number | null;
};

export type NflFairOddsInput = {
  homeTeam: string;
  awayTeam: string;
  asOf: string;
  targetCompetitionType: "preseason" | "regular" | "postseason";
  homeForm: NflResultObservation[];
  awayForm: NflResultObservation[];
};

export const NFL_FAIR_ODDS_CONFIG = Object.freeze({
  model_family: "elo_margin_recency_logit_v1",
  feature_schema_version: "nfl_results_elo_margin_v1",
  fair_odds_method_version: "owned_fair_odds_nfl_v1",
  max_form_matches: 12,
  min_form_matches: 8,
  min_source_confidence: 90,
  half_life_days: 150,
  regular_home_field_points: 1.5,
  preseason_home_field_points: 0.5,
  regular_home_field_elo: 45,
  preseason_home_field_elo: 15,
  elo_scale: 400,
  margin_logistic_scale: 13.86,
  elo_weight: 0.58,
  form_weight: 0.42,
  preseason_result_weight: 0.35,
  preseason_target_shrink: 0.55,
  max_probability: 0.92,
  min_probability: 0.08
});

export const NFL_FAIR_ODDS_LOGIC_VERSION = "nfl-fair-odds-model.ts:v1.0.0";

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

export function nflFairOddsConfigSha256() {
  return sha256(NFL_FAIR_ODDS_CONFIG);
}

export function nflFairOddsArtifactSha256(provenance: {
  sourceCodeSha256?: string;
  gitCommit?: string;
} = {}) {
  const executedModuleSha256 = crypto.createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex");
  const sourceCodeSha256 = provenance.sourceCodeSha256
    || process.env.NFL_FAIR_ODDS_SOURCE_SHA256
    || executedModuleSha256;
  if (!SHA256_PATTERN.test(sourceCodeSha256)) throw new Error("nfl_fair_odds_source_sha256_invalid");
  return sha256({
    config: NFL_FAIR_ODDS_CONFIG,
    logic_version: NFL_FAIR_ODDS_LOGIC_VERSION,
    source_code_sha256: sourceCodeSha256,
    git_commit: provenance.gitCommit || process.env.GIT_COMMIT_SHA || null
  });
}

function normalizedForm(rows: NflResultObservation[], asOf: Date) {
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
    .filter((row) => row.sourceConfidenceScore >= NFL_FAIR_ODDS_CONFIG.min_source_confidence)
    .filter((row) => SHA256_PATTERN.test(row.evidenceSha256))
    .sort((left, right) => right.playedAtDate.getTime() - left.playedAtDate.getTime())
    .slice(0, NFL_FAIR_ODDS_CONFIG.max_form_matches);
}

function weightedTeamSignal(rows: ReturnType<typeof normalizedForm>, asOf: Date) {
  let marginTotal = 0;
  let weightTotal = 0;
  for (const row of rows) {
    const ageDays = Math.max(0, (asOf.getTime() - row.playedAtDate.getTime()) / DAY_MS);
    const recencyWeight = Math.pow(0.5, ageDays / NFL_FAIR_ODDS_CONFIG.half_life_days);
    const competitionWeight = row.isPreseason ? NFL_FAIR_ODDS_CONFIG.preseason_result_weight : 1;
    const venueAdjustment = row.isHome
      ? -NFL_FAIR_ODDS_CONFIG.regular_home_field_points
      : NFL_FAIR_ODDS_CONFIG.regular_home_field_points;
    const opponentAdjustment = Number.isFinite(row.opponentEloBefore)
      ? clamp((Number(row.opponentEloBefore) - 1500) / 25, -7, 7)
      : 0;
    const weight = recencyWeight * competitionWeight;
    marginTotal += ((row.pointsFor - row.pointsAgainst) + venueAdjustment + opponentAdjustment) * weight;
    weightTotal += weight;
  }
  const latestElo = rows.find((row) => Number.isFinite(row.teamEloAfter))?.teamEloAfter;
  return {
    neutralMargin: marginTotal / weightTotal,
    latestElo: Number.isFinite(latestElo) ? Number(latestElo) : 1500,
    weightTotal
  };
}

function logistic(value: number) {
  return 1 / (1 + Math.exp(-value));
}

function round(value: number, digits = 6) {
  return Number(value.toFixed(digits));
}

export function computeNflFairOdds(input: NflFairOddsInput) {
  const asOf = new Date(input.asOf);
  if (Number.isNaN(asOf.getTime())) throw new Error("nfl_fair_odds_as_of_invalid");
  const homeForm = normalizedForm(input.homeForm, asOf);
  const awayForm = normalizedForm(input.awayForm, asOf);
  if (homeForm.length < NFL_FAIR_ODDS_CONFIG.min_form_matches
      || awayForm.length < NFL_FAIR_ODDS_CONFIG.min_form_matches) {
    throw new Error("nfl_fair_odds_verified_history_insufficient");
  }

  const home = weightedTeamSignal(homeForm, asOf);
  const away = weightedTeamSignal(awayForm, asOf);
  const preseasonTarget = input.targetCompetitionType === "preseason";
  const homeFieldPoints = preseasonTarget
    ? NFL_FAIR_ODDS_CONFIG.preseason_home_field_points
    : NFL_FAIR_ODDS_CONFIG.regular_home_field_points;
  const homeFieldElo = preseasonTarget
    ? NFL_FAIR_ODDS_CONFIG.preseason_home_field_elo
    : NFL_FAIR_ODDS_CONFIG.regular_home_field_elo;
  const marginSignal = ((home.neutralMargin - away.neutralMargin) / 2) + homeFieldPoints;
  const marginProbability = logistic(marginSignal / NFL_FAIR_ODDS_CONFIG.margin_logistic_scale);
  const eloProbability = 1 / (1 + Math.pow(10, -((home.latestElo + homeFieldElo - away.latestElo) / NFL_FAIR_ODDS_CONFIG.elo_scale)));
  const rawProbability = (eloProbability * NFL_FAIR_ODDS_CONFIG.elo_weight)
    + (marginProbability * NFL_FAIR_ODDS_CONFIG.form_weight);
  const sampleCoverage = Math.min(homeForm.length, awayForm.length) / NFL_FAIR_ODDS_CONFIG.max_form_matches;
  const reliability = clamp(0.55 + sampleCoverage * 0.35, 0.55, 0.9);
  let homeProbability = 0.5 + (rawProbability - 0.5) * reliability;
  if (preseasonTarget) {
    homeProbability = 0.5 + (homeProbability - 0.5) * NFL_FAIR_ODDS_CONFIG.preseason_target_shrink;
  }
  homeProbability = clamp(homeProbability, NFL_FAIR_ODDS_CONFIG.min_probability, NFL_FAIR_ODDS_CONFIG.max_probability);
  const awayProbability = 1 - homeProbability;

  const selectedRows = [...homeForm, ...awayForm];
  const latestFeatureAt = selectedRows
    .map((row) => row.playedAtDate)
    .sort((left, right) => right.getTime() - left.getTime())[0];
  const latestAgeDays = Math.max(0, (asOf.getTime() - latestFeatureAt.getTime()) / DAY_MS);
  const recencyScore = clamp(1 - latestAgeDays / 240, 0, 1);
  const minimumSourceConfidence = Math.min(...selectedRows.map((row) => row.sourceConfidenceScore));
  const confidenceCeiling = preseasonTarget ? 0.62 : 0.78;
  const confidence = clamp(
    0.34 + sampleCoverage * 0.2 + (minimumSourceConfidence / 100) * 0.14 + recencyScore * 0.1
      - (preseasonTarget ? 0.08 : 0),
    0.3,
    confidenceCeiling
  );
  const evidenceSha256 = [...new Set(selectedRows.map((row) => row.evidenceSha256))].sort();
  const featureMatchIds = [...new Set(selectedRows.map((row) => row.matchId))].sort();
  const inputSnapshot = {
    home_team: input.homeTeam,
    away_team: input.awayTeam,
    as_of: asOf.toISOString(),
    target_competition_type: input.targetCompetitionType,
    home_form: homeForm.map((row) => ({
      match_id: row.matchId,
      played_at: row.playedAtDate.toISOString(),
      points_for: row.pointsFor,
      points_against: row.pointsAgainst,
      is_home: row.isHome,
      is_preseason: row.isPreseason,
      team_elo_after: row.teamEloAfter ?? null,
      opponent_elo_before: row.opponentEloBefore ?? null,
      evidence_sha256: row.evidenceSha256
    })),
    away_form: awayForm.map((row) => ({
      match_id: row.matchId,
      played_at: row.playedAtDate.toISOString(),
      points_for: row.pointsFor,
      points_against: row.pointsAgainst,
      is_home: row.isHome,
      is_preseason: row.isPreseason,
      team_elo_after: row.teamEloAfter ?? null,
      opponent_elo_before: row.opponentEloBefore ?? null,
      evidence_sha256: row.evidenceSha256
    }))
  };
  const inputSnapshotSha256 = sha256(inputSnapshot);
  const probabilities = { home: round(homeProbability), away: round(awayProbability) };
  const outputSha256 = sha256({ probabilities, confidence: round(confidence, 4), input_snapshot_sha256: inputSnapshotSha256 });

  return {
    probabilities,
    fair_odds: {
      home: round(1 / homeProbability, 4),
      away: round(1 / awayProbability, 4)
    },
    confidence: round(confidence, 4),
    uncertainty: round(1 - confidence, 4),
    training_cutoff_date: latestFeatureAt.toISOString().slice(0, 10),
    input_snapshot_sha256: inputSnapshotSha256,
    output_sha256: outputSha256,
    basis: {
      method: NFL_FAIR_ODDS_CONFIG.model_family,
      logic_version: NFL_FAIR_ODDS_LOGIC_VERSION,
      feature_schema_version: NFL_FAIR_ODDS_CONFIG.feature_schema_version,
      market_inputs_used: false,
      as_of: asOf.toISOString(),
      target_competition_type: input.targetCompetitionType,
      home_team: input.homeTeam,
      away_team: input.awayTeam,
      home_sample_size: homeForm.length,
      away_sample_size: awayForm.length,
      sample_coverage: round(sampleCoverage),
      home_neutral_margin: round(home.neutralMargin),
      away_neutral_margin: round(away.neutralMargin),
      home_latest_elo: round(home.latestElo, 3),
      away_latest_elo: round(away.latestElo, 3),
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
