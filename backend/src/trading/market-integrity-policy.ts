import { closingWindowDiagnostics } from "./timezone.js";

export const ALLOWED_MARKET_SOURCES = new Set([
  "sportsbook_manual_verified",
  "bookmaker_manual_verified",
  "sportsdataio_manual_verified",
  "the_odds_api_manual_verified"
]);

export type IntegrityDecision = {
  eligible: boolean;
  status: string;
  reasons: string[];
  audit_only: boolean;
};

export type MarketSnapshotIntegrityInput = {
  capturedAt?: string | null;
  kickoff?: string | null;
  sourceName?: string | null;
  evidenceId?: string | null;
  screenshotSha256?: string | null;
  snapshotType?: string | null;
  staleStatus?: string | null;
  safeForEntry?: boolean | null;
  safeForClosing?: boolean | null;
  canonicalMatch?: boolean | null;
  duplicate?: boolean | null;
};

export type SettlementIntegrityInput = {
  entry: IntegrityDecision;
  closing: IntegrityDecision;
  resultFinal?: boolean | null;
  resultSourceVerified?: boolean | null;
  settlementFinal?: boolean | null;
  clvValid?: boolean | null;
};

function normalize(value: string | null | undefined) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeSport(value: string | null | undefined) {
  const sport = normalize(value);
  if (["soccer", "football", "futbol", "fútbol"].includes(sport)) return "soccer";
  if (["baseball", "baseball/mlb", "mlb"].includes(sport)) return "baseball";
  if (["basketball", "nba"].includes(sport)) return "basketball";
  return sport || "unknown";
}

export function isCanonicalMatch(input: Pick<MarketSnapshotIntegrityInput, "canonicalMatch" | "duplicate">) {
  return input.canonicalMatch === true && input.duplicate !== true;
}

function hasEvidence(input: MarketSnapshotIntegrityInput) {
  return Boolean(input.evidenceId && String(input.evidenceId).trim())
    && Boolean(input.screenshotSha256 && String(input.screenshotSha256).trim());
}

function commonReasons(input: MarketSnapshotIntegrityInput) {
  const reasons: string[] = [];
  if (input.canonicalMatch !== true) reasons.push("MATCH_NOT_CANONICAL");
  if (input.duplicate === true) reasons.push("DUPLICATE_EXPOSURE");
  if (!ALLOWED_MARKET_SOURCES.has(normalize(input.sourceName))) reasons.push("SOURCE_NOT_ALLOWED");
  if (!hasEvidence(input)) reasons.push("EVIDENCE_MISSING");
  return reasons;
}

function validTimestamp(value: string | null | undefined) {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

export function validateEntrySnapshot(input: MarketSnapshotIntegrityInput): IntegrityDecision {
  const reasons = commonReasons(input);
  const role = normalize(input.snapshotType);
  if (role !== "entry" && role !== "current") reasons.push("ENTRY_ROLE_INVALID");
  if (input.safeForEntry !== true) reasons.push("SAFE_FOR_ENTRY_FALSE");
  if (!validTimestamp(input.capturedAt)) reasons.push("INVALID_CAPTURE_TIMESTAMP");
  if (!validTimestamp(input.kickoff)) reasons.push(input.kickoff ? "INVALID_KICKOFF_TIMESTAMP" : "MISSING_KICKOFF");

  if (validTimestamp(input.capturedAt) && validTimestamp(input.kickoff)) {
    if (new Date(input.capturedAt!).getTime() >= new Date(input.kickoff!).getTime()) {
      reasons.push("ENTRY_NOT_PREGAME");
    }
  }
  if (normalize(input.staleStatus) !== "fresh") reasons.push("ENTRY_STALE");

  return {
    eligible: reasons.length === 0,
    status: reasons.length === 0 ? "ENTRY_VALID" : "ENTRY_AUDIT_ONLY",
    reasons,
    audit_only: reasons.length > 0
  };
}

export function validateClosingSnapshot(input: MarketSnapshotIntegrityInput): IntegrityDecision & {
  closing_quality: string;
  closing_window_start: string | null;
  closing_window_end: string | null;
} {
  const reasons = commonReasons(input);
  if (normalize(input.snapshotType) !== "closing") reasons.push("CLOSING_ROLE_INVALID");
  if (input.safeForClosing !== true) reasons.push("SAFE_FOR_CLOSING_FALSE");

  const diagnostics = computeClosingQuality(input.capturedAt, input.kickoff);
  if (diagnostics.closing_quality !== "CAPTURED_ON_TIME") reasons.push(diagnostics.closing_quality);

  return {
    eligible: reasons.length === 0,
    status: reasons.length === 0 ? "CLOSING_VALID" : "CLOSING_AUDIT_ONLY",
    reasons,
    audit_only: reasons.length > 0,
    closing_quality: diagnostics.closing_quality,
    closing_window_start: diagnostics.closing_window_start,
    closing_window_end: diagnostics.closing_window_end
  };
}

export function computeClosingQuality(capturedAt?: string | null, kickoff?: string | null) {
  return closingWindowDiagnostics(String(capturedAt || ""), kickoff);
}

export function validateSettlementEligibility(input: SettlementIntegrityInput): IntegrityDecision {
  const reasons = [
    ...input.entry.reasons.map((reason) => `ENTRY:${reason}`),
    ...input.closing.reasons.map((reason) => `CLOSING:${reason}`)
  ];
  if (!input.entry.eligible) reasons.push("ENTRY_CHAIN_INVALID");
  if (!input.closing.eligible) reasons.push("CLOSING_CHAIN_INVALID");
  if (input.resultFinal !== true) reasons.push("RESULT_NOT_FINAL");
  if (input.resultSourceVerified !== true) reasons.push("RESULT_SOURCE_NOT_VERIFIED");

  return {
    eligible: reasons.length === 0,
    status: reasons.length === 0 ? "READY_FOR_SETTLEMENT" : "SETTLEMENT_BLOCKED",
    reasons: [...new Set(reasons)],
    audit_only: reasons.length > 0
  };
}

export function validateCleanSampleEligibility(input: SettlementIntegrityInput): IntegrityDecision {
  const settlement = validateSettlementEligibility(input);
  const reasons = [...settlement.reasons];
  if (input.settlementFinal !== true) reasons.push("SETTLEMENT_NOT_FINAL");
  if (input.clvValid !== true) reasons.push("CLV_NOT_VALID");
  return {
    eligible: reasons.length === 0,
    status: reasons.length === 0 ? "CLEAN_V2_ELIGIBLE" : "LEGACY_OR_AUDIT_ONLY",
    reasons: [...new Set(reasons)],
    audit_only: reasons.length > 0
  };
}

export function computeClvEligibility(input: SettlementIntegrityInput): IntegrityDecision {
  const settlement = validateSettlementEligibility(input);
  const reasons = [...settlement.reasons];
  if (input.settlementFinal !== true) reasons.push("SETTLEMENT_NOT_FINAL");
  return {
    eligible: reasons.length === 0,
    status: reasons.length === 0 ? "CLV_ELIGIBLE" : "LEGACY_CLV_PREVIEW_ONLY",
    reasons: [...new Set(reasons)],
    audit_only: reasons.length > 0
  };
}

export function isCleanV2Eligible(input: SettlementIntegrityInput) {
  return validateCleanSampleEligibility(input).eligible;
}

export function isAuditOnly(decision: IntegrityDecision) {
  return decision.audit_only;
}

export function isLegacyOnly(input: SettlementIntegrityInput) {
  return !isCleanV2Eligible(input);
}
