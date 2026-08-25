import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  decimalPriceRatioClv,
  validateHistoricalReplay
} from "../dist/trading/historical-replay-validator.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const matchId = "11111111-1111-4111-8111-111111111111";
const kickoff = "2026-07-01T20:00:00.000Z";

function evidence(id, provider, bookmaker, odds, capturedAt, timingQuality = "CAPTURED_ON_TIME") {
  const snapshotId = id.replace(/^e/, "a");
  return {
    id,
    oddsSnapshotId: snapshotId,
    providerName: provider,
    bookmaker,
    marketType: "moneyline_2way",
    selection: "home",
    decimalOdds: odds,
    capturedAt,
    timingQuality,
    rawPayloadHash: hash(id),
    snapshot: {
      id: snapshotId,
      matchId,
      providerName: provider,
      bookmaker,
      marketType: "moneyline_2way",
      selection: "home",
      odds,
      capturedAt
    }
  };
}

function passingFixture() {
  const entryOdds = 2.05;
  const closingOdds = 1.95;
  const clv = decimalPriceRatioClv(entryOdds, closingOdds);
  return {
    match: { matchId, sportSlug: "baseball", status: "finished", scheduledStart: kickoff },
    criteria: {
      cohort: "HISTORICAL_BACKTEST",
      requireContextComplete: true,
      requireDualEvidence: true,
      dualEvidenceToleranceMinutes: 10,
      fairOddsMethodVersion: "owned_fair_odds_v1"
    },
    historicalDecision: { decision: "INCLUDED", reasons: [] },
    prospectiveDecisionCount: 0,
    chainValid: true,
    chain: [
      {
        id: "c1", stage: "fair_odds", sequenceNum: 1,
        modelVersionId: "m1", modelQuoteId: "q1",
        value: {
          model_predicted_prob: 0.53,
          market_implied_prob: 0.5,
          fair_odds_method_version: "owned_fair_odds_v1"
        }
      },
      { id: "c2", stage: "entry", sequenceNum: 2, evidenceId: "e1", value: { decimal_odds: entryOdds } },
      { id: "c3", stage: "context", sequenceNum: 3, contextId: "x1", value: {} },
      { id: "c4", stage: "closing", sequenceNum: 4, evidenceId: "e3", value: { decimal_odds: closingOdds } },
      {
        id: "c5", stage: "result", sequenceNum: 5,
        value: {
          result: "win",
          verified: true,
          verified_by: "manual-reviewer",
          verified_at: "2026-07-01T23:30:00.000Z",
          source_url: "https://example.test/final",
          source_payload_hash: hash("final")
        }
      },
      {
        id: "c6", stage: "clv", sequenceNum: 6,
        value: { clv_percent: clv, clv_formula_version: "decimal_price_ratio_v1" }
      }
    ],
    evidence: [
      evidence("e1", "provider_a", "book_a", entryOdds, "2026-07-01T18:30:00.000Z"),
      evidence("e2", "provider_b", "book_b", 2.04, "2026-07-01T18:32:00.000Z"),
      evidence("e3", "provider_a", "book_a", closingOdds, "2026-07-01T19:54:00.000Z"),
      evidence("e4", "provider_b", "book_b", 1.96, "2026-07-01T19:55:00.000Z")
    ],
    context: {
      completeness: "complete",
      captureMode: "HISTORICAL_REPLAY",
      capturedAt: "2026-07-01T19:15:00.000Z",
      sourceUrl: "https://example.test/context",
      sourcePayloadHash: hash("context"),
      sourcePublishedAt: "2026-07-01T19:00:00.000Z",
      sourceAsOfAt: "2026-07-01T19:10:00.000Z",
      replayVerifiedBy: "manual-reviewer",
      noPostEventDataAttested: true
    },
    modelVersion: {
      id: "m1",
      sportSlug: "baseball",
      trainingCutoffDate: "2026-06-28",
      trainedAt: "2026-06-29T05:00:00.000Z",
      artifactSha256: hash("model")
    },
    clvRecord: {
      entryOdds,
      closingOdds,
      clvPercent: clv,
      formulaVersion: "decimal_price_ratio_v1",
      chainVerified: true
    },
    assessment: {
      cohort: "HISTORICAL_BACKTEST",
      cleanEligible: true,
      readyGateEligible: false,
      walkForwardPassed: true,
      reasons: []
    }
  };
}

const pass = validateHistoricalReplay(passingFixture());
assert.equal(pass.status, "PASS", JSON.stringify(pass.blockingReasons));
assert.deepEqual(pass.blockingReasons, []);

const leakedContext = structuredClone(passingFixture());
leakedContext.context.sourceAsOfAt = "2026-07-01T20:10:00.000Z";
assert.ok(validateHistoricalReplay(leakedContext).blockingReasons.includes("CONTEXT_AS_OF_VERIFIED"));

const mixedCohort = structuredClone(passingFixture());
mixedCohort.prospectiveDecisionCount = 1;
assert.ok(validateHistoricalReplay(mixedCohort).blockingReasons.includes("COHORT_ISOLATED"));

const leakedModel = structuredClone(passingFixture());
leakedModel.modelVersion.trainedAt = "2026-07-02T05:00:00.000Z";
assert.ok(validateHistoricalReplay(leakedModel).blockingReasons.includes("WALK_FORWARD_CUTOFF_VALID"));

const inventedClosing = structuredClone(passingFixture());
inventedClosing.evidence.find((row) => row.id === "e3").snapshot = null;
assert.ok(validateHistoricalReplay(inventedClosing).blockingReasons.includes("ODDS_EVIDENCE_TRACEABLE"));

const wrongClv = structuredClone(passingFixture());
wrongClv.clvRecord.clvPercent = 0.123;
assert.ok(validateHistoricalReplay(wrongClv).blockingReasons.includes("CLV_FORMULA_COHERENT"));

console.log("historical replay validator tests ok");
