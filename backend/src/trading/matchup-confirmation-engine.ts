export type MatchupStatus =
  | "MATCHUP_CONFIRMED"
  | "MATCHUP_WEAK_CONFIRMATION"
  | "MODEL_CONFLICT"
  | "VALUE_ONLY"
  | "INSUFFICIENT_CONTEXT"
  | "PASS";

export type MatchupConfirmationInput = Record<string, any> & {
  pick?: string | null;
  entry_odds?: number | string | null;
  model_probability?: number | string | null;
  expected_value?: number | string | null;
  quality_score?: number | string | null;
  provider_score?: number | string | null;
  line_age_seconds?: number | string | null;
  recent_clv_10?: number | string | null;
  recent_clv_20?: number | string | null;
  recent_profit_10?: number | string | null;
  is_stale?: boolean | null;
  suspicious_move?: boolean | null;
  open_exposure_count?: number | string | null;
  decision?: string | null;
  underdog_plus_status?: string | null;
  feature_set?: Record<string, any> | null;
};

export type MatchupConfirmation = {
  matchup_status: MatchupStatus;
  matchup_score: number;
  pitcher_status: string;
  bullpen_status: string;
  lineup_status: string;
  recent_form_status: string;
  home_away_status: string;
  travel_rest_status: string;
  market_movement_status: string;
  confirmation_reasons: string[];
  conflict_reasons: string[];
  warnings: string[];
  recommendation: string;
  final_operational_status: "BETTABLE_PAPER_CONFIRMED" | "VALUE_ONLY_REVIEW" | "MODEL_CONFLICT_REVIEW" | "MATCHUP_REVIEW" | "PASS";
  real_paper_only: true;
};

function numeric(value: unknown, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function featureNumber(featureSet: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    const value = numeric(featureSet?.[key], NaN);
    if (Number.isFinite(value)) return value;
  }
  return NaN;
}

function hasFeature(featureSet: Record<string, any>, keys: string[]) {
  return keys.some((key) => featureSet?.[key] !== undefined && featureSet?.[key] !== null && featureSet?.[key] !== "");
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function confirmMatchup(input: MatchupConfirmationInput): MatchupConfirmation {
  const featureSet = input.feature_set && typeof input.feature_set === "object" ? input.feature_set : {};
  const pick = String(input.pick || "").toLowerCase();
  const pickPrefix = pick === "away" ? "away" : pick === "home" ? "home" : null;
  const oppPrefix = pickPrefix === "home" ? "away" : pickPrefix === "away" ? "home" : null;

  const odds = numeric(input.entry_odds);
  const modelProb = numeric(input.model_probability);
  const ev = numeric(input.expected_value);
  const providerScore = numeric(input.provider_score ?? input.quality_score);
  const recentClv10 = numeric(input.recent_clv_10, NaN);
  const recentClv20 = numeric(input.recent_clv_20, NaN);
  const recentProfit10 = numeric(input.recent_profit_10, NaN);
  const lineAgeSeconds = numeric(input.line_age_seconds);
  const exposure = numeric(input.open_exposure_count);
  const stale = input.is_stale === true || lineAgeSeconds > 24 * 60 * 60;
  const suspiciousMove = input.suspicious_move === true;

  const confirmationReasons: string[] = [];
  const conflictReasons: string[] = [];
  const warnings: string[] = [];

  let score = 45;

  if (odds >= 2.01) {
    score += 8;
    confirmationReasons.push("odds_2_01_plus_value_band");
  } else {
    score -= 8;
    conflictReasons.push("odds_below_promotable_band");
  }

  if (ev >= 0.05) {
    score += Math.min(14, ev * 30);
    confirmationReasons.push("ev_gte_5");
  } else {
    score -= 14;
    conflictReasons.push("ev_below_5");
  }

  if (modelProb >= 0.55) {
    score += Math.min(14, (modelProb - 0.5) * 160);
    confirmationReasons.push("model_prob_gte_55");
  } else {
    score -= 10;
    conflictReasons.push("model_prob_below_55");
  }

  if (providerScore >= 80) {
    score += 8;
    confirmationReasons.push("provider_clean");
  } else {
    score -= 12;
    conflictReasons.push("provider_score_below_80");
  }

  if (!stale) {
    score += 7;
    confirmationReasons.push("fresh_line");
  } else {
    score -= 18;
    conflictReasons.push("stale_line");
  }

  if (!suspiciousMove) {
    score += 5;
    confirmationReasons.push("no_suspicious_move");
  } else {
    score -= 15;
    conflictReasons.push("suspicious_move");
  }

  if (exposure <= 0) {
    score += 4;
    confirmationReasons.push("no_duplicate_exposure");
  } else {
    score -= 12;
    conflictReasons.push("duplicate_exposure");
  }

  let pitcherStatus = "PITCHER_CONTEXT_MISSING";
  let bullpenStatus = "BULLPEN_CONTEXT_MISSING";
  let lineupStatus = "LINEUP_CONTEXT_MISSING";
  let recentFormStatus = "RECENT_FORM_CONTEXT_MISSING";
  let homeAwayStatus = "HOME_AWAY_NEUTRAL";
  let travelRestStatus = "TRAVEL_REST_CONTEXT_MISSING";
  let marketMovementStatus = "MARKET_NEUTRAL";

  if (pickPrefix && oppPrefix) {
    const pickEra = featureNumber(featureSet, [`${pickPrefix}_era`, `${pickPrefix}_starter_era`, `${pickPrefix}_pitcher_era`]);
    const oppEra = featureNumber(featureSet, [`${oppPrefix}_era`, `${oppPrefix}_starter_era`, `${oppPrefix}_pitcher_era`]);
    const pickWhip = featureNumber(featureSet, [`${pickPrefix}_whip`, `${pickPrefix}_starter_whip`, `${pickPrefix}_pitcher_whip`]);
    const oppWhip = featureNumber(featureSet, [`${oppPrefix}_whip`, `${oppPrefix}_starter_whip`, `${oppPrefix}_pitcher_whip`]);

    if (Number.isFinite(pickEra) && Number.isFinite(oppEra)) {
      const eraEdge = oppEra - pickEra;
      if (eraEdge >= 0.35) {
        pitcherStatus = "PITCHER_EDGE";
        score += 12;
        confirmationReasons.push("pitcher_era_edge");
      } else if (eraEdge <= -0.35) {
        pitcherStatus = "PITCHER_CONFLICT";
        score -= 16;
        conflictReasons.push("pitcher_era_favors_opponent");
      } else {
        pitcherStatus = "PITCHER_NEUTRAL";
        score += 2;
      }
    } else if (Number.isFinite(pickWhip) && Number.isFinite(oppWhip)) {
      const whipEdge = oppWhip - pickWhip;
      if (whipEdge >= 0.08) {
        pitcherStatus = "PITCHER_WHIP_EDGE";
        score += 8;
        confirmationReasons.push("pitcher_whip_edge");
      } else if (whipEdge <= -0.08) {
        pitcherStatus = "PITCHER_WHIP_CONFLICT";
        score -= 10;
        conflictReasons.push("pitcher_whip_favors_opponent");
      } else {
        pitcherStatus = "PITCHER_NEUTRAL";
      }
    } else {
      warnings.push("missing_pitcher_context");
      score -= 5;
    }

    const pickBullpen = featureNumber(featureSet, [`${pickPrefix}_bullpen_era`, `${pickPrefix}_bullpen`]);
    const oppBullpen = featureNumber(featureSet, [`${oppPrefix}_bullpen_era`, `${oppPrefix}_bullpen`]);
    if (Number.isFinite(pickBullpen) && Number.isFinite(oppBullpen)) {
      const bullpenEdge = oppBullpen - pickBullpen;
      if (bullpenEdge >= 0.30) {
        bullpenStatus = "BULLPEN_EDGE";
        score += 8;
        confirmationReasons.push("bullpen_edge");
      } else if (bullpenEdge <= -0.30) {
        bullpenStatus = "BULLPEN_CONFLICT";
        score -= 10;
        conflictReasons.push("bullpen_favors_opponent");
      } else {
        bullpenStatus = "BULLPEN_NEUTRAL";
      }
    } else {
      warnings.push("missing_bullpen_context");
      score -= 3;
    }

    const pickOps = featureNumber(featureSet, [`${pickPrefix}_ops`, `${pickPrefix}_lineup_ops`, `${pickPrefix}_offense`]);
    const oppOps = featureNumber(featureSet, [`${oppPrefix}_ops`, `${oppPrefix}_lineup_ops`, `${oppPrefix}_offense`]);
    if (Number.isFinite(pickOps) && Number.isFinite(oppOps)) {
      const opsEdge = pickOps - oppOps;
      if (opsEdge >= 0.035) {
        lineupStatus = "LINEUP_EDGE";
        score += 7;
        confirmationReasons.push("lineup_ops_edge");
      } else if (opsEdge <= -0.035) {
        lineupStatus = "LINEUP_CONFLICT";
        score -= 8;
        conflictReasons.push("lineup_ops_favors_opponent");
      } else {
        lineupStatus = "LINEUP_NEUTRAL";
      }
    } else if (hasFeature(featureSet, ["home_ops", "away_ops", "home_lineup_ops", "away_lineup_ops"])) {
      lineupStatus = "LINEUP_PARTIAL_CONTEXT";
      warnings.push("partial_lineup_context");
    } else {
      warnings.push("missing_lineup_context");
      score -= 3;
    }

    if (pick === "home") {
      homeAwayStatus = "HOME_PICK_CONTEXT";
      score += 4;
      confirmationReasons.push("home_pick_context");
    } else if (pick === "away") {
      homeAwayStatus = "AWAY_PICK_REQUIRES_CLV_CONFIRMATION";
      if (Number.isFinite(recentClv10) && recentClv10 >= 0) score += 2;
      else warnings.push("away_pick_without_recent_clv_support");
    }
  } else {
    warnings.push("unknown_pick_side");
    score -= 8;
  }

  const pickRecentWins = featureNumber(featureSet, pickPrefix ? [`${pickPrefix}_last_5_win_rate`, `${pickPrefix}_recent_win_rate`, `${pickPrefix}_form`] : []);
  const oppRecentWins = featureNumber(featureSet, oppPrefix ? [`${oppPrefix}_last_5_win_rate`, `${oppPrefix}_recent_win_rate`, `${oppPrefix}_form`] : []);
  if (Number.isFinite(pickRecentWins) && Number.isFinite(oppRecentWins)) {
    const formEdge = pickRecentWins - oppRecentWins;
    if (formEdge >= 0.12) {
      recentFormStatus = "RECENT_FORM_EDGE";
      score += 6;
      confirmationReasons.push("recent_form_edge");
    } else if (formEdge <= -0.12) {
      recentFormStatus = "RECENT_FORM_CONFLICT";
      score -= 7;
      conflictReasons.push("recent_form_favors_opponent");
    } else {
      recentFormStatus = "RECENT_FORM_NEUTRAL";
    }
  } else if (Number.isFinite(recentProfit10) && recentProfit10 > 0) {
    recentFormStatus = "MARKET_RECENT_PROFIT_PROXY_POSITIVE";
    score += 3;
  } else {
    warnings.push("missing_recent_form_context");
  }

  const pickRest = featureNumber(featureSet, pickPrefix ? [`${pickPrefix}_rest_days`, `${pickPrefix}_rest`] : []);
  const oppRest = featureNumber(featureSet, oppPrefix ? [`${oppPrefix}_rest_days`, `${oppPrefix}_rest`] : []);
  if (Number.isFinite(pickRest) && Number.isFinite(oppRest)) {
    const restEdge = pickRest - oppRest;
    if (restEdge >= 1) {
      travelRestStatus = "REST_EDGE";
      score += 4;
      confirmationReasons.push("rest_edge");
    } else if (restEdge <= -1) {
      travelRestStatus = "REST_CONFLICT";
      score -= 5;
      conflictReasons.push("rest_favors_opponent");
    } else {
      travelRestStatus = "REST_NEUTRAL";
    }
  } else {
    warnings.push("missing_travel_rest_context");
  }

  if (Number.isFinite(recentClv10) && recentClv10 > 0) {
    marketMovementStatus = "MARKET_SUPPORTS_PICK";
    score += 6;
    confirmationReasons.push("recent_clv_positive");
  } else if (Number.isFinite(recentClv10) && recentClv10 < 0) {
    marketMovementStatus = "MARKET_AGAINST_PICK";
    score -= 8;
    conflictReasons.push("recent_clv_negative");
  }
  if (Number.isFinite(recentClv20) && recentClv20 < 0) warnings.push("recent_clv_20_negative");

  const contextWarnings = warnings.filter((warning) => warning.startsWith("missing_") || warning.includes("partial"));
  const hardConflict = conflictReasons.some((reason) => [
    "stale_line",
    "suspicious_move",
    "duplicate_exposure",
    "provider_score_below_80",
    "pitcher_era_favors_opponent",
    "pitcher_whip_favors_opponent",
    "bullpen_favors_opponent",
    "lineup_ops_favors_opponent"
  ].includes(reason));

  const finalScore = clampScore(score);
  let matchupStatus: MatchupStatus = "VALUE_ONLY";

  if (hardConflict && ev >= 0.05) {
    matchupStatus = "MODEL_CONFLICT";
  } else if (stale || suspiciousMove) {
    matchupStatus = "PASS";
  } else if (contextWarnings.length >= 4 && input.decision !== "BETTABLE_PAPER") {
    matchupStatus = "INSUFFICIENT_CONTEXT";
  } else if (finalScore >= 82 && contextWarnings.length <= 2 && pitcherStatus !== "PITCHER_CONTEXT_MISSING" && lineupStatus !== "LINEUP_CONTEXT_MISSING") {
    matchupStatus = "MATCHUP_CONFIRMED";
  } else if (finalScore >= 72 && input.decision === "BETTABLE_PAPER") {
    matchupStatus = "MATCHUP_WEAK_CONFIRMATION";
  } else if (ev >= 0.05 || odds >= 2.01) {
    matchupStatus = "VALUE_ONLY";
  } else {
    matchupStatus = "PASS";
  }

  let finalOperationalStatus: MatchupConfirmation["final_operational_status"] = "MATCHUP_REVIEW";
  if (matchupStatus === "MATCHUP_CONFIRMED" && input.decision === "BETTABLE_PAPER") {
    finalOperationalStatus = "BETTABLE_PAPER_CONFIRMED";
  } else if (matchupStatus === "MODEL_CONFLICT") {
    finalOperationalStatus = "MODEL_CONFLICT_REVIEW";
  } else if (["VALUE_ONLY", "INSUFFICIENT_CONTEXT", "MATCHUP_WEAK_CONFIRMATION"].includes(matchupStatus)) {
    finalOperationalStatus = "VALUE_ONLY_REVIEW";
  } else if (matchupStatus === "PASS") {
    finalOperationalStatus = "PASS";
  }

  const recommendation =
    finalOperationalStatus === "BETTABLE_PAPER_CONFIRMED"
      ? "Real Paper only: matematica y matchup confirmados; no dinero real."
      : finalOperationalStatus === "MODEL_CONFLICT_REVIEW"
        ? "Value matematico con conflicto de matchup; revisar antes de confiar."
        : finalOperationalStatus === "VALUE_ONLY_REVIEW"
          ? "Value matematico sin confirmacion completa de matchup; mantener en Real Paper/review."
          : "No tocar; esperar datos frescos o contexto suficiente.";

  return {
    matchup_status: matchupStatus,
    matchup_score: finalScore,
    pitcher_status: pitcherStatus,
    bullpen_status: bullpenStatus,
    lineup_status: lineupStatus,
    recent_form_status: recentFormStatus,
    home_away_status: homeAwayStatus,
    travel_rest_status: travelRestStatus,
    market_movement_status: marketMovementStatus,
    confirmation_reasons: confirmationReasons,
    conflict_reasons: conflictReasons,
    warnings,
    recommendation,
    final_operational_status: finalOperationalStatus,
    real_paper_only: true
  };
}
