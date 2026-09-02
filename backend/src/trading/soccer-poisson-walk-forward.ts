export type SoccerBacktestQueryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

export type SoccerWalkForwardOptions = {
  from: string;
  to: string;
  league?: string | null;
  limit?: number;
  minTrainingMatches?: number;
  priorMatches?: number;
};

type Outcome = "home" | "draw" | "away";

type HistoricalMatch = {
  matchId: string;
  league: string;
  kickoff: string;
  homeTeamId: string;
  awayTeamId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  resultAvailableAt: string;
  duplicateCount: number;
  resultVariants: number;
};

type Prediction = {
  match_id: string;
  league: string;
  kickoff: string;
  home_team: string;
  away_team: string;
  actual: Outcome;
  predicted: Outcome;
  probabilities: { home: number; draw: number; away: number };
  baseline_probabilities: { home: number; draw: number; away: number };
  expected_goals: { home: number; away: number };
  training_matches: number;
  training_max_kickoff: string;
  training_max_result_available_at: string;
};

type TeamTotals = { games: number; for: number; against: number };

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const rounded = (value: number) => Number(value.toFixed(6));

function actualOutcome(row: HistoricalMatch): Outcome {
  if (row.homeScore > row.awayScore) return "home";
  if (row.homeScore < row.awayScore) return "away";
  return "draw";
}

function predictedOutcome(probabilities: { home: number; draw: number; away: number }): Outcome {
  return (Object.entries(probabilities) as Array<[Outcome, number]>)
    .sort((left, right) => right[1] - left[1])[0][0];
}

function poissonMass(lambda: number, maxGoals: number) {
  const values = [Math.exp(-lambda)];
  for (let goals = 1; goals <= maxGoals; goals += 1) {
    values.push(values[goals - 1] * lambda / goals);
  }
  return values;
}

function fitAndPredict(
  training: HistoricalMatch[],
  target: HistoricalMatch,
  priorMatches: number
) {
  const totalHomeGoals = training.reduce((sum, row) => sum + row.homeScore, 0);
  const totalAwayGoals = training.reduce((sum, row) => sum + row.awayScore, 0);
  const averageHome = totalHomeGoals / training.length;
  const averageAway = totalAwayGoals / training.length;
  const averagePerTeam = Math.max((totalHomeGoals + totalAwayGoals) / (training.length * 2), 0.05);
  const teams = new Map<string, TeamTotals>();

  const add = (teamId: string, goalsFor: number, goalsAgainst: number) => {
    const totals = teams.get(teamId) ?? { games: 0, for: 0, against: 0 };
    totals.games += 1;
    totals.for += goalsFor;
    totals.against += goalsAgainst;
    teams.set(teamId, totals);
  };
  for (const row of training) {
    add(row.homeTeamId, row.homeScore, row.awayScore);
    add(row.awayTeamId, row.awayScore, row.homeScore);
  }

  const strength = (teamId: string) => {
    const totals = teams.get(teamId) ?? { games: 0, for: 0, against: 0 };
    const denominator = totals.games + priorMatches;
    return {
      attack: ((totals.for + priorMatches * averagePerTeam) / denominator) / averagePerTeam,
      defense: ((totals.against + priorMatches * averagePerTeam) / denominator) / averagePerTeam
    };
  };
  const home = strength(target.homeTeamId);
  const away = strength(target.awayTeamId);
  const lambdaHome = clamp(Math.max(averageHome, 0.05) * home.attack * away.defense, 0.05, 6);
  const lambdaAway = clamp(Math.max(averageAway, 0.05) * away.attack * home.defense, 0.05, 6);
  const homeMass = poissonMass(lambdaHome, 10);
  const awayMass = poissonMass(lambdaAway, 10);
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  for (let homeGoals = 0; homeGoals < homeMass.length; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals < awayMass.length; awayGoals += 1) {
      const probability = homeMass[homeGoals] * awayMass[awayGoals];
      if (homeGoals > awayGoals) homeWin += probability;
      else if (homeGoals < awayGoals) awayWin += probability;
      else draw += probability;
    }
  }
  const representedMass = homeWin + draw + awayWin;
  return {
    probabilities: {
      home: homeWin / representedMass,
      draw: draw / representedMass,
      away: awayWin / representedMass
    },
    expectedGoals: { home: lambdaHome, away: lambdaAway }
  };
}

function empiricalBaseline(training: HistoricalMatch[]) {
  const counts = { home: 1, draw: 1, away: 1 };
  for (const row of training) counts[actualOutcome(row)] += 1;
  const total = counts.home + counts.draw + counts.away;
  return { home: counts.home / total, draw: counts.draw / total, away: counts.away / total };
}

function metricSummary(predictions: Prediction[], key: "probabilities" | "baseline_probabilities") {
  if (!predictions.length) {
    return { sample_size: 0, accuracy: null, brier_score: null, log_loss: null, accuracy_ci_95: null };
  }
  let correct = 0;
  let brier = 0;
  let logLoss = 0;
  for (const prediction of predictions) {
    const probabilities = prediction[key];
    const predicted = predictedOutcome(probabilities);
    if (predicted === prediction.actual) correct += 1;
    for (const outcome of ["home", "draw", "away"] as const) {
      brier += Math.pow(probabilities[outcome] - (prediction.actual === outcome ? 1 : 0), 2);
    }
    logLoss += -Math.log(clamp(probabilities[prediction.actual], 1e-12, 1));
  }
  const n = predictions.length;
  const accuracy = correct / n;
  const z = 1.96;
  const denominator = 1 + z * z / n;
  const center = (accuracy + z * z / (2 * n)) / denominator;
  const radius = z * Math.sqrt((accuracy * (1 - accuracy) + z * z / (4 * n)) / n) / denominator;
  return {
    sample_size: n,
    accuracy: rounded(accuracy),
    brier_score: rounded(brier / n),
    log_loss: rounded(logLoss / n),
    accuracy_ci_95: [rounded(Math.max(0, center - radius)), rounded(Math.min(1, center + radius))]
  };
}

function parseRows(rows: Array<Record<string, unknown>>): HistoricalMatch[] {
  return rows.map((row) => ({
    matchId: String(row.match_id),
    league: String(row.league_slug),
    kickoff: new Date(String(row.kickoff)).toISOString(),
    homeTeamId: String(row.home_team_id),
    awayTeamId: String(row.away_team_id),
    homeTeam: String(row.home_team),
    awayTeam: String(row.away_team),
    homeScore: Number(row.home_score),
    awayScore: Number(row.away_score),
    resultAvailableAt: new Date(String(row.result_available_at)).toISOString(),
    duplicateCount: Number(row.duplicate_count),
    resultVariants: Number(row.result_variants)
  }));
}

export async function runSoccerPoissonWalkForwardBacktest(
  db: SoccerBacktestQueryable,
  options: SoccerWalkForwardOptions
) {
  const limit = options.limit ?? 10_000;
  const minTrainingMatches = options.minTrainingMatches ?? 20;
  const priorMatches = options.priorMatches ?? 5;
  const result = await db.query(
    `
      WITH base AS (
        SELECT
          vm.id AS match_id,
          fm.league_slug,
          vm.match_date AS kickoff,
          vm.home_score,
          vm.away_score,
          home_competitor.team_id AS home_team_id,
          away_competitor.team_id AS away_team_id,
          home_team.name AS home_team,
          away_team.name AS away_team,
          vm.updated_at
        FROM v_valid_matches vm
        JOIN forecast_matches fm ON fm.match_id = vm.id
        JOIN match_competitors home_competitor
          ON home_competitor.match_id = vm.id AND home_competitor.home_away = 'home'
        JOIN teams home_team ON home_team.id = home_competitor.team_id
        JOIN match_competitors away_competitor
          ON away_competitor.match_id = vm.id AND away_competitor.home_away = 'away'
        JOIN teams away_team ON away_team.id = away_competitor.team_id
        WHERE fm.sport_slug = 'soccer'
          AND vm.status = 'finished'
          AND vm.home_score IS NOT NULL
          AND vm.away_score IS NOT NULL
          AND vm.match_date >= $1::timestamptz
          AND vm.match_date < $2::timestamptz
          AND ($3::text IS NULL OR fm.league_slug = $3::text)
      ), grouped AS (
        SELECT
          league_slug,
          home_team_id,
          away_team_id,
          kickoff,
          COUNT(*) AS duplicate_count,
          COUNT(DISTINCT (home_score, away_score)) AS result_variants,
          MIN(updated_at) AS result_available_at
        FROM base
        GROUP BY league_slug, home_team_id, away_team_id, kickoff
      ), ranked AS (
        SELECT
          base.*,
          grouped.duplicate_count,
          grouped.result_variants,
          grouped.result_available_at,
          ROW_NUMBER() OVER (
            PARTITION BY base.league_slug, base.home_team_id, base.away_team_id, base.kickoff
            ORDER BY updated_at DESC, match_id
          ) AS duplicate_rank
        FROM base
        JOIN grouped USING (league_slug, home_team_id, away_team_id, kickoff)
      )
      SELECT
        match_id, league_slug, kickoff, home_score, away_score,
        home_team_id, away_team_id, home_team, away_team,
        result_available_at, duplicate_count, result_variants
      FROM ranked
      WHERE duplicate_rank = 1
      ORDER BY kickoff, league_slug, match_id
      LIMIT $4
    `,
    [options.from, options.to, options.league ?? null, limit]
  );
  const deduplicatedGroups = parseRows(result.rows);
  const conflictingGroups = deduplicatedGroups.filter((row) => row.resultVariants > 1);
  const matches = deduplicatedGroups.filter((row) => row.resultVariants === 1);
  const predictions: Prediction[] = [];
  const skipped: Array<Record<string, unknown>> = [];
  const leagues = [...new Set(matches.map((row) => row.league))].sort();

  for (const league of leagues) {
    const leagueRows = matches.filter((row) => row.league === league);
    for (const target of leagueRows) {
      const priorFixtures = leagueRows.filter((row) => row.kickoff < target.kickoff);
      const training = priorFixtures.filter((row) => row.resultAvailableAt < target.kickoff);
      if (training.length < minTrainingMatches) {
        const reason = priorFixtures.length >= minTrainingMatches
          ? "PRIOR_RESULTS_NOT_AVAILABLE_AS_OF"
          : "INSUFFICIENT_PRIOR_FIXTURES";
        skipped.push({
          match_id: target.matchId,
          league,
          kickoff: target.kickoff,
          reason,
          prior_fixtures: priorFixtures.length,
          training_matches: training.length,
          required: minTrainingMatches
        });
        continue;
      }
      const trainingMaxKickoff = training[training.length - 1].kickoff;
      const trainingMaxResultAvailableAt = training.reduce(
        (latest, row) => row.resultAvailableAt > latest ? row.resultAvailableAt : latest,
        training[0].resultAvailableAt
      );
      if (trainingMaxKickoff >= target.kickoff) throw new Error(`Temporal leakage detected for ${target.matchId}`);
      if (trainingMaxResultAvailableAt >= target.kickoff) {
        throw new Error(`Result-availability leakage detected for ${target.matchId}`);
      }
      const model = fitAndPredict(training, target, priorMatches);
      const probabilities = {
        home: rounded(model.probabilities.home),
        draw: rounded(model.probabilities.draw),
        away: rounded(model.probabilities.away)
      };
      const baseline = empiricalBaseline(training);
      predictions.push({
        match_id: target.matchId,
        league,
        kickoff: target.kickoff,
        home_team: target.homeTeam,
        away_team: target.awayTeam,
        actual: actualOutcome(target),
        predicted: predictedOutcome(probabilities),
        probabilities,
        baseline_probabilities: {
          home: rounded(baseline.home), draw: rounded(baseline.draw), away: rounded(baseline.away)
        },
        expected_goals: {
          home: rounded(model.expectedGoals.home), away: rounded(model.expectedGoals.away)
        },
        training_matches: training.length,
        training_max_kickoff: trainingMaxKickoff,
        training_max_result_available_at: trainingMaxResultAvailableAt
      });
    }
  }

  const rawRows = deduplicatedGroups.reduce((sum, row) => sum + row.duplicateCount, 0);
  const modelMetrics = metricSummary(predictions, "probabilities");
  const baselineMetrics = metricSummary(predictions, "baseline_probabilities");
  return {
    sample_class: "REPLAY_RESEARCH",
    operational_eligible: false,
    real_money_eligible: false,
    status: predictions.length === 0
      ? "INSUFFICIENT_HISTORY"
      : predictions.length < 30
        ? "EXPLORATORY_ONLY"
        : "RESEARCH_SAMPLE_AVAILABLE",
    filters: {
      sport: "soccer",
      league: options.league ?? null,
      from: options.from,
      to_exclusive: options.to,
      min_training_matches: minTrainingMatches,
      prior_matches: priorMatches,
      limit
    },
    cohort: {
      raw_rows: rawRows,
      deduplicated_groups: deduplicatedGroups.length,
      unique_matches: matches.length,
      duplicate_rows_excluded: rawRows - deduplicatedGroups.length,
      conflicting_result_groups_excluded: conflictingGroups.length,
      leagues,
      evaluated_matches: predictions.length,
      skipped_matches: skipped.length,
      result_availability_blocks: skipped.filter(
        (row) => row.reason === "PRIOR_RESULTS_NOT_AVAILABLE_AS_OF"
      ).length
    },
    model: modelMetrics,
    empirical_baseline: baselineMetrics,
    brier_skill_vs_baseline: modelMetrics.brier_score !== null
      && baselineMetrics.brier_score !== null
      && baselineMetrics.brier_score > 0
      ? rounded(1 - modelMetrics.brier_score / baselineMetrics.brier_score)
      : null,
    warnings: [
      "Research replay only; this report cannot authorize SHADOW or REAL activity.",
      "Training requires the final result to have been persisted before the target kickoff.",
      predictions.length < 30 ? "Evaluation sample is below 30; metrics are unstable." : null,
      rawRows > deduplicatedGroups.length
        ? `${rawRows - deduplicatedGroups.length} duplicate rows were excluded before training.`
        : null,
      conflictingGroups.length
        ? `${conflictingGroups.length} deduplicated groups were excluded because their final scores conflict.`
        : null
    ].filter(Boolean),
    conflicting_groups: conflictingGroups.map((row) => ({
      match_id: row.matchId,
      league: row.league,
      kickoff: row.kickoff,
      home_team: row.homeTeam,
      away_team: row.awayTeam,
      result_variants: row.resultVariants
    })),
    skipped,
    predictions
  };
}

export const soccerPoissonWalkForwardForTest = {
  fitAndPredict,
  metricSummary,
  poissonMass
};
