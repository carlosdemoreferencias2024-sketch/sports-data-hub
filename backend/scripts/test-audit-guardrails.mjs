import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("src/modules/model-quotes/audit-guardrails.ts", "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const auditModuleUrl = "data:text/javascript;base64," + Buffer.from(transpiled).toString("base64");
const { auditParlayLegs, auditSelection } = await import(auditModuleUrl);

const shadowPick = auditSelection({
  provider_name: "manual_shadow_mlb",
  processed: false,
  market_type: "moneyline_2way",
  market_selection: "home",
  market_odds: 2.1,
  model_fair_odds: 1.8,
  model_probability: 0.56
});
assert.equal(shadowPick.audit_status, "RADAR_ONLY");
assert.equal(shadowPick.allow_real_bet, false);

const unprocessedRealProvider = auditSelection({
  provider_name: "pinnacle",
  processed: false,
  market_type: "moneyline_2way",
  market_selection: "home",
  market_odds: 2.1,
  model_fair_odds: 1.8,
  model_probability: 0.56
});
assert.notEqual(unprocessedRealProvider.audit_status, "REAL_CANDIDATE");
assert.equal(unprocessedRealProvider.allow_real_bet, false);

const realPaperCandidate = auditSelection({
  provider_name: "pinnacle",
  processed: true,
  sport_slug: "baseball",
  league_slug: "mlb",
  market_type: "moneyline_2way",
  market_selection: "home",
  market_odds: 2.0,
  model_fair_odds: 1.8182,
  model_probability: 0.55
});
assert.equal(realPaperCandidate.audit_status, "REAL_PAPER_CANDIDATE");
assert.equal(realPaperCandidate.allow_real_bet, false);
assert.equal(realPaperCandidate.allow_real_paper, true);

const realCandidate = auditSelection({
  provider_name: "pinnacle",
  processed: true,
  sport_slug: "baseball",
  league_slug: "mlb",
  market_type: "moneyline_2way",
  market_selection: "home",
  market_odds: 2.0,
  model_fair_odds: 1.8182,
  model_probability: 0.55,
  enable_real_betting: true
});
assert.equal(realCandidate.audit_status, "REAL_CANDIDATE");
assert.equal(realCandidate.allow_real_bet, true);

const lowEvRealPaperMiss = auditSelection({
  provider_name: "pinnacle",
  processed: true,
  sport_slug: "baseball",
  league_slug: "mlb",
  market_type: "moneyline_2way",
  market_selection: "home",
  market_odds: 1.9,
  model_fair_odds: 1.8868,
  model_probability: 0.53
});
assert.equal(lowEvRealPaperMiss.audit_status, "NO_BET");
assert.equal(lowEvRealPaperMiss.review_type, "LOW_EV");
assert.equal(lowEvRealPaperMiss.allow_real_paper, false);

const lowModelProbRealPaperMiss = auditSelection({
  provider_name: "pinnacle",
  processed: true,
  sport_slug: "baseball",
  league_slug: "mlb",
  market_type: "moneyline_2way",
  market_selection: "home",
  market_odds: 2.1,
  model_fair_odds: 1.9608,
  model_probability: 0.51
});
assert.equal(lowModelProbRealPaperMiss.audit_status, "NO_BET");
assert.equal(lowModelProbRealPaperMiss.review_type, "LOW_MODEL_PROB");
assert.equal(lowModelProbRealPaperMiss.allow_real_paper, false);

const oddsOutOfRangeRealPaperMiss = auditSelection({
  provider_name: "pinnacle",
  processed: true,
  sport_slug: "baseball",
  league_slug: "mlb",
  market_type: "moneyline_2way",
  market_selection: "home",
  market_odds: 4.8,
  model_fair_odds: 1.8868,
  model_probability: 0.53
});
assert.equal(oddsOutOfRangeRealPaperMiss.audit_status, "NO_BET");
assert.equal(oddsOutOfRangeRealPaperMiss.review_type, "ODDS_OUT_OF_RANGE");
assert.equal(oddsOutOfRangeRealPaperMiss.allow_real_paper, false);

const suspiciousRunLine = auditSelection({
  provider_name: "pinnacle",
  processed: true,
  market_type: "run_line",
  market_selection: "away",
  line: 1.5,
  market_odds: 4.0,
  model_fair_odds: 2.2,
  model_probability: 0.45
});
assert.equal(suspiciousRunLine.audit_status, "REVIEW");
assert.ok(["ODDS_OUTLIER", "HANDICAP_SUSPICIOUS"].includes(suspiciousRunLine.review_type));
assert.equal(suspiciousRunLine.allow_real_bet, false);

const suspiciousNegativeRunLine = auditSelection({
  provider_name: "pinnacle",
  processed: true,
  market_type: "run_line",
  market_selection: "home",
  line: -1.5,
  market_odds: 7.0,
  model_fair_odds: 2.0,
  model_probability: 0.5
});
assert.equal(suspiciousNegativeRunLine.audit_status, "REVIEW");
assert.ok(["ODDS_OUTLIER", "HANDICAP_SUSPICIOUS"].includes(suspiciousNegativeRunLine.review_type));
assert.equal(suspiciousNegativeRunLine.allow_real_bet, false);

const staleRealPick = auditSelection({
  provider_name: "pinnacle",
  processed: true,
  market_type: "moneyline_2way",
  market_selection: "home",
  market_odds: 2.0,
  model_fair_odds: 1.8182,
  model_probability: 0.55,
  age_seconds: 901
});
assert.equal(staleRealPick.audit_status, "REVIEW");
assert.equal(staleRealPick.review_type, "STALE_ODDS");
assert.equal(staleRealPick.allow_real_bet, false);

const staleShadowPick = auditSelection({
  provider_name: "manual_shadow_mlb",
  processed: false,
  market_type: "moneyline_2way",
  market_selection: "home",
  market_odds: 2.0,
  model_fair_odds: 1.8182,
  model_probability: 0.55,
  age_seconds: 5000
});
assert.equal(staleShadowPick.audit_status, "RADAR_ONLY");
assert.equal(staleShadowPick.allow_real_bet, false);

const diagnosticRunLineShadow = auditSelection({
  provider_name: "manual_shadow_mlb_runline",
  processed: false,
  market_type: "run_line",
  market_selection: "away",
  line: 1.5,
  market_odds: 2.2,
  model_fair_odds: 2.0,
  model_probability: 0.5
});
assert.equal(diagnosticRunLineShadow.audit_status, "RADAR_ONLY");
assert.equal(diagnosticRunLineShadow.allow_real_bet, false);

const disabledRealRunLine = auditSelection({
  provider_name: "pinnacle",
  processed: true,
  sport_slug: "baseball",
  league_slug: "mlb",
  market_type: "run_line",
  market_selection: "home",
  line: 0.5,
  market_odds: 2.0,
  model_fair_odds: 1.8182,
  model_probability: 0.55,
  enable_real_runline: false
});
assert.equal(disabledRealRunLine.audit_status, "REVIEW");
assert.equal(disabledRealRunLine.review_type, "RUN_LINE_DISABLED");
assert.equal(disabledRealRunLine.allow_real_bet, false);

const enabledRealRunLine = auditSelection({
  provider_name: "pinnacle",
  processed: true,
  sport_slug: "baseball",
  league_slug: "mlb",
  market_type: "run_line",
  market_selection: "home",
  line: 0.5,
  market_odds: 2.0,
  model_fair_odds: 1.8182,
  model_probability: 0.55,
  enable_real_runline: true
});
assert.equal(enabledRealRunLine.audit_status, "NO_BET");
assert.equal(enabledRealRunLine.allow_real_bet, false);

const disabledRealTotals = auditSelection({
  provider_name: "pinnacle",
  processed: true,
  sport_slug: "baseball",
  league_slug: "mlb",
  market_type: "total_runs",
  market_selection: "over",
  line: 8.5,
  market_odds: 2.0,
  model_fair_odds: 1.8182,
  model_probability: 0.55
});
assert.equal(disabledRealTotals.audit_status, "REVIEW");
assert.equal(disabledRealTotals.review_type, "REAL_PAPER_DISABLED");

const parlayAudit = auditParlayLegs([
  { provider_name: "pinnacle", processed: true, allow_real_bet: true },
  { provider_name: "manual_shadow_worldcup", processed: false, allow_real_bet: false }
]);
assert.equal(parlayAudit.status, "radar");
assert.equal(parlayAudit.real_bet_allowed, false);

console.log("✅ audit guardrails passed");
