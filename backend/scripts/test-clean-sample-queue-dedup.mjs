import assert from "node:assert/strict";
import { deduplicateOperationalFixtureRows } from "../dist/trading/clean-sample-queue.js";

const kickoff = "2026-08-29T01:00:00Z";
const rows = [
  {
    match_id: "raw-only",
    sport: "soccer",
    league: "liga-mx",
    match: "Cruz Azul @ Necaxa",
    kickoff,
    calendar_trusted: false,
    model_quote_id: null
  },
  {
    match_id: "espn-owner",
    sport: "soccer",
    league: "liga-mx",
    match: "Cruz Azul @ Necaxa",
    kickoff,
    calendar_trusted: true,
    calendar_provider_name: "espn-soccer",
    model_quote_id: "espn-model"
  },
  {
    match_id: "api-owner",
    sport: "soccer",
    league: "liga-mx",
    match: "Cruz Azul @ Necaxa",
    kickoff,
    calendar_trusted: true,
    calendar_provider_name: "api-football",
    model_quote_id: "api-model"
  }
];

const deduplicated = deduplicateOperationalFixtureRows(rows);
assert.equal(deduplicated.length, 1);
assert.equal(deduplicated[0].match_id, "api-owner");
assert.equal(deduplicated[0].duplicate_fixture_rows_suppressed, 2);
assert.deepEqual(deduplicated[0].suppressed_match_ids.sort(), ["espn-owner", "raw-only"]);

const progressedEspn = deduplicateOperationalFixtureRows([
  rows[1],
  { ...rows[2], entry_evidence_id: null },
  { ...rows[1], match_id: "espn-progressed", entry_evidence_id: "evidence" }
]);
assert.equal(progressedEspn[0].match_id, "espn-progressed");

console.log("clean sample queue fixture dedup tests passed");
