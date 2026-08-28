import assert from "node:assert/strict";
import { calendarProviderIdentity } from "../dist/trading/football-today-universe.js";

assert.deepEqual(
  calendarProviderIdentity({ source_match_id: "espn-liga-mx-401877000" }),
  { providerName: "espn-soccer", providerEventId: "401877000" }
);
assert.deepEqual(
  calendarProviderIdentity({ espn_event_id: "401877001" }),
  { providerName: "espn-soccer", providerEventId: "401877001" }
);
assert.deepEqual(
  calendarProviderIdentity({ api_football_fixture_id: 123456 }),
  { providerName: "api-football", providerEventId: "123456" }
);
assert.equal(calendarProviderIdentity({ source_match_id: "manual-fixture" }), null);
assert.equal(calendarProviderIdentity({ source_match_id: "espn-liga-mx-not-a-number" }), null);

console.log("football calendar provider identity tests passed");
