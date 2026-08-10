import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const backendRoot = process.cwd();
const tempCwd = await mkdtemp(path.join(tmpdir(), "source-capture-assistant-"));
const moduleUrl = pathToFileURL(path.resolve(backendRoot, "dist/trading/source-capture-assistant.js")).href;
const { recordSourceCaptureAssistantEvidence, getSourceCaptureAssistantRules } = await import(moduleUrl);

const db = {
  async query(sql, values = []) {
    if (String(sql).includes("FROM matches")) {
      return {
        rows: [{
          id: values[0],
          match_date: "2026-07-29T22:30:00.000Z",
          home_team_name: "Home",
          away_team_name: "Away"
        }]
      };
    }
    return { rows: [] };
  }
};

try {
  process.chdir(tempCwd);

  const rules = getSourceCaptureAssistantRules();
  assert.equal(rules.guardrails.real_candidate_count, 0);
  assert.equal(rules.guardrails.real_money_enabled, false);
  assert.equal(rules.guardrails.kelly_enabled, false);
  assert.equal(rules.guardrails.telegram_auto_enabled, false);
  assert.equal(rules.guardrails.auto_post_allowed, false);
  assert.ok(rules.rules.some((rule) => rule.includes("never posts manual_verified automatically")));
  assert.ok(rules.rules.some((rule) => rule.includes("365Scores/Flashscore")));

  const unsafeMarket = await recordSourceCaptureAssistantEvidence(db, {
    match_id: "99857e9b-d4ce-5af1-9f22-afcec3fc6676",
    sport: "soccer",
    capture_type: "closing_odds",
    source_name: "flashscore_manual_verified",
    source_url: "manual_verified_screen",
    verified_by: "Carlos",
    captured_at: "2026-07-29T22:24:00.000Z",
    data: { market: "moneyline_3way", selection: "home", closing_odds: 3.8 }
  });
  assert.equal(unsafeMarket.applied, false);
  assert.equal(unsafeMarket.evidence_status, "REJECTED_UNSAFE_SOURCE");
  assert.match(unsafeMarket.reason, /market_odds_require_sportsbook_or_authorized_market_source/);
  assert.equal(unsafeMarket.guardrails.auto_post_allowed, false);

  const unsafeMlbOfficialOdds = await recordSourceCaptureAssistantEvidence(db, {
    match_id: "99857e9b-d4ce-5af1-9f22-afcec3fc6676",
    sport: "baseball",
    capture_type: "current_odds",
    source_name: "mlb_official_manual_verified",
    source_url: "https://www.mlb.com/es",
    verified_by: "Carlos",
    captured_at: "2026-07-29T22:24:00.000Z",
    data: { market: "moneyline_2way", selection: "home", odds: 2.1 }
  });
  assert.equal(unsafeMlbOfficialOdds.applied, false);
  assert.match(unsafeMlbOfficialOdds.reason, /mlb_official_cannot_provide_market_odds/);

  const tooEarlyClosing = await recordSourceCaptureAssistantEvidence(db, {
    match_id: "99857e9b-d4ce-5af1-9f22-afcec3fc6676",
    sport: "soccer",
    capture_type: "closing_odds",
    source_name: "sportsbook_manual_verified",
    source_url: "manual_verified_screen",
    verified_by: "Carlos",
    captured_at: "2026-07-29T22:19:59.999Z",
    visible_text: "Visible market quote before the valid window",
    data: { market: "moneyline_3way", selection: "home", closing_odds: 3.8 }
  });
  assert.equal(tooEarlyClosing.applied, true);
  assert.equal(tooEarlyClosing.safe_to_post_now, false);
  assert.equal(tooEarlyClosing.closing_quality, "CAPTURED_TOO_EARLY");
  assert.equal(tooEarlyClosing.auto_posted, false);
  assert.equal(tooEarlyClosing.picks_created, 0);
  assert.equal(tooEarlyClosing.real_candidate, 0);

  const onTimeClosing = await recordSourceCaptureAssistantEvidence(db, {
    match_id: "99857e9b-d4ce-5af1-9f22-afcec3fc6676",
    sport: "soccer",
    capture_type: "closing_odds",
    source_name: "sportsbook_manual_verified",
    source_url: "manual_verified_screen",
    verified_by: "Carlos",
    captured_at: "2026-07-29T22:24:00.000Z",
    visible_text: "Visible on-time market quote",
    data: { market: "moneyline_3way", selection: "home", closing_odds: 3.8 }
  });
  assert.equal(onTimeClosing.applied, true);
  assert.equal(onTimeClosing.safe_to_post_now, true);
  assert.equal(onTimeClosing.closing_quality, "CAPTURED_ON_TIME");
  assert.equal(onTimeClosing.auto_posted, false);
  assert.equal(onTimeClosing.picks_created, 0);
  assert.equal(onTimeClosing.real_candidate, 0);
  assert.ok(onTimeClosing.evidence_id);
  assert.ok(onTimeClosing.evidence_path);
} finally {
  process.chdir(backendRoot);
  await rm(tempCwd, { recursive: true, force: true });
}

console.log("source capture assistant safety tests ok");
