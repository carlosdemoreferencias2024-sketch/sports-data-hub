export const HISTORICAL_REPLAY_CHECKLIST_VERSION = "historical_replay_single_match_v1";
export const FORECAST_CLV_FORMULA_VERSION = "decimal_price_ratio_v1";

const EXPECTED_STAGES = ["fair_odds", "entry", "context", "closing", "result", "clv"] as const;
const SHA256 = /^[a-f0-9]{64}$/i;
const CLV_TOLERANCE = 1e-8;

export type ReplayChainStage = {
  id: string;
  stage: string;
  sequenceNum: number;
  evidenceId?: string | null;
  contextId?: string | null;
  modelVersionId?: string | null;
  modelQuoteId?: string | null;
  value: Record<string, unknown>;
};

export type ReplayEvidence = {
  id: string;
  oddsSnapshotId?: string | null;
  providerName: string;
  bookmaker: string;
  marketType: string;
  selection: string;
  decimalOdds: number;
  capturedAt: string;
  timingQuality: string;
  rawPayloadHash: string;
  snapshot?: {
    id: string;
    matchId: string;
    providerName: string;
    bookmaker: string;
    marketType: string;
    selection: string;
    odds: number;
    capturedAt: string;
  } | null;
};

export type HistoricalReplayAuditInput = {
  match: {
    matchId: string;
    sportSlug: string;
    status: string;
    scheduledStart: string;
  };
  criteria?: {
    cohort: string;
    requireContextComplete: boolean;
    requireDualEvidence: boolean;
    dualEvidenceToleranceMinutes: number;
    fairOddsMethodVersion: string;
  } | null;
  historicalDecision?: {
    decision: string;
    reasons: unknown[];
  } | null;
  prospectiveDecisionCount: number;
  chainValid: boolean;
  chain: ReplayChainStage[];
  evidence: ReplayEvidence[];
  context?: {
    completeness: string;
    captureMode: string;
    capturedAt: string;
    sourceUrl?: string | null;
    sourcePayloadHash?: string | null;
    sourcePublishedAt?: string | null;
    sourceAsOfAt?: string | null;
    replayVerifiedBy?: string | null;
    noPostEventDataAttested: boolean;
  } | null;
  modelVersion?: {
    id: string;
    sportSlug: string;
    trainingCutoffDate: string;
    trainedAt: string;
    artifactSha256: string;
  } | null;
  clvRecord?: {
    entryOdds: number;
    closingOdds: number;
    clvPercent: number;
    formulaVersion: string;
    chainVerified: boolean;
  } | null;
  assessment?: {
    cohort: string;
    cleanEligible: boolean;
    readyGateEligible: boolean;
    walkForwardPassed: boolean;
    reasons: unknown[];
  } | null;
};

export type ReplayValidationCheck = {
  code: string;
  passed: boolean;
  detail: string;
};

export type HistoricalReplayValidation = {
  checklistVersion: string;
  matchId: string;
  status: "PASS" | "BLOCKED";
  checks: ReplayValidationCheck[];
  blockingReasons: string[];
};

function time(value: string | null | undefined) {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function sameInstant(first: string, second: string) {
  return Math.abs(time(first) - time(second)) <= 1000;
}

function sameText(first: string, second: string) {
  return first.trim().toLowerCase() === second.trim().toLowerCase();
}

export function decimalPriceRatioClv(entryOdds: number, closingOdds: number) {
  return entryOdds / closingOdds - 1;
}

export function validateHistoricalReplay(input: HistoricalReplayAuditInput): HistoricalReplayValidation {
  const checks: ReplayValidationCheck[] = [];
  const add = (code: string, passed: boolean, detail: string) => checks.push({ code, passed, detail });
  const kickoff = time(input.match.scheduledStart);

  add(
    "MATCH_FINISHED_AND_PAST",
    input.match.status === "finished" && Number.isFinite(kickoff) && kickoff < Date.now(),
    "The replay target must be a finished match with a past scheduled start."
  );

  const strictCriteria = input.criteria?.cohort === "HISTORICAL_BACKTEST"
    && input.criteria.requireContextComplete
    && input.criteria.requireDualEvidence;
  add(
    "HISTORICAL_POLICY_STRICT",
    strictCriteria === true,
    "Historical policy must require complete context and independent dual odds evidence."
  );
  add(
    "HISTORICAL_INCLUDED",
    input.historicalDecision?.decision === "INCLUDED"
      && (input.historicalDecision.reasons?.length ?? 0) === 0,
    "The match must have an INCLUDED historical decision with no reasons."
  );
  add(
    "COHORT_ISOLATED",
    input.prospectiveDecisionCount === 0,
    "The match must not have a PROSPECTIVE_SHADOW inclusion decision."
  );

  const orderedStages = [...input.chain]
    .sort((a, b) => a.sequenceNum - b.sequenceNum)
    .map((row) => row.stage);
  add(
    "CHAIN_COMPLETE_AND_VERIFIED",
    input.chainValid && orderedStages.length === EXPECTED_STAGES.length
      && EXPECTED_STAGES.every((stage, index) => orderedStages[index] === stage),
    "The immutable hash chain must contain exactly six ordered stages."
  );

  const fairStage = input.chain.find((row) => row.stage === "fair_odds");
  const entryStage = input.chain.find((row) => row.stage === "entry");
  const contextStage = input.chain.find((row) => row.stage === "context");
  const closingStage = input.chain.find((row) => row.stage === "closing");
  const resultStage = input.chain.find((row) => row.stage === "result");
  const clvStage = input.chain.find((row) => row.stage === "clv");
  const entry = input.evidence.find((row) => row.id === entryStage?.evidenceId);
  const closing = input.evidence.find((row) => row.id === closingStage?.evidenceId);

  const traceable = (row: ReplayEvidence | undefined) => Boolean(
    row
    && row.oddsSnapshotId
    && SHA256.test(row.rawPayloadHash)
    && row.snapshot
    && row.snapshot.id === row.oddsSnapshotId
    && row.snapshot.matchId === input.match.matchId
    && sameText(row.snapshot.providerName, row.providerName)
    && sameText(row.snapshot.bookmaker, row.bookmaker)
    && sameText(row.snapshot.marketType, row.marketType)
    && sameText(row.snapshot.selection, row.selection)
    && Math.abs(row.snapshot.odds - row.decimalOdds) <= 0.0001
    && sameInstant(row.snapshot.capturedAt, row.capturedAt)
  );
  add(
    "ODDS_EVIDENCE_TRACEABLE",
    Boolean(entry && closing && entry.id !== closing.id && traceable(entry) && traceable(closing)),
    "Entry and closing must point to distinct, field-matched odds snapshots with payload hashes."
  );

  const sourceCountNear = (anchor: ReplayEvidence | undefined) => {
    if (!anchor || !input.criteria) return 0;
    const toleranceMs = input.criteria.dualEvidenceToleranceMinutes * 60_000;
    const sources = new Set(
      input.evidence
        .filter((row) => row.marketType === anchor.marketType
          && row.selection === anchor.selection
          && Math.abs(time(row.capturedAt) - time(anchor.capturedAt)) <= toleranceMs
          && traceable(row))
        .map((row) => `${row.providerName}|${row.bookmaker}`)
    );
    return sources.size;
  };
  add(
    "DUAL_EVIDENCE_PRESENT",
    Boolean(entry && closing && sourceCountNear(entry) >= 2 && sourceCountNear(closing) >= 2),
    "Both entry and closing windows need two independently traceable provider/bookmaker sources."
  );

  const entryLead = entry ? (kickoff - time(entry.capturedAt)) / 60_000 : Number.NaN;
  add(
    "ENTRY_IN_POLICY_WINDOW",
    Boolean(input.criteria && Number.isFinite(entryLead)
      && entryLead >= 20 && entryLead <= 1440 && time(entry?.capturedAt) < kickoff),
    "Entry must be captured 20 to 1440 minutes before the event."
  );

  const closingLead = closing ? (kickoff - time(closing.capturedAt)) / 60_000 : Number.NaN;
  add(
    "CLOSING_CAPTURED_ON_TIME",
    Boolean(closing && closing.timingQuality === "CAPTURED_ON_TIME"
      && closingLead >= 3 && closingLead <= 10),
    "Closing must be verified in the 10-to-3-minute pre-event window."
  );

  const context = input.context;
  add(
    "CONTEXT_AS_OF_VERIFIED",
    Boolean(contextStage?.contextId && context
      && context.completeness === "complete"
      && context.captureMode === "HISTORICAL_REPLAY"
      && context.sourceUrl
      && context.sourcePayloadHash && SHA256.test(context.sourcePayloadHash)
      && context.sourcePublishedAt && context.sourceAsOfAt
      && time(context.sourcePublishedAt) <= time(context.sourceAsOfAt)
      && time(context.sourceAsOfAt) <= time(context.capturedAt)
      && time(context.capturedAt) < kickoff
      && context.replayVerifiedBy
      && context.noPostEventDataAttested),
    "Context needs pre-event source timestamps and an explicit no-post-event-data attestation."
  );

  const model = input.modelVersion;
  add(
    "WALK_FORWARD_CUTOFF_VALID",
    Boolean(model && fairStage?.modelVersionId === model.id && entry
      && model.sportSlug === input.match.sportSlug
      && SHA256.test(model.artifactSha256)
      && time(model.trainedAt) <= time(entry.capturedAt)
      && time(`${model.trainingCutoffDate.slice(0, 10)}T23:59:59.999Z`) <= time(entry.capturedAt)),
    "Model artifact, trained_at, and training cutoff must all precede historical entry."
  );

  const modelProbability = numberValue(fairStage?.value.model_predicted_prob);
  const marketProbability = numberValue(fairStage?.value.market_implied_prob);
  add(
    "FAIR_ODDS_VERSIONED",
    Boolean(fairStage?.modelQuoteId && input.criteria
      && fairStage.value.fair_odds_method_version === input.criteria.fairOddsMethodVersion
      && modelProbability > 0 && modelProbability < 1
      && marketProbability > 0 && marketProbability < 1),
    "Fair odds must be model-linked, probability-valid, and use the frozen method version."
  );

  const result = resultStage?.value ?? {};
  add(
    "FINAL_RESULT_VERIFIED",
    Boolean(resultStage
      && result.verified === true
      && typeof result.verified_by === "string" && result.verified_by.length > 0
      && Number.isFinite(time(String(result.verified_at ?? "")))
      && typeof result.source_url === "string" && result.source_url.length > 0
      && typeof result.source_payload_hash === "string" && SHA256.test(result.source_payload_hash)),
    "Final result requires verifier, verification timestamp, source URL, and payload hash."
  );

  const record = input.clvRecord;
  const expectedClv = record ? decimalPriceRatioClv(record.entryOdds, record.closingOdds) : Number.NaN;
  const stageClv = numberValue(clvStage?.value.clv_percent);
  add(
    "CLV_FORMULA_COHERENT",
    Boolean(record && entry && closing && clvStage
      && record.formulaVersion === FORECAST_CLV_FORMULA_VERSION
      && clvStage.value.clv_formula_version === FORECAST_CLV_FORMULA_VERSION
      && Math.abs(record.entryOdds - entry.decimalOdds) <= 0.0001
      && Math.abs(record.closingOdds - closing.decimalOdds) <= 0.0001
      && Math.abs(record.clvPercent - expectedClv) <= CLV_TOLERANCE
      && Math.abs(stageClv - expectedClv) <= CLV_TOLERANCE
      && record.chainVerified),
    "CLV must equal entry_odds / closing_odds - 1 under decimal_price_ratio_v1."
  );

  const assessment = input.assessment;
  add(
    "ASSESSMENT_HISTORICAL_ONLY",
    Boolean(assessment
      && assessment.cohort === "HISTORICAL_BACKTEST"
      && assessment.cleanEligible
      && !assessment.readyGateEligible
      && assessment.walkForwardPassed
      && assessment.reasons.length === 0),
    "The sample may be clean historical research, but can never be READY-gate eligible."
  );

  const blockingReasons = checks.filter((check) => !check.passed).map((check) => check.code);
  return {
    checklistVersion: HISTORICAL_REPLAY_CHECKLIST_VERSION,
    matchId: input.match.matchId,
    status: blockingReasons.length === 0 ? "PASS" : "BLOCKED",
    checks,
    blockingReasons
  };
}
