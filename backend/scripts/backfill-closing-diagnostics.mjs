import { config } from "dotenv";
import pg from "pg";
import { closingWindowDiagnostics } from "../dist/trading/timezone.js";

config();

const { Pool } = pg;
const apply = process.argv.includes("--apply");
const BACKFILL_VERSION = "closing-window-diagnostics-v2";
const BACKFILL_SOURCE = "backfill-closing-diagnostics.mjs";
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = Math.max(1, Math.min(1000, Number(limitArg?.split("=")[1] || 200)));

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function rawObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function closingTimestamp(raw) {
  return raw.closing_odds_timestamp
    || raw.closing_timestamp
    || raw.closing_odds_timestamp_original
    || raw.odds_timestamp
    || null;
}

function kickoffTimestamp(row, raw) {
  return raw.scheduled_kickoff
    || raw.kickoff
    || raw.kickoff_at
    || raw.match_kickoff
    || row.match_date
    || null;
}

try {
  const result = await pool.query(
    `
      SELECT
        pt.id,
        pt.match_id,
        pt.market_type,
        pt.selection,
        pt.raw_data,
        m.match_date
      FROM paper_trades pt
      LEFT JOIN matches m ON m.id = pt.match_id
      WHERE pt.raw_data ? 'closing_odds'
      ORDER BY pt.updated_at DESC
      LIMIT $1
    `,
    [limit]
  );

  const rows = [];
  let wouldUpdate = 0;
  let updated = 0;

  for (const row of result.rows) {
    const raw = rawObject(row.raw_data);
    const capturedAt = closingTimestamp(raw);
    const kickoff = kickoffTimestamp(row, raw);
    const diagnostic = closingWindowDiagnostics(String(capturedAt || ""), kickoff ? String(kickoff) : null);
    const patch = {
      closing_quality: diagnostic.closing_quality,
      closing_window_start: diagnostic.closing_window_start,
      closing_window_end: diagnostic.closing_window_end,
      minutes_before_kickoff: diagnostic.minutes_before_kickoff,
      minutes_from_valid_window: diagnostic.minutes_from_valid_window,
      closing_why_invalid: diagnostic.why_invalid,
      closing_diagnostic_backfilled_at: new Date().toISOString(),
      closing_diagnostic_backfill_version: BACKFILL_VERSION,
      closing_diagnostic_backfill_source: BACKFILL_SOURCE
    };

    const existing = {
      closing_quality: raw.closing_quality ?? null,
      closing_window_start: raw.closing_window_start ?? null,
      closing_window_end: raw.closing_window_end ?? null,
      minutes_before_kickoff: raw.minutes_before_kickoff ?? null,
      minutes_from_valid_window: raw.minutes_from_valid_window ?? null,
      closing_why_invalid: raw.closing_why_invalid ?? null,
      closing_diagnostic_backfill_version: raw.closing_diagnostic_backfill_version ?? null,
      closing_diagnostic_backfill_source: raw.closing_diagnostic_backfill_source ?? null
    };
    const changed = Object.entries(patch)
      .filter(([key]) => key !== "closing_diagnostic_backfilled_at")
      .some(([key, value]) => existing[key] !== value);

    rows.push({
      id: row.id,
      match_id: row.match_id,
      market_type: row.market_type,
      selection: row.selection,
      captured_at: capturedAt,
      kickoff,
      previous_quality: raw.closing_quality ?? null,
      next_quality: diagnostic.closing_quality,
      minutes_before_kickoff: diagnostic.minutes_before_kickoff,
      minutes_from_valid_window: diagnostic.minutes_from_valid_window,
      why_invalid: diagnostic.why_invalid,
      changed
    });

    if (!changed) continue;
    wouldUpdate += 1;
    if (apply) {
      await pool.query(
        "UPDATE paper_trades SET raw_data = raw_data || $1::jsonb WHERE id = $2",
        [JSON.stringify(patch), row.id]
      );
      updated += 1;
    }
  }

  console.log(JSON.stringify({
    mode: apply ? "APPLY" : "DRY_RUN",
    scanned: result.rows.length,
    would_update: wouldUpdate,
    updated,
    rows
  }, null, 2));
} finally {
  await pool.end();
}
