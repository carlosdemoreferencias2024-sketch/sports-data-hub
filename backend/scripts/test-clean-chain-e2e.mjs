import assert from "node:assert/strict";
import {
  computeClvEligibility,
  validateCleanSampleEligibility,
  validateClosingSnapshot,
  validateEntrySnapshot,
  validateSettlementEligibility
} from "../dist/trading/market-integrity-policy.js";

const shared = {
  kickoff: "2026-08-10T23:00:00.000Z",
  sourceName: "sportsbook_manual_verified",
  evidenceId: "evidence-e2e",
  screenshotSha256: "b".repeat(64),
  canonicalMatch: true,
  duplicate: false
};

const entry = validateEntrySnapshot({ ...shared, capturedAt: "2026-08-10T21:00:00.000Z", snapshotType: "entry", staleStatus: "FRESH", safeForEntry: true });
const closing = validateClosingSnapshot({ ...shared, capturedAt: "2026-08-10T22:53:00.000Z", snapshotType: "closing", safeForClosing: true });
const settlement = validateSettlementEligibility({ entry, closing, resultFinal: true, resultSourceVerified: true });
const clv = computeClvEligibility({ entry, closing, resultFinal: true, resultSourceVerified: true, settlementFinal: true });
const clean = validateCleanSampleEligibility({ entry, closing, resultFinal: true, resultSourceVerified: true, settlementFinal: true, clvValid: clv.eligible });
assert.equal(clean.eligible, true, "the complete AND chain is clean v2");

for (const invalidClosing of [
  validateClosingSnapshot({ ...shared, capturedAt: "2026-08-10T23:01:00.000Z", snapshotType: "closing", safeForClosing: true }),
  validateClosingSnapshot({ ...shared, capturedAt: "2026-08-10T22:40:00.000Z", snapshotType: "closing", safeForClosing: true }),
  validateClosingSnapshot({ ...shared, capturedAt: "2026-08-10T22:53:00.000Z", snapshotType: "entry", safeForClosing: true })
]) {
  assert.equal(validateSettlementEligibility({ entry, closing: invalidClosing, resultFinal: true, resultSourceVerified: true }).eligible, false);
}

assert.equal(validateEntrySnapshot({ ...shared, evidenceId: null, capturedAt: "2026-08-10T21:00:00.000Z", snapshotType: "entry", staleStatus: "FRESH", safeForEntry: true }).eligible, false);
assert.equal(validateEntrySnapshot({ ...shared, duplicate: true, capturedAt: "2026-08-10T21:00:00.000Z", snapshotType: "entry", staleStatus: "FRESH", safeForEntry: true }).eligible, false);
console.log("clean chain e2e tests ok");
