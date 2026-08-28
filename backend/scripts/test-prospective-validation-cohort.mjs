import assert from "node:assert/strict";
import {
  getLeagueValidationPolicy,
  prospectiveMilestone
} from "../dist/trading/prospective-validation-cohort.js";

const ligaMx = getLeagueValidationPolicy("liga-mx");
assert.equal(ligaMx.researchAllowed, true);
assert.equal(ligaMx.shadowAllowed, true);
assert.equal(ligaMx.paperAllowed, false);
assert.equal(ligaMx.realAllowed, false);

assert.deepEqual(prospectiveMilestone(0), { current: 0, next: 20, label: "BUILD_FIRST_CLEAN_CHAINS" });
assert.equal(prospectiveMilestone(20).next, 50);
assert.equal(prospectiveMilestone(50).next, 100);
assert.equal(prospectiveMilestone(100).next, 250);
assert.equal(prospectiveMilestone(250).next, null);

console.log("prospective validation cohort tests passed");
