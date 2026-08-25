import { z } from "zod";

import { db } from "../db/index.js";
import { recordForecastContext } from "./forecast-chain.js";
import { tradingLocalDateWindow } from "./timezone.js";

const inputSchema = z.object({
  date: z.string().optional(),
  match_id: z.string().uuid().optional(),
  apply: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(120)
});

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function validSha256(value: unknown) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

function guardrails() {
  return {
    real_candidate_count: 0,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    autopost_enabled: false,
    kill_switch: true
  };
}

export async function runNbaNearStartContext(rawQuery: unknown = {}, rawBody: unknown = {}) {
  const input = inputSchema.parse({
    ...(rawQuery && typeof rawQuery === "object" ? rawQuery as Record<string, unknown> : {}),
    ...(rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {})
  });
  const window = tradingLocalDateWindow(input.date);
  const values: unknown[] = [window.start, window.end, input.limit];
  const matchFilter = input.match_id ? `AND match.id = $${values.push(input.match_id)}::uuid` : "";
  const result = await db.query(
    `
      SELECT
        match.id AS match_id,
        match.match_date AS kickoff,
        match.status::text AS status,
        match.raw_data,
        home.name AS home_team,
        away.name AS away_team
      FROM v_valid_matches match
      JOIN leagues league ON league.id = match.league_id
      JOIN sports sport ON sport.id = league.sport_id
      JOIN match_competitors home_competitor
        ON home_competitor.match_id = match.id AND home_competitor.home_away = 'home'
      JOIN teams home ON home.id = home_competitor.team_id
      JOIN match_competitors away_competitor
        ON away_competitor.match_id = match.id AND away_competitor.home_away = 'away'
      JOIN teams away ON away.id = away_competitor.team_id
      WHERE league.slug = 'nba'
        AND sport.slug = 'basketball'
        AND match.match_date >= $1::timestamptz
        AND match.match_date < $2::timestamptz
        ${matchFilter}
      ORDER BY match.match_date, match.id
      LIMIT $3
    `,
    values
  );

  const rows: Array<Record<string, unknown>> = [];
  let inserted = 0;
  let reused = 0;
  let blocked = 0;
  for (const match of result.rows) {
    const raw = objectValue(match.raw_data);
    const kickoff = new Date(String(match.kickoff));
    const capturedAt = new Date(String(raw.captured_at || raw.observed_at || ""));
    const missing = new Set(stringArray(raw.nba_context_missing));
    if (raw.injury_report_present !== true) missing.add("injury_report");
    if (raw.starting_lineups_confirmed !== true) missing.add("official_starting_lineups");
    if (raw.load_management_context_complete !== true) missing.add("load_management_context");
    if (raw.near_start_capture !== true) missing.add("near_start_capture");
    if (!validSha256(raw.provider_raw_sha256)) missing.add("provider_raw_sha256");
    if (Number.isNaN(capturedAt.getTime())) missing.add("captured_at");

    const started = Number.isNaN(kickoff.getTime()) || kickoff.getTime() <= Date.now();
    const capturedLate = !Number.isNaN(capturedAt.getTime())
      && !Number.isNaN(kickoff.getTime())
      && capturedAt.getTime() >= kickoff.getTime();
    if (started || capturedLate || String(match.status).toLowerCase() !== "scheduled") {
      blocked += 1;
      rows.push({
        match_id: match.match_id,
        match: `${match.away_team} @ ${match.home_team}`,
        kickoff: match.kickoff,
        status: "POST_TIPOFF_AUDIT_ONLY",
        context_complete: false,
        missing: [...missing],
        applied: false
      });
      continue;
    }

    const contextComplete = missing.size === 0 && raw.nba_context_complete === true;
    let contextId: string | null = null;
    let rowApplied = false;
    if (input.apply && validSha256(raw.provider_raw_sha256) && !Number.isNaN(capturedAt.getTime())) {
      await db.query("SELECT * FROM register_forecast_match($1::uuid)", [match.match_id]);
      await db.query(
        "SELECT * FROM register_forecast_provider_mapping($1::uuid, $2, $3, NULL::uuid, $4)",
        [match.match_id, "espn-nba", String(raw.provider_event_id || ""), "nba_scraper"]
      );
      await db.query(
        "SELECT * FROM validate_forecast_schedule($1::uuid, false, false, $2::timestamptz, NULL::uuid, $3)",
        [match.match_id, match.kickoff, "nba_scraper"]
      );
      const existing = await db.query(
        `
          SELECT id
          FROM forecast_context_snapshots
          WHERE match_id = $1::uuid
            AND source_payload_hash = $2
            AND captured_at = $3::timestamptz
          ORDER BY id
          LIMIT 1
        `,
        [match.match_id, raw.provider_raw_sha256, capturedAt.toISOString()]
      );
      if (existing.rows[0]) {
        contextId = String(existing.rows[0].id);
        reused += 1;
      } else {
        const context = await recordForecastContext({
          matchId: String(match.match_id),
          capturedAt: capturedAt.toISOString(),
          lineupConfirmed: raw.starting_lineups_confirmed === true,
          injuries: {
            injury_report_present: raw.injury_report_present === true,
            injuries: Array.isArray(raw.injury_context) ? raw.injury_context : [],
            home_lineup: Array.isArray(raw.home_lineup) ? raw.home_lineup : [],
            away_lineup: Array.isArray(raw.away_lineup) ? raw.away_lineup : [],
            load_management_context: objectValue(raw.load_management_context)
          },
          weather: null,
          missingFields: [...missing].sort(),
          notes: "NBA near-start context from ESPN capture. Workload flags are schedule-derived and are not official availability designations.",
          completeness: contextComplete ? "complete" : missing.size ? "partial" : "missing",
          sourceUrl: String(raw.summary_url || raw.source_url || "") || null,
          sourcePayloadHash: String(raw.provider_raw_sha256),
          captureMode: "LIVE_FORWARD",
          sourcePublishedAt: capturedAt.toISOString(),
          sourceAsOfAt: capturedAt.toISOString(),
          noPostEventDataAttested: true
        });
        contextId = String(context.id);
        inserted += 1;
      }
      rowApplied = true;
    }

    rows.push({
      match_id: match.match_id,
      match: `${match.away_team} @ ${match.home_team}`,
      kickoff: match.kickoff,
      captured_at: Number.isNaN(capturedAt.getTime()) ? null : capturedAt.toISOString(),
      provider_event_id: raw.provider_event_id || null,
      provider_raw_sha256: raw.provider_raw_sha256 || null,
      injury_report_present: raw.injury_report_present === true,
      home_starters: Array.isArray(raw.home_lineup) ? raw.home_lineup.length : 0,
      away_starters: Array.isArray(raw.away_lineup) ? raw.away_lineup.length : 0,
      load_management_context: objectValue(raw.load_management_context),
      context_complete: contextComplete,
      missing: [...missing].sort(),
      forecast_context_id: contextId,
      applied: rowApplied
    });
  }

  return {
    system_status: "NBA_NEAR_START_CONTEXT_SAFE_V1",
    date: window.selectedDate,
    apply: input.apply,
    scanned: result.rows.length,
    inserted,
    reused,
    blocked,
    complete: rows.filter((row) => row.context_complete === true).length,
    partial: rows.filter((row) => row.context_complete !== true && row.status !== "POST_TIPOFF_AUDIT_ONLY").length,
    rows,
    context_policy: {
      required: ["injury_report", "official_starting_lineups_5_each", "load_management_context"],
      fail_closed: true,
      post_tipoff_rescue: false
    },
    guardrails: guardrails()
  };
}
