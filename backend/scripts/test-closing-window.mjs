import assert from "node:assert/strict";
import {
  closingWindowDiagnostics,
  closingWindowStatusNow,
  tradingLocalDateWindow
} from "../dist/trading/timezone.js";

const kickoff = "2026-07-29T22:30:00.000Z";

assert.equal(
  closingWindowDiagnostics("2026-07-29T22:20:00.000Z", kickoff).closing_quality,
  "CAPTURED_ON_TIME",
  "exactly 10 minutes before kickoff is on-time"
);

assert.equal(
  closingWindowDiagnostics("2026-07-29T22:27:00.000Z", kickoff).closing_quality,
  "CAPTURED_ON_TIME",
  "exactly 3 minutes before kickoff is on-time"
);

assert.equal(
  closingWindowDiagnostics("2026-07-29T22:19:59.999Z", kickoff).closing_quality,
  "CAPTURED_TOO_EARLY",
  "one millisecond before the window is too early"
);

assert.equal(
  closingWindowDiagnostics("2026-07-29T22:27:00.001Z", kickoff).closing_quality,
  "CAPTURED_LATE",
  "one millisecond after the window is late"
);

assert.equal(
  closingWindowDiagnostics("invalid-string", null).closing_quality,
  "INVALID_CAPTURE_TIMESTAMP",
  "invalid capture timestamp wins when both capture and kickoff are bad"
);

assert.equal(
  closingWindowDiagnostics("2026-07-29T22:24:00.000Z", null).closing_quality,
  "MISSING_KICKOFF",
  "missing kickoff is explicit"
);

assert.equal(
  closingWindowDiagnostics("2026-07-29T22:24:00.000Z", "not-a-date").closing_quality,
  "INVALID_KICKOFF_TIMESTAMP",
  "invalid kickoff timestamp is explicit"
);

assert.equal(
  closingWindowStatusNow(kickoff, new Date("2026-07-29T22:20:00.000Z")).current_status,
  "IN_VALID_CLOSING_WINDOW",
  "watch status enters on exact window start"
);

assert.equal(
  closingWindowStatusNow(kickoff, new Date("2026-07-29T22:27:00.000Z")).current_status,
  "IN_VALID_CLOSING_WINDOW",
  "watch status stays valid on exact window end"
);

assert.equal(
  closingWindowStatusNow(kickoff, new Date("2026-07-29T22:19:59.999Z")).current_status,
  "WAITING_WINDOW",
  "watch status does not round early into the window"
);

assert.equal(
  closingWindowStatusNow(kickoff, new Date("2026-07-29T22:27:00.001Z")).current_status,
  "MISSED_WINDOW",
  "watch status does not round late into the window"
);

const springForward = tradingLocalDateWindow("2026-03-08");
assert.equal(
  (new Date(springForward.end).getTime() - new Date(springForward.start).getTime()) / 3600000,
  23,
  "America/Matamoros spring-forward local day is 23 hours"
);

const fallBack = tradingLocalDateWindow("2026-11-01");
assert.equal(
  (new Date(fallBack.end).getTime() - new Date(fallBack.start).getTime()) / 3600000,
  25,
  "America/Matamoros fall-back local day is 25 hours"
);

console.log("closing window tests ok");
