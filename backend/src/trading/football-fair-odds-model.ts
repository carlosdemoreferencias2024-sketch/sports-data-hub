import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type FootballFormObservation = {
  matchId: string;
  playedAt: string;
  goalsFor: number;
  goalsAgainst: number;
  isHome?: boolean | null;
  source: string;
  sourceConfidenceScore: number;
  evidenceSha256?: string | null;
  capturedAt?: string | null;
  featureAsOf?: string | null;
  xgFor?: number | null;
  xgAgainst?: number | null;
  opponentElo?: number | null;
};

export type FootballFairOddsInput = {
  targetMatchId?: string;
  homeTeam: string;
  awayTeam: string;
  asOf: string;
  targetKickoffAt?: string;
  homeForm: FootballFormObservation[];
  awayForm: FootballFormObservation[];
};

export type FootballFeatureEvidence = {
  source: string;
  capturedAt: string;
  asOf: string;
  confidenceScore: number;
  evidenceSha256: string;
};

export type FootballContextFeatureKey =
  | "elo"
  | "rest"
  | "absences"
  | "goalkeepers"
  | "lineups"
  | "availability"
  | "competition"
  | "knockout";

export type FootballFairOddsContext = {
  featureProvenance?: Partial<Record<FootballContextFeatureKey, FootballFeatureEvidence>>;
  homeElo?: number | null;
  awayElo?: number | null;
  homeRestDays?: number | null;
  awayRestDays?: number | null;
  homeAbsenceImpact?: number | null;
  awayAbsenceImpact?: number | null;
  homeGoalkeeperConfirmed?: boolean;
  awayGoalkeeperConfirmed?: boolean;
  homeGoalkeeperStatus?: "confirmed_starting" | "confirmed_absent" | "unconfirmed" | "unknown";
  awayGoalkeeperStatus?: "confirmed_starting" | "confirmed_absent" | "unconfirmed" | "unknown";
  homeGoalkeeperImpact?: number | null;
  awayGoalkeeperImpact?: number | null;
  homeLineupCompleteness?: number | null;
  awayLineupCompleteness?: number | null;
  availabilityVerified?: boolean;
  competitionStrength?: number | null;
  knockout?: {
    leg?: number | null;
    homeAggregateGoals?: number | null;
    awayAggregateGoals?: number | null;
    awayGoalsRule?: boolean;
  } | null;
};

export type FootballFairOddsV3Input = FootballFairOddsInput & {
  context?: FootballFairOddsContext;
};

export const FOOTBALL_FAIR_ODDS_MODEL_CONFIG = Object.freeze({
  model_family: "recency_weighted_goals_poisson_v1",
  feature_schema_version: "football_form_goals_v1",
  fair_odds_method_version: "owned_fair_odds_v1",
  max_form_matches: 8,
  min_form_matches: 3,
  min_source_confidence: 80,
  half_life_days: 120,
  max_form_weight: 0.65,
  baseline_home_goals: 1.45,
  baseline_away_goals: 1.15,
  poisson_max_goals: 10
});

export const FOOTBALL_FAIR_ODDS_V3_CONFIG = Object.freeze({
  model_family: "contextual_recency_xg_poisson_v3",
  feature_schema_version: "football_context_xg_elo_v3",
  fair_odds_method_version: "owned_fair_odds_v3",
  max_form_matches: 8,
  min_form_matches: 3,
  min_source_confidence: 80,
  half_life_days: 90,
  max_form_weight: 0.72,
  venue_match_weight: 1.15,
  venue_mismatch_weight: 0.85,
  opponent_elo_reference: 1500,
  opponent_elo_divisor: 1600,
  max_opponent_adjustment: 1.15,
  goals_weight_without_xg: 1,
  goals_weight_with_xg: 0.55,
  xg_weight: 0.45,
  baseline_home_goals: 1.45,
  baseline_away_goals: 1.15,
  max_elo_multiplier: 1.18,
  max_rest_multiplier: 1.08,
  max_absence_penalty: 0.22,
  max_knockout_attack_boost: 0.24,
  poisson_max_goals: 10
});

export const FOOTBALL_FAIR_ODDS_V3_LOGIC_VERSION = "football-fair-odds-model.ts:v3.1.0";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function stableConfigJson() {
  return JSON.stringify(FOOTBALL_FAIR_ODDS_MODEL_CONFIG, Object.keys(FOOTBALL_FAIR_ODDS_MODEL_CONFIG).sort());
}

export function footballFairOddsArtifactSha256() {
  return crypto.createHash("sha256").update(stableConfigJson()).digest("hex");
}

export function footballFairOddsV3ArtifactSha256(provenance: {
  sourceCodeSha256?: string;
  gitCommit?: string;
} = {}) {
  const executedModuleSha256 = crypto.createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
  const sourceCodeSha256 = provenance.sourceCodeSha256 || process.env.FOOTBALL_FAIR_ODDS_V3_SOURCE_SHA256 || executedModuleSha256;
  const gitCommit = provenance.gitCommit || process.env.GIT_COMMIT_SHA || "";
  if (sourceCodeSha256 && !/^[a-f0-9]{64}$/i.test(sourceCodeSha256)) {
    throw new Error("football_fair_odds_v3_source_sha256_invalid");
  }
  const stable = JSON.stringify({
    config: FOOTBALL_FAIR_ODDS_V3_CONFIG,
    logic_version: FOOTBALL_FAIR_ODDS_V3_LOGIC_VERSION,
    source_code_sha256: sourceCodeSha256 || null,
    git_commit: gitCommit || null
  });
  return crypto.createHash("sha256").update(stable).digest("hex");
}

function poissonProbability(goals: number, lambda: number) {
  let factorial = 1;
  for (let index = 2; index <= goals; index += 1) factorial *= index;
  return Math.exp(-lambda) * Math.pow(lambda, goals) / factorial;
}

function probabilitiesFromLambdas(homeLambda: number, awayLambda: number, maxGoals: number) {
  let homeProbability = 0;
  let drawProbability = 0;
  let awayProbability = 0;
  for (let homeGoals = 0; homeGoals <= maxGoals; homeGoals += 1) {
    const homeGoalProbability = poissonProbability(homeGoals, homeLambda);
    for (let awayGoals = 0; awayGoals <= maxGoals; awayGoals += 1) {
      const probability = homeGoalProbability * poissonProbability(awayGoals, awayLambda);
      if (homeGoals > awayGoals) homeProbability += probability;
      else if (homeGoals === awayGoals) drawProbability += probability;
      else awayProbability += probability;
    }
  }
  const total = homeProbability + drawProbability + awayProbability;
  return {
    home: homeProbability / total,
    draw: drawProbability / total,
    away: awayProbability / total
  };
}

function normalizedForm(rows: FootballFormObservation[], asOf: Date) {
  return rows
    .map((row) => ({ ...row, playedAtDate: new Date(row.playedAt) }))
    .filter((row) => !Number.isNaN(row.playedAtDate.getTime()))
    .filter((row) => row.playedAtDate.getTime() < asOf.getTime())
    .filter((row) => Number.isFinite(row.goalsFor) && Number.isFinite(row.goalsAgainst))
    .filter((row) => row.goalsFor >= 0 && row.goalsAgainst >= 0)
    .filter((row) => row.sourceConfidenceScore >= FOOTBALL_FAIR_ODDS_MODEL_CONFIG.min_source_confidence)
    .sort((left, right) => right.playedAtDate.getTime() - left.playedAtDate.getTime())
    .slice(0, FOOTBALL_FAIR_ODDS_MODEL_CONFIG.max_form_matches);
}

function weightedMeans(rows: ReturnType<typeof normalizedForm>, asOf: Date) {
  let weightTotal = 0;
  let goalsForTotal = 0;
  let goalsAgainstTotal = 0;
  for (const row of rows) {
    const ageDays = Math.max(0, (asOf.getTime() - row.playedAtDate.getTime()) / 86_400_000);
    const weight = Math.pow(0.5, ageDays / FOOTBALL_FAIR_ODDS_MODEL_CONFIG.half_life_days);
    weightTotal += weight;
    goalsForTotal += row.goalsFor * weight;
    goalsAgainstTotal += row.goalsAgainst * weight;
  }
  return {
    goalsFor: goalsForTotal / weightTotal,
    goalsAgainst: goalsAgainstTotal / weightTotal,
    weightTotal
  };
}

export function computeFootballFairOdds(input: FootballFairOddsInput) {
  const asOf = new Date(input.asOf);
  if (Number.isNaN(asOf.getTime())) throw new Error("football_fair_odds_as_of_invalid");

  const homeForm = normalizedForm(input.homeForm, asOf);
  const awayForm = normalizedForm(input.awayForm, asOf);
  if (homeForm.length < FOOTBALL_FAIR_ODDS_MODEL_CONFIG.min_form_matches
      || awayForm.length < FOOTBALL_FAIR_ODDS_MODEL_CONFIG.min_form_matches) {
    throw new Error("football_fair_odds_verified_form_insufficient");
  }

  const homeMeans = weightedMeans(homeForm, asOf);
  const awayMeans = weightedMeans(awayForm, asOf);
  const sampleReliability = clamp(
    (Math.min(homeForm.length, awayForm.length) / FOOTBALL_FAIR_ODDS_MODEL_CONFIG.max_form_matches)
      * FOOTBALL_FAIR_ODDS_MODEL_CONFIG.max_form_weight,
    0,
    FOOTBALL_FAIR_ODDS_MODEL_CONFIG.max_form_weight
  );
  const observedHomeGoals = (homeMeans.goalsFor + awayMeans.goalsAgainst) / 2;
  const observedAwayGoals = (awayMeans.goalsFor + homeMeans.goalsAgainst) / 2;
  const homeLambda = clamp(
    FOOTBALL_FAIR_ODDS_MODEL_CONFIG.baseline_home_goals
      + sampleReliability * (observedHomeGoals - FOOTBALL_FAIR_ODDS_MODEL_CONFIG.baseline_home_goals),
    0.35,
    3.5
  );
  const awayLambda = clamp(
    FOOTBALL_FAIR_ODDS_MODEL_CONFIG.baseline_away_goals
      + sampleReliability * (observedAwayGoals - FOOTBALL_FAIR_ODDS_MODEL_CONFIG.baseline_away_goals),
    0.25,
    3.25
  );

  const probabilities = probabilitiesFromLambdas(homeLambda, awayLambda, FOOTBALL_FAIR_ODDS_MODEL_CONFIG.poisson_max_goals);

  const latestFeatureAt = [...homeForm, ...awayForm]
    .map((row) => row.playedAtDate)
    .sort((left, right) => right.getTime() - left.getTime())[0];
  const minimumSourceConfidence = Math.min(...[...homeForm, ...awayForm].map((row) => row.sourceConfidenceScore));
  const confidence = clamp(0.25 + sampleReliability * 0.45 + (minimumSourceConfidence / 100) * 0.2, 0.25, 0.78);
  const evidenceSha256 = [...new Set([...homeForm, ...awayForm]
    .map((row) => row.evidenceSha256)
    .filter((value): value is string => Boolean(value)))];

  return {
    probabilities: {
      home: Number(probabilities.home.toFixed(6)),
      draw: Number(probabilities.draw.toFixed(6)),
      away: Number(probabilities.away.toFixed(6))
    },
    expected_goals: {
      home: Number(homeLambda.toFixed(6)),
      away: Number(awayLambda.toFixed(6))
    },
    confidence: Number(confidence.toFixed(4)),
    training_cutoff_date: latestFeatureAt.toISOString().slice(0, 10),
    basis: {
      method: FOOTBALL_FAIR_ODDS_MODEL_CONFIG.model_family,
      feature_schema_version: FOOTBALL_FAIR_ODDS_MODEL_CONFIG.feature_schema_version,
      market_inputs_used: false,
      home_team: input.homeTeam,
      away_team: input.awayTeam,
      target_match_id: input.targetMatchId ?? null,
      target_kickoff_at: input.targetKickoffAt ?? null,
      as_of: asOf.toISOString(),
      home_sample_size: homeForm.length,
      away_sample_size: awayForm.length,
      sample_reliability: Number(sampleReliability.toFixed(6)),
      home_weighted_goals_for: Number(homeMeans.goalsFor.toFixed(6)),
      home_weighted_goals_against: Number(homeMeans.goalsAgainst.toFixed(6)),
      away_weighted_goals_for: Number(awayMeans.goalsFor.toFixed(6)),
      away_weighted_goals_against: Number(awayMeans.goalsAgainst.toFixed(6)),
      minimum_source_confidence: minimumSourceConfidence,
      evidence_sha256: evidenceSha256,
      data_sources: [...new Set([...homeForm, ...awayForm].map((row) => row.source))],
      home_feature_match_ids: [...new Set(homeForm.map((row) => row.matchId))],
      away_feature_match_ids: [...new Set(awayForm.map((row) => row.matchId))],
      feature_match_ids: [...new Set([...homeForm, ...awayForm].map((row) => row.matchId))]
    }
  };
}

function weightedOptionalMean(
  rows: ReturnType<typeof normalizedForm>,
  asOf: Date,
  key: "xgFor" | "xgAgainst"
) {
  let weightedTotal = 0;
  let weightTotal = 0;
  for (const row of rows) {
    const value = row[key];
    if (value === null || value === undefined || !Number.isFinite(value) || value < 0) continue;
    const ageDays = Math.max(0, (asOf.getTime() - row.playedAtDate.getTime()) / 86_400_000);
    const weight = Math.pow(0.5, ageDays / FOOTBALL_FAIR_ODDS_V3_CONFIG.half_life_days);
    weightedTotal += value * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? weightedTotal / weightTotal : null;
}

function normalizedFormV3(rows: FootballFormObservation[], asOf: Date) {
  return rows
    .map((row) => ({
      ...row,
      playedAtDate: new Date(row.playedAt),
      capturedAtDate: new Date(String(row.capturedAt || "")),
      featureAsOfDate: new Date(String(row.featureAsOf || row.playedAt))
    }))
    .filter((row) => !Number.isNaN(row.playedAtDate.getTime()))
    .filter((row) => !Number.isNaN(row.capturedAtDate.getTime()) && row.capturedAtDate.getTime() <= asOf.getTime())
    .filter((row) => !Number.isNaN(row.featureAsOfDate.getTime()) && row.featureAsOfDate.getTime() <= asOf.getTime())
    .filter((row) => /^[a-f0-9]{64}$/i.test(String(row.evidenceSha256 || "")))
    .filter((row) => row.playedAtDate.getTime() < asOf.getTime())
    .filter((row) => Number.isFinite(row.goalsFor) && Number.isFinite(row.goalsAgainst))
    .filter((row) => row.goalsFor >= 0 && row.goalsAgainst >= 0)
    .filter((row) => row.sourceConfidenceScore >= FOOTBALL_FAIR_ODDS_V3_CONFIG.min_source_confidence)
    .sort((left, right) => right.playedAtDate.getTime() - left.playedAtDate.getTime())
    .slice(0, FOOTBALL_FAIR_ODDS_V3_CONFIG.max_form_matches);
}

function opponentAdjustment(opponentElo: number | null | undefined, forAttack: boolean) {
  if (!Number.isFinite(opponentElo)) return 1;
  const delta = Number(opponentElo) - FOOTBALL_FAIR_ODDS_V3_CONFIG.opponent_elo_reference;
  const raw = Math.exp((forAttack ? delta : -delta) / FOOTBALL_FAIR_ODDS_V3_CONFIG.opponent_elo_divisor);
  return clamp(
    raw,
    1 / FOOTBALL_FAIR_ODDS_V3_CONFIG.max_opponent_adjustment,
    FOOTBALL_FAIR_ODDS_V3_CONFIG.max_opponent_adjustment
  );
}

function weightedV3Stats(
  rows: ReturnType<typeof normalizedFormV3>,
  asOf: Date,
  targetIsHome: boolean
) {
  let weightTotal = 0;
  let goalsForTotal = 0;
  let goalsAgainstTotal = 0;
  let xgForTotal = 0;
  let xgForWeight = 0;
  let xgAgainstTotal = 0;
  let xgAgainstWeight = 0;
  let opponentEloRows = 0;
  for (const row of rows) {
    const ageDays = Math.max(0, (asOf.getTime() - row.playedAtDate.getTime()) / 86_400_000);
    const recencyWeight = Math.pow(0.5, ageDays / FOOTBALL_FAIR_ODDS_V3_CONFIG.half_life_days);
    const venueWeight = row.isHome === null || row.isHome === undefined
      ? 1
      : row.isHome === targetIsHome
        ? FOOTBALL_FAIR_ODDS_V3_CONFIG.venue_match_weight
        : FOOTBALL_FAIR_ODDS_V3_CONFIG.venue_mismatch_weight;
    const weight = recencyWeight * venueWeight;
    const attackAdjustment = opponentAdjustment(row.opponentElo, true);
    const defenseAdjustment = opponentAdjustment(row.opponentElo, false);
    if (Number.isFinite(row.opponentElo)) opponentEloRows += 1;
    weightTotal += weight;
    goalsForTotal += row.goalsFor * attackAdjustment * weight;
    goalsAgainstTotal += row.goalsAgainst * defenseAdjustment * weight;
    if (Number.isFinite(row.xgFor) && Number(row.xgFor) >= 0) {
      xgForTotal += Number(row.xgFor) * attackAdjustment * weight;
      xgForWeight += weight;
    }
    if (Number.isFinite(row.xgAgainst) && Number(row.xgAgainst) >= 0) {
      xgAgainstTotal += Number(row.xgAgainst) * defenseAdjustment * weight;
      xgAgainstWeight += weight;
    }
  }
  return {
    goalsFor: goalsForTotal / weightTotal,
    goalsAgainst: goalsAgainstTotal / weightTotal,
    xgFor: xgForWeight > 0 ? xgForTotal / xgForWeight : null,
    xgAgainst: xgAgainstWeight > 0 ? xgAgainstTotal / xgAgainstWeight : null,
    xgForCoverage: weightTotal > 0 ? xgForWeight / weightTotal : 0,
    xgAgainstCoverage: weightTotal > 0 ? xgAgainstWeight / weightTotal : 0,
    opponentEloCoverage: rows.length > 0 ? opponentEloRows / rows.length : 0,
    weightTotal
  };
}

function averageAvailable(values: Array<number | null>) {
  const available = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null;
}

function goalkeeperStatus(
  explicit: FootballFairOddsContext["homeGoalkeeperStatus"],
  legacyConfirmed: boolean | undefined
) {
  if (explicit) return explicit;
  if (legacyConfirmed === true) return "confirmed_starting" as const;
  if (legacyConfirmed === false) return "unconfirmed" as const;
  return "unknown" as const;
}

function validFeatureEvidence(context: FootballFairOddsContext, key: FootballContextFeatureKey, asOf: Date) {
  const evidence = context.featureProvenance?.[key];
  if (!evidence || !evidence.source || !/^[a-f0-9]{64}$/i.test(evidence.evidenceSha256)) return false;
  if (!Number.isFinite(evidence.confidenceScore) || evidence.confidenceScore < FOOTBALL_FAIR_ODDS_V3_CONFIG.min_source_confidence) return false;
  const capturedAt = new Date(evidence.capturedAt);
  const featureAsOf = new Date(evidence.asOf);
  if (Number.isNaN(capturedAt.getTime()) || Number.isNaN(featureAsOf.getTime())) return false;
  return capturedAt.getTime() <= asOf.getTime() && featureAsOf.getTime() <= asOf.getTime();
}

export function computeFootballFairOddsV3(input: FootballFairOddsV3Input) {
  const asOf = new Date(input.asOf);
  if (Number.isNaN(asOf.getTime())) throw new Error("football_fair_odds_as_of_invalid");
  const homeForm = normalizedFormV3(input.homeForm, asOf);
  const awayForm = normalizedFormV3(input.awayForm, asOf);
  if (homeForm.length < FOOTBALL_FAIR_ODDS_V3_CONFIG.min_form_matches
      || awayForm.length < FOOTBALL_FAIR_ODDS_V3_CONFIG.min_form_matches) {
    throw new Error("football_fair_odds_verified_form_insufficient");
  }

  const base = computeFootballFairOdds({ ...input, homeForm, awayForm });
  const context = input.context ?? {};
  const contextEvidence = {
    elo: validFeatureEvidence(context, "elo", asOf),
    rest: validFeatureEvidence(context, "rest", asOf),
    absences: validFeatureEvidence(context, "absences", asOf),
    goalkeepers: validFeatureEvidence(context, "goalkeepers", asOf),
    lineups: validFeatureEvidence(context, "lineups", asOf),
    availability: validFeatureEvidence(context, "availability", asOf),
    competition: validFeatureEvidence(context, "competition", asOf),
    knockout: validFeatureEvidence(context, "knockout", asOf)
  };
  const homeMeans = weightedV3Stats(homeForm, asOf, true);
  const awayMeans = weightedV3Stats(awayForm, asOf, false);
  const homeXgFor = homeMeans.xgFor;
  const homeXgAgainst = homeMeans.xgAgainst;
  const awayXgFor = awayMeans.xgFor;
  const awayXgAgainst = awayMeans.xgAgainst;
  const xgCoverage = clamp((
    homeMeans.xgForCoverage
    + homeMeans.xgAgainstCoverage
    + awayMeans.xgForCoverage
    + awayMeans.xgAgainstCoverage
  ) / 4, 0, 1);
  const xgReady = xgCoverage >= 0.999;

  const observedHomeGoals = (homeMeans.goalsFor + awayMeans.goalsAgainst) / 2;
  const observedAwayGoals = (awayMeans.goalsFor + homeMeans.goalsAgainst) / 2;
  const observedHomeXg = averageAvailable([homeXgFor, awayXgAgainst]);
  const observedAwayXg = averageAvailable([awayXgFor, homeXgAgainst]);
  const xgWeight = FOOTBALL_FAIR_ODDS_V3_CONFIG.xg_weight * xgCoverage;
  const goalsWeight = 1 - xgWeight;
  const blendedHome = goalsWeight * observedHomeGoals + xgWeight * (observedHomeXg ?? observedHomeGoals);
  const blendedAway = goalsWeight * observedAwayGoals + xgWeight * (observedAwayXg ?? observedAwayGoals);
  const sampleReliability = clamp(
    (Math.min(homeForm.length, awayForm.length) / FOOTBALL_FAIR_ODDS_V3_CONFIG.max_form_matches)
      * FOOTBALL_FAIR_ODDS_V3_CONFIG.max_form_weight,
    0,
    FOOTBALL_FAIR_ODDS_V3_CONFIG.max_form_weight
  );
  let homeLambda = FOOTBALL_FAIR_ODDS_V3_CONFIG.baseline_home_goals
    + sampleReliability * (blendedHome - FOOTBALL_FAIR_ODDS_V3_CONFIG.baseline_home_goals);
  let awayLambda = FOOTBALL_FAIR_ODDS_V3_CONFIG.baseline_away_goals
    + sampleReliability * (blendedAway - FOOTBALL_FAIR_ODDS_V3_CONFIG.baseline_away_goals);

  const adjustments: Record<string, number> = {};
  if (contextEvidence.elo && Number.isFinite(context.homeElo) && Number.isFinite(context.awayElo)) {
    const eloDelta = Number(context.homeElo) - Number(context.awayElo);
    const homeEloMultiplier = clamp(Math.exp(eloDelta / 1600), 1 / FOOTBALL_FAIR_ODDS_V3_CONFIG.max_elo_multiplier, FOOTBALL_FAIR_ODDS_V3_CONFIG.max_elo_multiplier);
    const awayEloMultiplier = clamp(1 / homeEloMultiplier, 1 / FOOTBALL_FAIR_ODDS_V3_CONFIG.max_elo_multiplier, FOOTBALL_FAIR_ODDS_V3_CONFIG.max_elo_multiplier);
    homeLambda *= homeEloMultiplier;
    awayLambda *= awayEloMultiplier;
    adjustments.home_elo_multiplier = homeEloMultiplier;
    adjustments.away_elo_multiplier = awayEloMultiplier;
  }

  if (contextEvidence.rest && Number.isFinite(context.homeRestDays) && Number.isFinite(context.awayRestDays)) {
    const restDelta = clamp(Number(context.homeRestDays) - Number(context.awayRestDays), -4, 4);
    const homeRestMultiplier = clamp(1 + restDelta * 0.02, 1 / FOOTBALL_FAIR_ODDS_V3_CONFIG.max_rest_multiplier, FOOTBALL_FAIR_ODDS_V3_CONFIG.max_rest_multiplier);
    homeLambda *= homeRestMultiplier;
    awayLambda *= 2 - homeRestMultiplier;
    adjustments.home_rest_multiplier = homeRestMultiplier;
  }

  const homeAbsencePenalty = contextEvidence.absences
    ? clamp(Number(context.homeAbsenceImpact ?? 0), 0, 1) * FOOTBALL_FAIR_ODDS_V3_CONFIG.max_absence_penalty
    : 0;
  const awayAbsencePenalty = contextEvidence.absences
    ? clamp(Number(context.awayAbsenceImpact ?? 0), 0, 1) * FOOTBALL_FAIR_ODDS_V3_CONFIG.max_absence_penalty
    : 0;
  homeLambda *= 1 - homeAbsencePenalty;
  awayLambda *= 1 - awayAbsencePenalty;
  adjustments.home_absence_multiplier = 1 - homeAbsencePenalty;
  adjustments.away_absence_multiplier = 1 - awayAbsencePenalty;

  const homeGoalkeeperStatus = goalkeeperStatus(context.homeGoalkeeperStatus, context.homeGoalkeeperConfirmed);
  const awayGoalkeeperStatus = goalkeeperStatus(context.awayGoalkeeperStatus, context.awayGoalkeeperConfirmed);
  if (contextEvidence.goalkeepers && homeGoalkeeperStatus === "confirmed_absent") {
    const multiplier = 1 + clamp(Number(context.homeGoalkeeperImpact ?? 0.06), 0, 0.15);
    awayLambda *= multiplier;
    adjustments.home_goalkeeper_absence_multiplier = multiplier;
  }
  if (contextEvidence.goalkeepers && awayGoalkeeperStatus === "confirmed_absent") {
    const multiplier = 1 + clamp(Number(context.awayGoalkeeperImpact ?? 0.06), 0, 0.15);
    homeLambda *= multiplier;
    adjustments.away_goalkeeper_absence_multiplier = multiplier;
  }

  const knockout = context.knockout;
  if (contextEvidence.knockout && knockout?.leg === 2 && Number.isFinite(knockout.homeAggregateGoals) && Number.isFinite(knockout.awayAggregateGoals)) {
    const deficit = Number(knockout.homeAggregateGoals) - Number(knockout.awayAggregateGoals);
    if (deficit < 0) {
      const boost = clamp(Math.abs(deficit) * 0.08, 0, FOOTBALL_FAIR_ODDS_V3_CONFIG.max_knockout_attack_boost);
      homeLambda *= 1 + boost;
      awayLambda *= 1 + boost * 0.35;
      adjustments.home_knockout_attack_multiplier = 1 + boost;
      adjustments.away_counterattack_multiplier = 1 + boost * 0.35;
    } else if (deficit > 0) {
      const boost = clamp(deficit * 0.08, 0, FOOTBALL_FAIR_ODDS_V3_CONFIG.max_knockout_attack_boost);
      awayLambda *= 1 + boost;
      homeLambda *= 1 + boost * 0.35;
      adjustments.away_knockout_attack_multiplier = 1 + boost;
      adjustments.home_counterattack_multiplier = 1 + boost * 0.35;
    }
  }

  const competitionStrength = contextEvidence.competition
    ? clamp(Number(context.competitionStrength ?? 1), 0.82, 1.18)
    : 1;
  homeLambda *= competitionStrength;
  awayLambda *= competitionStrength;
  adjustments.competition_strength_multiplier = competitionStrength;

  const missingFeatures: string[] = [];
  if (xgCoverage === 0) missingFeatures.push("xg_missing");
  else if (!xgReady) missingFeatures.push("xg_partial");
  if (!contextEvidence.elo || !Number.isFinite(context.homeElo) || !Number.isFinite(context.awayElo)) missingFeatures.push("elo");
  if (!contextEvidence.rest || !Number.isFinite(context.homeRestDays) || !Number.isFinite(context.awayRestDays)) missingFeatures.push("rest_congestion");
  if (!contextEvidence.lineups || Number(context.homeLineupCompleteness ?? 0) < 1 || Number(context.awayLineupCompleteness ?? 0) < 1) missingFeatures.push("official_lineups");
  if (!contextEvidence.goalkeepers || homeGoalkeeperStatus !== "confirmed_starting" || awayGoalkeeperStatus !== "confirmed_starting") missingFeatures.push("goalkeepers");
  if (!contextEvidence.availability || !context.availabilityVerified) missingFeatures.push("availability");
  if (!contextEvidence.absences) missingFeatures.push("absences");
  const sampleUncertainty = (1 - sampleReliability) * 0.22;
  const xgUncertainty = (1 - xgCoverage) * 0.12;
  const uncertainty = clamp(0.06 + sampleUncertainty + xgUncertainty + missingFeatures.length * 0.055, 0.08, 0.72);
  const shrink = 1 - uncertainty * 0.35;
  homeLambda = FOOTBALL_FAIR_ODDS_V3_CONFIG.baseline_home_goals + shrink * (homeLambda - FOOTBALL_FAIR_ODDS_V3_CONFIG.baseline_home_goals);
  awayLambda = FOOTBALL_FAIR_ODDS_V3_CONFIG.baseline_away_goals + shrink * (awayLambda - FOOTBALL_FAIR_ODDS_V3_CONFIG.baseline_away_goals);
  homeLambda = clamp(homeLambda, 0.3, 3.8);
  awayLambda = clamp(awayLambda, 0.25, 3.6);
  const probabilities = probabilitiesFromLambdas(homeLambda, awayLambda, FOOTBALL_FAIR_ODDS_V3_CONFIG.poisson_max_goals);
  const confidence = clamp(base.confidence * (1 - uncertainty * 0.55), 0.15, 0.82);

  return {
    probabilities: {
      home: Number(probabilities.home.toFixed(6)),
      draw: Number(probabilities.draw.toFixed(6)),
      away: Number(probabilities.away.toFixed(6))
    },
    expected_goals: {
      home: Number(homeLambda.toFixed(6)),
      away: Number(awayLambda.toFixed(6))
    },
    confidence: Number(confidence.toFixed(4)),
    uncertainty: Number(uncertainty.toFixed(4)),
    training_cutoff_date: base.training_cutoff_date,
    basis: {
      ...base.basis,
      method: FOOTBALL_FAIR_ODDS_V3_CONFIG.model_family,
      feature_schema_version: FOOTBALL_FAIR_ODDS_V3_CONFIG.feature_schema_version,
      fair_odds_method_version: FOOTBALL_FAIR_ODDS_V3_CONFIG.fair_odds_method_version,
      market_inputs_used: false,
      xg_ready: xgReady,
      xg_coverage: Number(xgCoverage.toFixed(6)),
      xg_weight: Number(xgWeight.toFixed(6)),
      sample_reliability: Number(sampleReliability.toFixed(6)),
      opponent_elo_coverage: Number(((homeMeans.opponentEloCoverage + awayMeans.opponentEloCoverage) / 2).toFixed(6)),
      context_evidence_valid: contextEvidence,
      weighted_xg: {
        home_for: homeXgFor,
        home_against: homeXgAgainst,
        away_for: awayXgFor,
        away_against: awayXgAgainst
      },
      context: {
        ...context,
        homeGoalkeeperStatus,
        awayGoalkeeperStatus
      },
      adjustments,
      missing_features: missingFeatures,
      uncertainty: Number(uncertainty.toFixed(4))
    }
  };
}
