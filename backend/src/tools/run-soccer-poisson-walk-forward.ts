import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import { runSoccerPoissonWalkForwardBacktest } from "../trading/soccer-poisson-walk-forward.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
config({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(moduleDirectory, "../../../.env") });
config({ path: path.resolve(process.cwd(), ".env") });
config();

const args = process.argv.slice(2);
const valueOf = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const integerValue = (name: string, fallback: number, min: number, max: number) => {
  const parsed = Number(valueOf(name) ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  return parsed;
};
const dateValue = (name: string, fallback: string) => {
  const value = valueOf(name) ?? fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} debe ser una fecha ISO valida`);
  return parsed.toISOString();
};

const from = dateValue("--from", "2000-01-01T00:00:00Z");
const to = dateValue("--to", new Date().toISOString());
if (from >= to) throw new Error("--from debe ser anterior a --to");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL no esta definido");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const report = await runSoccerPoissonWalkForwardBacktest(client, {
    from,
    to,
    league: valueOf("--league") ?? null,
    limit: integerValue("--limit", 10_000, 1, 100_000),
    minTrainingMatches: integerValue("--min-training-matches", 20, 1, 10_000),
    priorMatches: integerValue("--prior-matches", 5, 1, 100)
  });
  await client.query("ROLLBACK");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
