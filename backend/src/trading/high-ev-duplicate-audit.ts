export type HighEvAuditStatus =
  | "EV_CLEAN"
  | "HIGH_EV_REVIEW"
  | "EXTREME_EV_REVIEW"
  | "ODDS_OUTLIER_REVIEW"
  | "DUPLICATE_BLOCKED"
  | "TIMESTAMP_MISMATCH_REVIEW"
  | "PROVIDER_REVIEW"
  | "CLV_WEAK_REVIEW";

export type HighEvAuditInput = Record<string, any> & {
  id?: string | null;
  match_id?: string | null;
  match?: string | null;
  sport_slug?: string | null;
  league_slug?: string | null;
  market_type?: string | null;
  pick?: string | null;
  entry_odds?: number | string | null;
  model_probability?: number | string | null;
  expected_value?: number | string | null;
  quality_score?: number | string | null;
  provider_score?: number | string | null;
  provider_name?: string | null;
  bookmaker?: string | null;
  latest_snapshot_at?: string | Date | null;
  entry_timestamp?: string | Date | null;
  line_age_seconds?: number | string | null;
  exposure_rank?: number | string | null;
  open_exposure_count?: number | string | null;
  recent_clv_10?: number | string | null;
  recent_clv_20?: number | string | null;
  grade?: string | null;
  edge_quality_grade?: string | null;
  is_stale?: boolean | null;
  suspicious_move?: boolean | null;
};

export type HighEvAudit = {
  high_ev_audit_status: HighEvAuditStatus;
  audit_clean: boolean;
  implied_probability: number | null;
  timestamp_gap_seconds: number | null;
  exposure_rank: number;
  ev_bucket: "EV_5_10" | "EV_10_25" | "EV_25_40" | "EV_40_PLUS" | "EV_OTHER";
  flags: string[];
  recommendation: string;
  allow_bettable_paper_confirmed: boolean;
  real_paper_only: true;
};

function numeric(value: unknown, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDate(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function timestampGapSeconds(a: unknown, b: unknown) {
  const left = parseDate(a);
  const right = parseDate(b);
  if (!left || !right) return null;
  return Math.round(Math.abs(left.getTime() - right.getTime()) / 1000);
}

function evBucket(ev: number): HighEvAudit["ev_bucket"] {
  if (ev >= 0.40) return "EV_40_PLUS";
  if (ev >= 0.25) return "EV_25_40";
  if (ev >= 0.10) return "EV_10_25";
  if (ev >= 0.05) return "EV_5_10";
  return "EV_OTHER";
}

export function auditHighEvDuplicate(input: HighEvAuditInput): HighEvAudit {
  const ev = numeric(input.expected_value);
  const odds = numeric(input.entry_odds);
  const providerScore = numeric(input.provider_score ?? input.quality_score, 100);
  const recentClv10 = numeric(input.recent_clv_10, NaN);
  const recentClv20 = numeric(input.recent_clv_20, NaN);
  const lineAgeSeconds = numeric(input.line_age_seconds);
  const exposureRank = Math.max(1, Math.round(numeric(input.exposure_rank, 1)));
  const openExposure = numeric(input.open_exposure_count);
  const grade = String(input.edge_quality_grade || input.grade || "").toUpperCase();
  const timestampGap = timestampGapSeconds(input.entry_timestamp, input.latest_snapshot_at);
  const implied = odds > 1 ? 1 / odds : null;
  const flags: string[] = [];

  if (exposureRank > 1 || openExposure > 0) flags.push("duplicate_secondary_exposure");
  if (ev > 0.60) flags.push("odds_outlier_ev_gt_60");
  else if (ev > 0.40) flags.push("extreme_ev_gt_40");
  else if (ev > 0.25) flags.push("high_ev_gt_25");
  if (timestampGap !== null && timestampGap > 6 * 60 * 60) flags.push("timestamp_gap_gt_6h");
  if (lineAgeSeconds > 24 * 60 * 60 || input.is_stale === true) flags.push("stale_line");
  if (providerScore < 80) flags.push("provider_score_below_80");
  if (input.suspicious_move === true) flags.push("suspicious_move");
  if (Number.isFinite(recentClv10) && recentClv10 < 0) flags.push("recent_clv_10_negative");
  if (Number.isFinite(recentClv20) && recentClv20 < 0) flags.push("recent_clv_20_negative");
  if (["C", "D", "F"].includes(grade)) flags.push("edge_grade_below_b");
  if (!implied || implied <= 0 || implied >= 1) flags.push("invalid_implied_probability");

  let status: HighEvAuditStatus = "EV_CLEAN";
  if (flags.includes("duplicate_secondary_exposure")) status = "DUPLICATE_BLOCKED";
  else if (flags.includes("odds_outlier_ev_gt_60")) status = "ODDS_OUTLIER_REVIEW";
  else if (flags.includes("timestamp_gap_gt_6h")) status = "TIMESTAMP_MISMATCH_REVIEW";
  else if (flags.includes("provider_score_below_80") || flags.includes("suspicious_move") || flags.includes("stale_line")) status = "PROVIDER_REVIEW";
  else if (flags.includes("recent_clv_10_negative") || flags.includes("recent_clv_20_negative")) status = "CLV_WEAK_REVIEW";
  else if (flags.includes("extreme_ev_gt_40")) status = "EXTREME_EV_REVIEW";
  else if (flags.includes("high_ev_gt_25")) status = "HIGH_EV_REVIEW";

  const auditClean = status === "EV_CLEAN" || (
    ["HIGH_EV_REVIEW", "EXTREME_EV_REVIEW"].includes(status)
    && !flags.some((flag) => [
      "duplicate_secondary_exposure",
      "timestamp_gap_gt_6h",
      "stale_line",
      "provider_score_below_80",
      "suspicious_move",
      "recent_clv_10_negative",
      "recent_clv_20_negative",
      "edge_grade_below_b",
      "invalid_implied_probability"
    ].includes(flag))
  );

  const allowConfirmed = auditClean && exposureRank === 1 && ["A", "B", ""].includes(grade);

  const recommendation =
    status === "EV_CLEAN"
      ? "EV limpio para Real Paper; no autoriza dinero real."
      : status === "DUPLICATE_BLOCKED"
        ? "Bloquear exposicion duplicada; agrupar como otros books detectados."
        : status === "EXTREME_EV_REVIEW" || status === "ODDS_OUTLIER_REVIEW"
          ? "EV extremo: auditar timestamp, implied probability, provider y closing antes de confirmar."
          : status === "TIMESTAMP_MISMATCH_REVIEW"
            ? "Revisar desfase entre modelo y cuota; EV puede estar inflado."
            : status === "PROVIDER_REVIEW"
              ? "Revisar provider/frescura/movimiento antes de confiar."
              : status === "CLV_WEAK_REVIEW"
                ? "CLV reciente debil; mantener en review."
                : "High EV requiere revision operativa; Real Paper only.";

  return {
    high_ev_audit_status: status,
    audit_clean: auditClean,
    implied_probability: implied,
    timestamp_gap_seconds: timestampGap,
    exposure_rank: exposureRank,
    ev_bucket: evBucket(ev),
    flags,
    recommendation,
    allow_bettable_paper_confirmed: allowConfirmed,
    real_paper_only: true
  };
}
