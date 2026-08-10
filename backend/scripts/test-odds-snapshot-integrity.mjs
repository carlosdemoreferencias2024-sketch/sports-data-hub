import assert from "node:assert/strict";
import { recordManualOddsSnapshot } from "../dist/trading/odds-snapshot-cache.js";

function mockDb() {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (sql.includes("FROM matches m")) {
        return { rows: [{ match_id: "match-1", kickoff: "2026-08-10T23:00:00.000Z", status: "scheduled", league_slug: "mlb", sport_slug: "baseball" }] };
      }
      if (sql.includes("INSERT INTO market_quotes")) return { rows: [{ id: "market-quote-1" }] };
      if (sql.includes("INSERT INTO odds_snapshots")) return { rows: [{ snapshot_id: "snapshot-1" }] };
      return { rows: [] };
    }
  };
}

const base = {
  match_id: "match-1",
  market: "moneyline_2way",
  selection: "home",
  odds: 2.1,
  bookmaker: "Example Book",
  source_name: "sportsbook_manual_verified",
  source_url: "manual_verified_screen",
  captured_at: "2026-08-10T21:00:00.000Z",
  expires_at: "2026-08-10T22:00:00.000Z",
  verified_by: "Carlos",
  snapshot_type: "entry"
};

const withoutEvidenceDb = mockDb();
const withoutEvidence = await recordManualOddsSnapshot(withoutEvidenceDb, base);
assert.equal(withoutEvidence.safe_for_entry, false);
assert.equal(withoutEvidence.market_quote_id, null);
assert.equal(withoutEvidenceDb.calls.some((sql) => sql.includes("INSERT INTO market_quotes")), false);

const withEvidenceDb = mockDb();
const withEvidence = await recordManualOddsSnapshot(withEvidenceDb, {
  ...base,
  evidence_id: "evidence-1",
  screenshot_sha256: "c".repeat(64)
});
assert.equal(withEvidence.safe_for_entry, true);
assert.equal(withEvidence.market_quote_id, "market-quote-1");
assert.equal(withEvidenceDb.calls.some((sql) => sql.includes("INSERT INTO market_quotes")), true);

console.log("odds snapshot integrity tests ok");
