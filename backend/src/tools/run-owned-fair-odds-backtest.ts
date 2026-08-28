import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import {
  runOwnedFairOddsBacktest,
  type BacktestMode,
  type BacktestSport
} from "../trading/owned-fair-odds-backtest.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
config({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(moduleDirectory, "../../../.env") });
config({ path: path.resolve(process.cwd(), ".env") });
config();

const { Client } = pg;
const args = process.argv.slice(2);
const valueOf = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const selectedSport = valueOf("--sport") || "all";
const sports: BacktestSport[] = selectedSport === "all"
  ? ["soccer", "nfl", "nba"]
  : [selectedSport as BacktestSport];
const mode = (valueOf("--mode") || "persisted") as BacktestMode;
const validSports = new Set(["soccer", "nfl", "nba"]);
const validModes = new Set(["persisted", "event-time", "ingested-time"]);
if (sports.some((sport) => !validSports.has(sport))) {
  throw new Error("--sport debe ser soccer, nfl, nba o all");
}
if (!validModes.has(mode)) {
  throw new Error("--mode debe ser persisted, event-time o ingested-time");
}
const from = valueOf("--from") || "2025-01-01T00:00:00Z";
const to = valueOf("--to") || new Date().toISOString();
if (Number.isNaN(new Date(from).getTime()) || Number.isNaN(new Date(to).getTime())) {
  throw new Error("--from y --to deben ser fechas ISO validas");
}
const limit = Number(valueOf("--limit") || 10_000);
if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) {
  throw new Error("--limit debe ser un entero entre 1 y 100000");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL no esta definido");

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const report = await runOwnedFairOddsBacktest(client, {
    sports,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    league: valueOf("--league") || null,
    mode,
    requireContext: has("--require-context"),
    allowUnverifiedResults: has("--allow-unverified-results"),
    limit
  });
  await client.query("ROLLBACK");
  const output = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = valueOf("--output");
  if (outputPath) await writeFile(path.resolve(outputPath), output, "utf8");
  process.stdout.write(output);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
