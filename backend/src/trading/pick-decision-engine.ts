export type PickDecisionName =
  | "BETTABLE_PAPER"
  | "WATCH"
  | "COOLING"
  | "REJECT"
  | "BLOCKED_BY_RISK"
  | "NEEDS_MANUAL_REVIEW";

export type PickDecisionInput = {
  sport_slug?: string | null;
  league_slug?: string | null;
  market_type?: string | null;
  pick?: string | null;
  provider_name?: string | null;
  bookmaker?: string | null;
  processed?: boolean | null;
  entry_odds?: number | string | null;
  model_probability?: number | string | null;
  expected_value?: number | string | null;
  provider_score?: number | string | null;
  quality_score?: number | string | null;
  recent_clv_10?: number | string | null;
  recent_clv_20?: number | string | null;
  recent_profit_10?: number | string | null;
  line_age_seconds?: number | string | null;
  is_stale?: boolean | null;
  stale_line?: boolean | null;
  suspicious_move?: boolean | null;
  suspicious_provider?: boolean | null;
  open_exposure_count?: number | string | null;
  market_status?: string | null;
  market_promotion_status?: string | null;
  risk_status?: string | null;
  real_money_enabled?: boolean | null;
  kelly_enabled?: boolean | null;
  telegram_auto_enabled?: boolean | null;
  kill_switch_enabled?: boolean | null;
  max_line_age_seconds?: number | null;
};

export type PickDecision = {
  decision: PickDecisionName;
  final_status: string;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  reasons_passed: string[];
  reasons_blocked: string[];
  warnings: string[];
  market_status: string;
  risk_status: string;
  provider_status: string;
  clv_status: string;
  freshness_status: string;
  exposure_status: string;
  recommendation: string;
  real_paper_only: true;
};

function numeric(value: number | string | null | undefined, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function grade(score: number): PickDecision["grade"] {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function isManualOrShadowProvider(providerName: string | null | undefined) {
  const provider = String(providerName || "").toLowerCase();
  return provider.includes("manual") || provider.includes("shadow") || provider.includes("simulated");
}

export function decidePick(input: PickDecisionInput): PickDecision {
  const reasonsPassed: string[] = [];
  const reasonsBlocked: string[] = [];
  const warnings: string[] = [];

  const odds = numeric(input.entry_odds);
  const modelProb = numeric(input.model_probability);
  const ev = numeric(input.expected_value);
  const providerScore = numeric(input.provider_score ?? input.quality_score);
  const recentClv10 = numeric(input.recent_clv_10, NaN);
  const recentClv20 = numeric(input.recent_clv_20, NaN);
  const recentProfit10 = numeric(input.recent_profit_10, NaN);
  const lineAgeSeconds = numeric(input.line_age_seconds);
  const maxLineAgeSeconds = input.max_line_age_seconds ?? 24 * 60 * 60;
  const exposure = numeric(input.open_exposure_count);
  const provider = String(input.provider_name || input.bookmaker || "");
  const marketStatus = String(input.market_status || input.market_promotion_status || "UNKNOWN");
  const riskStatus = String(input.risk_status || "RISK_OK_FOR_PAPER");

  const isMlbMoneyline = input.sport_slug === "baseball" && input.league_slug === "mlb" && input.market_type === "moneyline_2way";
  const isPromotableOddsBand = odds >= 2.01;
  const providerIsShadow = isManualOrShadowProvider(provider);
  const processed = input.processed !== false;
  const isStale = input.is_stale === true || input.stale_line === true || lineAgeSeconds > maxLineAgeSeconds;
  const suspiciousMove = input.suspicious_move === true || input.suspicious_provider === true;
  const marketBlocked = ["BLOCKED", "ACCUMULATING"].includes(marketStatus);
  const riskBlocked = ["BLOCKED_BY_RISK", "RISK_BLOCK", "CLV_TREND_WARNING"].includes(riskStatus);
  const hardSafetyOff = input.real_money_enabled === true || input.kelly_enabled === true || input.telegram_auto_enabled === true;

  if (!hardSafetyOff) reasonsPassed.push("safety_guardrails_off");
  if (isMlbMoneyline) reasonsPassed.push("mlb_moneyline");
  else reasonsBlocked.push("market_not_mlb_moneyline");
  if (isPromotableOddsBand) reasonsPassed.push("odds_band_2_01_plus");
  else reasonsBlocked.push(odds >= 1.61 ? "odds_band_1_61_2_00_blocked" : "odds_below_2_01");
  if (ev >= 0.05) reasonsPassed.push("ev_gte_5");
  else reasonsBlocked.push(ev <= 0 ? "ev_not_positive" : "ev_below_5");
  if (modelProb >= 0.55) reasonsPassed.push("model_prob_gte_55");
  else reasonsBlocked.push(modelProb <= 0 || modelProb > 1 ? "invalid_model_probability" : "model_prob_below_55");
  if (odds > 1 && odds < 100) reasonsPassed.push("valid_odds");
  else reasonsBlocked.push("invalid_odds");
  if (providerScore >= 80) reasonsPassed.push("provider_score_gte_80");
  else reasonsBlocked.push("provider_score_below_80");
  if (!providerIsShadow && processed) reasonsPassed.push("real_provider_processed");
  else reasonsBlocked.push(providerIsShadow ? "shadow_or_manual_provider" : "processed_false");
  if (!isStale) reasonsPassed.push("fresh_line");
  else reasonsBlocked.push("stale_line");
  if (!suspiciousMove) reasonsPassed.push("no_suspicious_move");
  else reasonsBlocked.push("suspicious_move");
  if (exposure <= 0) reasonsPassed.push("no_duplicate_match_exposure");
  else reasonsBlocked.push("duplicate_match_exposure");
  if (!marketBlocked) reasonsPassed.push("market_not_blocked");
  else reasonsBlocked.push(`market_${marketStatus.toLowerCase()}`);
  if (!riskBlocked) reasonsPassed.push("risk_ok_for_paper");
  else reasonsBlocked.push("risk_engine_block");

  if (Number.isFinite(recentClv10) && recentClv10 >= 0) reasonsPassed.push("recent_clv_10_non_negative");
  if (Number.isFinite(recentClv10) && recentClv10 < 0) warnings.push("recent_clv_10_negative");
  if (Number.isFinite(recentClv20) && recentClv20 < 0) warnings.push("recent_clv_20_negative");
  if (Number.isFinite(recentProfit10) && recentProfit10 < 0) warnings.push("recent_profit_10_negative");
  if (odds > 2.5) warnings.push("long_price_variance_watch");
  if (input.kill_switch_enabled !== true) warnings.push("kill_switch_not_confirmed");

  const score = Math.round(Math.max(0, Math.min(100,
    25
    + Math.min(Math.max(ev, 0) * 35, 18)
    + Math.min(Math.max(modelProb - 0.5, 0) * 120, 16)
    + Math.min(Math.max(providerScore - 70, 0) * 0.45, 12)
    + (isMlbMoneyline ? 8 : -15)
    + (isPromotableOddsBand ? 8 : -8)
    + (!isStale ? 8 : -18)
    + (!suspiciousMove ? 6 : -15)
    + (exposure <= 0 ? 5 : -16)
    + (Number.isFinite(recentClv10) && recentClv10 >= 0 ? 8 : 0)
    + (Number.isFinite(recentClv20) && recentClv20 >= 0 ? 4 : 0)
    - reasonsBlocked.length * 5
    - warnings.length * 1.5
  )));

  let decision: PickDecisionName = "WATCH";
  const hardBlocks = new Set([
    "shadow_or_manual_provider",
    "processed_false",
    "stale_line",
    "suspicious_move",
    "provider_score_below_80",
    "duplicate_match_exposure",
    "market_blocked",
    "market_accumulating",
    "risk_engine_block",
    "invalid_odds",
    "invalid_model_probability",
    "ev_not_positive",
    "odds_band_1_61_2_00_blocked",
    "odds_below_2_01"
  ]);

  if (hardSafetyOff || reasonsBlocked.some((reason) => hardBlocks.has(reason))) {
    decision = "BLOCKED_BY_RISK";
  } else if (score >= 75 && isMlbMoneyline && isPromotableOddsBand && ev >= 0.05 && modelProb >= 0.55) {
    decision = "BETTABLE_PAPER";
  } else if (warnings.some((warning) => warning.includes("negative"))) {
    decision = "COOLING";
  } else if (reasonsBlocked.length > 0) {
    decision = "REJECT";
  } else if (warnings.length > 0) {
    decision = "NEEDS_MANUAL_REVIEW";
  }

  return {
    decision,
    final_status: decision,
    score,
    grade: grade(score),
    reasons_passed: reasonsPassed,
    reasons_blocked: hardSafetyOff ? ["real_money_or_kelly_or_auto_telegram_enabled", ...reasonsBlocked] : reasonsBlocked,
    warnings,
    market_status: marketStatus,
    risk_status: riskStatus,
    provider_status: providerScore >= 80 && !providerIsShadow && processed ? "PROVIDER_CLEAN" : "PROVIDER_REVIEW",
    clv_status: Number.isFinite(recentClv10) && recentClv10 < 0 ? "CLV_COOLING" : "CLV_OK_FOR_PAPER",
    freshness_status: isStale ? "STALE" : "FRESH",
    exposure_status: exposure > 0 ? "DUPLICATE_EXPOSURE" : "CLEAR",
    recommendation:
      decision === "BETTABLE_PAPER"
        ? "Real Paper only: buen candidato, sin dinero real."
        : decision === "BLOCKED_BY_RISK"
          ? "Bloqueado por guardrails; no usar salvo revision manual."
          : decision === "COOLING"
            ? "Senal enfriandose; seguir observando."
            : "Mantener en watch/review hasta que pase todos los filtros.",
    real_paper_only: true
  };
}
