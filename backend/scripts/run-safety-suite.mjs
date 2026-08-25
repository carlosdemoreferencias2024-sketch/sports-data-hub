import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scripts = [
  ["typecheck", [process.execPath, "node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"], false],
  ["audit_guardrails", [process.execPath, "scripts/test-audit-guardrails.mjs"], false],
  ["closing_window", [process.execPath, "scripts/test-closing-window.mjs"], false],
  ["market_integrity_policy", [process.execPath, "scripts/test-market-integrity-policy.mjs"], false],
  ["clean_chain_e2e", [process.execPath, "scripts/test-clean-chain-e2e.mjs"], false],
  ["forecast_gate", [process.execPath, "scripts/test-forecast-gate.mjs"], false],
  ["historical_replay_validator", [process.execPath, "scripts/test-historical-replay-validator.mjs"], false],
  ["football_fair_odds_v3", [process.execPath, "scripts/test-football-fair-odds-model.mjs"], false],
  ["football_operational_contract", [process.execPath, "scripts/test-football-operational-contract.mjs"], false],
  ["nfl_operational_contract", [process.execPath, "scripts/test-nfl-operational-contract.mjs"], false],
  ["nfl_fair_odds", [process.execPath, "scripts/test-nfl-fair-odds-model.mjs"], false],
  ["nba_fair_odds", [process.execPath, "scripts/test-nba-fair-odds-model.mjs"], false],
  ["nba_operational_contract", [process.execPath, "scripts/test-nba-operational-contract.mjs"], false],
  ["candidate_preflight", [process.execPath, "scripts/test-candidate-preflight.mjs"], false],
  ["candidate_preflight_db", [process.execPath, "scripts/test-candidate-preflight-db.mjs"], false],
  ["scraper_import_guard", [process.execPath, "scripts/test-scraper-import-guard.mjs"], false],
  ["historical_replay_db", [process.execPath, "scripts/test-historical-replay-db.mjs"], false],
  ["forecast_inclusion_db", [process.execPath, "scripts/test-forecast-inclusion-db.mjs"], false],
  ["odds_snapshot_integrity", [process.execPath, "scripts/test-odds-snapshot-integrity.mjs"], false],
  ["source_capture_assistant", [process.execPath, "scripts/test-source-capture-assistant.mjs"], false],
  ["live_safe_mode", [process.execPath, "scripts/check-live-safe-mode.mjs"], false]
];

function runStep(name, command, shell = false) {
  return new Promise((resolve) => {
    const [bin, ...args] = command;
    const child = spawn(bin, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell
    });
    child.on("close", (code) => resolve({ name, code }));
  });
}

const startedAt = new Date().toISOString();
const results = [];
for (const [name, command, shell] of scripts) {
  console.log(`\n[safety-suite] ${name}`);
  results.push(await runStep(name, command, shell));
}

const failed = results.filter((result) => result.code !== 0);
const summary = {
  system_status: failed.length ? "SAFETY_SUITE_FAILED" : "SAFETY_SUITE_OK",
  cwd: path.resolve(process.cwd()),
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  results
};

async function writeReport(payload) {
  const preferred = process.env.SAFETY_SUITE_REPORT_PATH || path.resolve(process.cwd(), "uploads", "safety-suite", "latest.json");
  const fallback = path.join(os.tmpdir(), "sports-data-hub-safety-suite-latest.json");
  for (const target of [preferred, fallback]) {
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify({ ...payload, report_path: target }, null, 2), "utf8");
      return target;
    } catch {
      // Report persistence is helpful, but it must not turn a safe system into a failed suite.
    }
  }
  return null;
}

summary.report_path = await writeReport(summary);

console.log(JSON.stringify(summary, null, 2));

if (failed.length) process.exit(1);
