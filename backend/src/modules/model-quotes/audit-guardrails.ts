export type AuditInput = {
  provider_name?: string | null;
  processed?: boolean | null;
  market_type?: string | null;
  market_selection?: string | null;
  line?: string | number | null;
  market_odds?: string | number | null;
  model_fair_odds?: string | number | null;
  model_probability?: string | number | null;
  expected_value?: string | number | null;
  age_seconds?: string | number | null;
  market_age_seconds?: string | number | null;
  sport_slug?: string | null;
  league_slug?: string | null;
  enable_real_paper?: boolean | null;
  enable_real_moneyline?: boolean | null;
  enable_real_totals?: boolean | null;
  enable_real_runline?: boolean | null;
  enable_real_betting?: boolean | null;
};

export type AuditResult = {
  audit_status: "REAL_CANDIDATE" | "REAL_PAPER_CANDIDATE" | "RADAR_ONLY" | "REVIEW" | "NO_BET";
  allow_real_bet: boolean;
  allow_real_paper: boolean;
  audit_reason: string;
  review_type: string | null;
  implied_probability: number;
  model_probability_audit: number;
  real_expected_value: number;
};

export type ParlayAuditLeg = {
  provider_name?: string | null;
  processed?: boolean | null;
  allow_real_bet?: boolean | null;
};

export function asNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value);
}

export function isShadowProvider(providerName: string | null | undefined) {
  return String(providerName ?? "").toLowerCase().includes("shadow");
}

export function isManualProvider(providerName: string | null | undefined) {
  const provider = String(providerName ?? "").toLowerCase();
  return provider.includes("shadow") || provider.includes("manual") || provider.includes("simulated");
}

export function isRunLineDiagnosticProvider(providerName: string | null | undefined) {
  return String(providerName ?? "").toLowerCase() === "manual_shadow_mlb_runline";
}

export function auditSelection(input: AuditInput): AuditResult {
  const provider = String(input.provider_name ?? "").toLowerCase();
  const market = String(input.market_type ?? "").toLowerCase();
  const sport = String(input.sport_slug ?? "").toLowerCase();
  const league = String(input.league_slug ?? "").toLowerCase();
  const selection = String(input.market_selection ?? "").toLowerCase();
  const line = asNumber(input.line);
  const marketOdds = asNumber(input.market_odds);
  const fairOdds = asNumber(input.model_fair_odds);
  const modelProbability = input.model_probability !== undefined && input.model_probability !== null
    ? asNumber(input.model_probability)
    : fairOdds > 0
      ? 1 / fairOdds
      : 0;
  const impliedProbability = marketOdds > 0 ? 1 / marketOdds : 0;
  const realExpectedValue = marketOdds > 0 && modelProbability > 0
    ? (marketOdds * modelProbability) - 1
    : asNumber(input.expected_value);
  const ageSeconds = input.age_seconds !== undefined && input.age_seconds !== null
    ? asNumber(input.age_seconds)
    : asNumber(input.market_age_seconds);
  const shadow = isManualProvider(provider) || input.processed === false;
  const runLineMarket = market.includes("run_line") || market.includes("run line");
  const moneylineMarket = market === "moneyline_2way" || market === "moneyline_3way";
  const totalsMarket = market === "total_runs" || market === "total_goals_2_5" || market === "total_points";
  const mlbMarket = sport === "baseball" && league === "mlb";
  const runLineDiagnosticProvider = isRunLineDiagnosticProvider(provider);
  const enableRealPaper = input.enable_real_paper ?? process.env.ENABLE_REAL_PAPER !== "false";
  const enableRealMoneyline = input.enable_real_moneyline ?? process.env.ENABLE_REAL_MONEYLINE !== "false";
  const enableRealTotals = input.enable_real_totals ?? process.env.ENABLE_REAL_TOTALS === "true";
  const enableRealRunLine = input.enable_real_runline ?? process.env.ENABLE_REAL_RUNLINE === "true";
  const enableRealBetting = input.enable_real_betting ?? process.env.ENABLE_REAL_BETTING === "true";

  if (!provider) {
    return {
      audit_status: "REVIEW",
      allow_real_bet: false,
      allow_real_paper: false,
      audit_reason: "Missing bookmaker/provider",
      review_type: "MISSING_BOOKMAKER",
      implied_probability: impliedProbability,
      model_probability_audit: modelProbability,
      real_expected_value: realExpectedValue
    };
  }

  if (fairOdds <= 1 && modelProbability <= 0) {
    return {
      audit_status: "REVIEW",
      allow_real_bet: false,
      allow_real_paper: false,
      audit_reason: "Invalid fair odds/model probability",
      review_type: "INVALID_FAIR_ODDS",
      implied_probability: impliedProbability,
      model_probability_audit: modelProbability,
      real_expected_value: realExpectedValue
    };
  }

  if (marketOdds <= 1) {
    return {
      audit_status: "REVIEW",
      allow_real_bet: false,
      allow_real_paper: false,
      audit_reason: "Invalid market odds",
      review_type: "INVALID_MARKET_ODDS",
      implied_probability: impliedProbability,
      model_probability_audit: modelProbability,
      real_expected_value: realExpectedValue
    };
  }

  if (runLineMarket) {
    if ((line === 1.5 && marketOdds > 3.5) || (line === -1.5 && marketOdds > 6.5)) {
      return {
        audit_status: "REVIEW",
        allow_real_bet: false,
        allow_real_paper: false,
        audit_reason: "Run line con cuota anormalmente alta",
        review_type: "ODDS_OUTLIER",
        implied_probability: impliedProbability,
        model_probability_audit: modelProbability,
        real_expected_value: realExpectedValue
      };
    }
    if ((line === 1.5 || line === -1.5) && marketOdds < 1.2) {
      return {
        audit_status: "REVIEW",
        allow_real_bet: false,
        allow_real_paper: false,
        audit_reason: "Run line con cuota demasiado baja, revisar parseo",
        review_type: "ODDS_OUTLIER",
        implied_probability: impliedProbability,
        model_probability_audit: modelProbability,
        real_expected_value: realExpectedValue
      };
    }
    if (line < 0 && modelProbability < 0.52) {
      return {
        audit_status: "REVIEW",
        allow_real_bet: false,
        allow_real_paper: false,
        audit_reason: "Run line favorito no coincide con probabilidad esperada",
        review_type: "HANDICAP_SUSPICIOUS",
        implied_probability: impliedProbability,
        model_probability_audit: modelProbability,
        real_expected_value: realExpectedValue
      };
    }
  }

  if (runLineDiagnosticProvider) {
    return {
      audit_status: "RADAR_ONLY",
      allow_real_bet: false,
      allow_real_paper: false,
      audit_reason: "Manual shadow MLB run line diagnostic only",
      review_type: null,
      implied_probability: impliedProbability,
      model_probability_audit: modelProbability,
      real_expected_value: realExpectedValue
    };
  }

  if (shadow) {
    return {
      audit_status: "RADAR_ONLY",
      allow_real_bet: false,
      allow_real_paper: false,
      audit_reason: "Shadow/manual data - not eligible for real betting",
      review_type: null,
      implied_probability: impliedProbability,
      model_probability_audit: modelProbability,
      real_expected_value: realExpectedValue
    };
  }

  if (runLineMarket && !enableRealRunLine) {
    return {
      audit_status: "REVIEW",
      allow_real_bet: false,
      allow_real_paper: false,
      audit_reason: "Real run line disabled until manual review enables it",
      review_type: "RUN_LINE_DISABLED",
      implied_probability: impliedProbability,
      model_probability_audit: modelProbability,
      real_expected_value: realExpectedValue
    };
  }

  if (ageSeconds > 900) {
    return {
      audit_status: "REVIEW",
      allow_real_bet: false,
      allow_real_paper: false,
      audit_reason: "Market odds stale: age_seconds > 900",
      review_type: "STALE_ODDS",
      implied_probability: impliedProbability,
      model_probability_audit: modelProbability,
      real_expected_value: realExpectedValue
    };
  }

  if (mlbMarket && totalsMarket && !enableRealTotals) {
    return {
      audit_status: "REVIEW",
      allow_real_bet: false,
      allow_real_paper: false,
      audit_reason: "Real paper totals disabled until market review enables it",
      review_type: "REAL_PAPER_DISABLED",
      implied_probability: impliedProbability,
      model_probability_audit: modelProbability,
      real_expected_value: realExpectedValue
    };
  }

  const candidateMathPass = (
    input.processed === true
    && !isShadowProvider(provider)
    && marketOdds > 1.3
    && marketOdds < 4.5
    && realExpectedValue >= 0.03
    && modelProbability >= 0.52
  );
  const realPaperCandidate = (
    candidateMathPass
    && enableRealPaper
    && mlbMarket
    && moneylineMarket
    && enableRealMoneyline
  );
  const realCandidate = realPaperCandidate && enableRealBetting;
  let noBetReviewType: string | null = null;
  let noBetReason = "No cumple filtros de real paper/apuesta real";

  if (!realPaperCandidate && !realCandidate) {
    if (!candidateMathPass) {
      if (input.processed !== true) {
        noBetReviewType = "UNPROCESSED_REAL_PROVIDER";
        noBetReason = "Provider real sin processed=true";
      } else if (marketOdds <= 1.3 || marketOdds >= 4.5) {
        noBetReviewType = "ODDS_OUT_OF_RANGE";
        noBetReason = "Cuota real fuera del rango permitido para Real Paper";
      } else if (realExpectedValue < 0.03) {
        noBetReviewType = "LOW_EV";
        noBetReason = "EV real menor al umbral de 3%";
      } else if (modelProbability < 0.52) {
        noBetReviewType = "LOW_MODEL_PROB";
        noBetReason = "Probabilidad del modelo menor al umbral de 52%";
      } else {
        noBetReviewType = "REAL_PAPER_FILTER_MISS";
      }
    } else if (!enableRealPaper) {
      noBetReviewType = "REAL_PAPER_DISABLED";
      noBetReason = "Real Paper esta deshabilitado";
    } else if (!mlbMarket) {
      noBetReviewType = "MARKET_NOT_ENABLED";
      noBetReason = "Solo MLB esta habilitado para Real Paper inicial";
    } else if (!moneylineMarket) {
      noBetReviewType = "MARKET_NOT_ENABLED";
      noBetReason = "Solo MLB Moneyline esta habilitado para Real Paper inicial";
    } else if (!enableRealMoneyline) {
      noBetReviewType = "REAL_PAPER_DISABLED";
      noBetReason = "MLB Moneyline Real Paper esta deshabilitado";
    }
  }

  return {
    audit_status: realCandidate ? "REAL_CANDIDATE" : realPaperCandidate ? "REAL_PAPER_CANDIDATE" : "NO_BET",
    allow_real_bet: realCandidate,
    allow_real_paper: realPaperCandidate,
    audit_reason: realCandidate
      ? "Real bookmaker candidate passed audit"
      : realPaperCandidate
        ? "Real paper candidate: MLB moneyline only, flat shadow validation"
        : noBetReason,
    review_type: realCandidate || realPaperCandidate ? null : noBetReviewType,
    implied_probability: impliedProbability,
    model_probability_audit: modelProbability,
    real_expected_value: realExpectedValue
  };
}

export function auditParlayLegs(legs: ParlayAuditLeg[]) {
  const hasShadow = legs.some((leg) => (
    leg.allow_real_bet === false
    || isManualProvider(leg.provider_name)
    || leg.processed === false
  ));

  return {
    status: hasShadow ? "radar" : "ready",
    real_bet_allowed: !hasShadow
  };
}
