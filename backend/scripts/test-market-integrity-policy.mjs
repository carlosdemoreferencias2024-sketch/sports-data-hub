import assert from "node:assert/strict";
import {
  validateCleanSampleEligibility,
  validateClosingSnapshot,
  validateEntrySnapshot,
  validateSettlementEligibility
} from "../dist/trading/market-integrity-policy.js";

const base = {
  kickoff: "2026-08-10T23:00:00.000Z",
  sourceName: "sportsbook_manual_verified",
  evidenceId: "evidence-1",
  screenshotSha256: "a".repeat(64),
  canonicalMatch: true,
  duplicate: false
};

const entry = validateEntrySnapshot({
  ...base,
  capturedAt: "2026-08-10T21:00:00.000Z",
  snapshotType: "entry",
  staleStatus: "FRESH",
  safeForEntry: true
});
assert.equal(entry.eligible, true);

assert.equal(validateEntrySnapshot({ ...base, capturedAt: "2026-08-10T21:00:00.000Z", snapshotType: "entry", staleStatus: "FRESH", safeForEntry: true, evidenceId: null }).eligible, false);
assert.equal(validateEntrySnapshot({ ...base, capturedAt: "2026-08-10T23:00:00.000Z", snapshotType: "entry", staleStatus: "FRESH", safeForEntry: true }).reasons.includes("ENTRY_NOT_PREGAME"), true);

const closing = validateClosingSnapshot({
  ...base,
  capturedAt: "2026-08-10T22:53:00.000Z",
  snapshotType: "closing",
  safeForClosing: true
});
assert.equal(closing.eligible, true);
assert.equal(closing.closing_quality, "CAPTURED_ON_TIME");

assert.equal(validateClosingSnapshot({ ...base, capturedAt: "2026-08-10T22:49:00.000Z", snapshotType: "closing", safeForClosing: true }).eligible, false);
assert.equal(validateClosingSnapshot({ ...base, capturedAt: "2026-08-10T22:53:00.000Z", snapshotType: "closing", safeForClosing: false }).eligible, false);

const settlement = validateSettlementEligibility({
  entry,
  closing,
  resultFinal: true,
  resultSourceVerified: true
});
assert.equal(settlement.eligible, true);
assert.equal(validateSettlementEligibility({ entry, closing, resultFinal: true, resultSourceVerified: false }).eligible, false);

assert.equal(validateCleanSampleEligibility({ entry, closing, resultFinal: true, resultSourceVerified: true, settlementFinal: true, clvValid: true }).eligible, true);
assert.equal(validateCleanSampleEligibility({ entry, closing, resultFinal: true, resultSourceVerified: true, settlementFinal: true, clvValid: false }).eligible, false);

console.log("market integrity policy tests ok");
