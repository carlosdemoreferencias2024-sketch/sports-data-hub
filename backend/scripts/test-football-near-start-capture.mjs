import assert from "node:assert/strict";
import { normalizeApiFootballNearStartPayloads } from "../dist/trading/football-data-gateway.js";

const starters = (prefix) => [
  { player: { id: 1, name: `${prefix} GK`, pos: "G" } },
  ...Array.from({ length: 10 }, (_, index) => ({
    player: { id: index + 2, name: `${prefix} Player ${index + 1}`, pos: "D" }
  }))
];

const lineupsPayload = {
  errors: [],
  response: [
    { team: { id: 10, name: "Valencia" }, formation: "4-4-2", startXI: starters("Valencia") },
    { team: { id: 20, name: "Real Betis" }, formation: "4-2-3-1", startXI: starters("Betis") }
  ]
};

const withAbsences = normalizeApiFootballNearStartPayloads({
  homeTeam: "Valencia",
  awayTeam: "Real Betis",
  lineupsPayload,
  injuriesPayload: {
    errors: [],
    response: [
      { team: { id: 10, name: "Valencia" }, player: { id: 31, name: "Injured Player", type: "Hamstring", reason: "Out" } },
      { team: { id: 20, name: "Real Betis" }, player: { id: 32, name: "Suspended Player", type: "Suspended", reason: "Red card" } }
    ]
  }
});

assert.equal(withAbsences.lineup_status, "CONFIRMED");
assert.equal(withAbsences.goalkeeper_status, "CONFIRMED");
assert.equal(withAbsences.availability_status, "CONFIRMED");
assert.deepEqual(withAbsences.injuries, ["Injured Player"]);
assert.deepEqual(withAbsences.suspensions, ["Suspended Player"]);
assert.equal(withAbsences.unavailable_players.length, 2);

const emptyOfficialReport = normalizeApiFootballNearStartPayloads({
  homeTeam: "Valencia",
  awayTeam: "Real Betis",
  lineupsPayload,
  injuriesPayload: { errors: [], response: [] }
});

assert.equal(emptyOfficialReport.availability_status, "CONFIRMED");
assert.equal(emptyOfficialReport.source_integrity.empty_availability_report_is_valid, true);
assert.deepEqual(emptyOfficialReport.unavailable_players, []);

const unavailableReport = normalizeApiFootballNearStartPayloads({
  homeTeam: "Valencia",
  awayTeam: "Real Betis",
  lineupsPayload,
  injuriesPayload: { errors: { plan: "blocked" }, response: [] }
});

assert.equal(unavailableReport.availability_status, "SOURCE_UNAVAILABLE");
assert.equal(unavailableReport.source_integrity.availability_payload_valid, false);

console.log("football near-start official context tests: ok");
