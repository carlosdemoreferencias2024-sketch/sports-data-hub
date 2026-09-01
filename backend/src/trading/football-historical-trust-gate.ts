export type FootballHistoricalTrustInput = {
  matchId: string;
  providerEventId: string | null;
  kickoffAt: string | null;
  targetKickoffAt: string;
  identityValidation: string | null;
  scheduleValidation: string | null;
  resultStatus: string | null;
  synthetic: boolean | null;
  invalidated: boolean | null;
};

export type FootballHistoricalTrustDecision = {
  trusted: boolean;
  reasons: string[];
};

const FINAL_STATUSES = new Set(["FINAL", "FINISHED", "FT"]);

function normalized(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

export function evaluateFootballHistoricalTrust(
  input: FootballHistoricalTrustInput
): FootballHistoricalTrustDecision {
  const reasons: string[] = [];
  if (!String(input.providerEventId || "").trim()) reasons.push("PROVIDER_EVENT_ID_MISSING");

  const kickoff = new Date(String(input.kickoffAt || ""));
  const targetKickoff = new Date(input.targetKickoffAt);
  if (Number.isNaN(kickoff.getTime())) reasons.push("HISTORICAL_KICKOFF_INVALID");
  if (Number.isNaN(targetKickoff.getTime())) reasons.push("TARGET_KICKOFF_INVALID");
  if (!Number.isNaN(kickoff.getTime())
      && !Number.isNaN(targetKickoff.getTime())
      && kickoff.getTime() >= targetKickoff.getTime()) {
    reasons.push("NOT_PRE_TARGET");
  }

  if (normalized(input.identityValidation) !== "VALID") reasons.push("IDENTITY_NOT_VALID");
  if (normalized(input.scheduleValidation) !== "VALID") reasons.push("SCHEDULE_NOT_VALID");
  if (!FINAL_STATUSES.has(normalized(input.resultStatus))) reasons.push("RESULT_NOT_FINAL");
  if (input.synthetic !== false) reasons.push("SYNTHETIC_NOT_EXPLICITLY_FALSE");
  if (input.invalidated !== false) reasons.push("INVALIDATED_NOT_EXPLICITLY_FALSE");

  return { trusted: reasons.length === 0, reasons };
}

export function footballHistoricalConfidenceBand(homeSampleSize: number, awaySampleSize: number) {
  const minimum = Math.min(homeSampleSize, awaySampleSize);
  if (minimum <= 3) return "BOOTSTRAP" as const;
  if (minimum < 8) return "LOW" as const;
  return "MEDIUM" as const;
}
