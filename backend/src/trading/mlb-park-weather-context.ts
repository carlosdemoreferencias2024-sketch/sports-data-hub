import { tradingLocalDate, tradingLocalDateWindow } from "./timezone.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type MlbParkWeatherInput = {
  date?: string;
  apply?: boolean;
  limit?: number;
};

const PARK_CATALOG: Record<string, Record<string, unknown>> = {
  "Arizona Diamondbacks": { stadium: "Chase Field", roof_type: "retractable", altitude_ft: 1086, park_factor: 1.02, run_factor: 1.02, home_run_factor: 1.06 },
  "Atlanta Braves": { stadium: "Truist Park", roof_type: "open", altitude_ft: 1050, park_factor: 1.00, run_factor: 1.00, home_run_factor: 1.02 },
  "Baltimore Orioles": { stadium: "Oriole Park at Camden Yards", roof_type: "open", altitude_ft: 45, park_factor: 0.96, run_factor: 0.96, home_run_factor: 0.92 },
  "Boston Red Sox": { stadium: "Fenway Park", roof_type: "open", altitude_ft: 20, park_factor: 1.05, run_factor: 1.05, home_run_factor: 0.98 },
  "Chicago Cubs": { stadium: "Wrigley Field", roof_type: "open", altitude_ft: 600, park_factor: 1.03, run_factor: 1.03, home_run_factor: 1.06 },
  "Chicago White Sox": { stadium: "Rate Field", roof_type: "open", altitude_ft: 595, park_factor: 1.01, run_factor: 1.01, home_run_factor: 1.08 },
  "Cincinnati Reds": { stadium: "Great American Ball Park", roof_type: "open", altitude_ft: 550, park_factor: 1.06, run_factor: 1.06, home_run_factor: 1.22 },
  "Cleveland Guardians": { stadium: "Progressive Field", roof_type: "open", altitude_ft: 650, park_factor: 0.99, run_factor: 0.99, home_run_factor: 1.00 },
  "Colorado Rockies": { stadium: "Coors Field", roof_type: "open", altitude_ft: 5200, park_factor: 1.18, run_factor: 1.18, home_run_factor: 1.12 },
  "Detroit Tigers": { stadium: "Comerica Park", roof_type: "open", altitude_ft: 600, park_factor: 1.00, run_factor: 1.00, home_run_factor: 0.94 },
  "Houston Astros": { stadium: "Daikin Park", roof_type: "retractable", altitude_ft: 50, park_factor: 1.01, run_factor: 1.01, home_run_factor: 1.05 },
  "Kansas City Royals": { stadium: "Kauffman Stadium", roof_type: "open", altitude_ft: 750, park_factor: 1.02, run_factor: 1.02, home_run_factor: 0.92 },
  "Los Angeles Angels": { stadium: "Angel Stadium", roof_type: "open", altitude_ft: 160, park_factor: 0.98, run_factor: 0.98, home_run_factor: 1.00 },
  "Los Angeles Dodgers": { stadium: "Dodger Stadium", roof_type: "open", altitude_ft: 520, park_factor: 0.98, run_factor: 0.98, home_run_factor: 1.02 },
  "Miami Marlins": { stadium: "loanDepot park", roof_type: "retractable", altitude_ft: 10, park_factor: 0.96, run_factor: 0.96, home_run_factor: 0.92 },
  "Milwaukee Brewers": { stadium: "American Family Field", roof_type: "retractable", altitude_ft: 600, park_factor: 1.01, run_factor: 1.01, home_run_factor: 1.05 },
  "Minnesota Twins": { stadium: "Target Field", roof_type: "open", altitude_ft: 840, park_factor: 0.99, run_factor: 0.99, home_run_factor: 0.98 },
  "New York Mets": { stadium: "Citi Field", roof_type: "open", altitude_ft: 15, park_factor: 0.97, run_factor: 0.97, home_run_factor: 0.96 },
  "New York Yankees": { stadium: "Yankee Stadium", roof_type: "open", altitude_ft: 55, park_factor: 1.02, run_factor: 1.02, home_run_factor: 1.13 },
  "Athletics": { stadium: "Sutter Health Park", roof_type: "open", altitude_ft: 25, park_factor: 1.00, run_factor: 1.00, home_run_factor: 1.00 },
  "Philadelphia Phillies": { stadium: "Citizens Bank Park", roof_type: "open", altitude_ft: 45, park_factor: 1.03, run_factor: 1.03, home_run_factor: 1.12 },
  "Pittsburgh Pirates": { stadium: "PNC Park", roof_type: "open", altitude_ft: 730, park_factor: 0.99, run_factor: 0.99, home_run_factor: 0.95 },
  "San Diego Padres": { stadium: "Petco Park", roof_type: "open", altitude_ft: 65, park_factor: 0.96, run_factor: 0.96, home_run_factor: 0.94 },
  "San Francisco Giants": { stadium: "Oracle Park", roof_type: "open", altitude_ft: 10, park_factor: 0.94, run_factor: 0.94, home_run_factor: 0.82 },
  "Seattle Mariners": { stadium: "T-Mobile Park", roof_type: "retractable", altitude_ft: 10, park_factor: 0.97, run_factor: 0.97, home_run_factor: 0.96 },
  "St. Louis Cardinals": { stadium: "Busch Stadium", roof_type: "open", altitude_ft: 460, park_factor: 0.99, run_factor: 0.99, home_run_factor: 0.96 },
  "Tampa Bay Rays": { stadium: "Tropicana Field", roof_type: "dome", altitude_ft: 15, park_factor: 0.98, run_factor: 0.98, home_run_factor: 0.95 },
  "Texas Rangers": { stadium: "Globe Life Field", roof_type: "retractable", altitude_ft: 560, park_factor: 1.01, run_factor: 1.01, home_run_factor: 1.05 },
  "Toronto Blue Jays": { stadium: "Rogers Centre", roof_type: "retractable", altitude_ft: 250, park_factor: 1.01, run_factor: 1.01, home_run_factor: 1.06 },
  "Washington Nationals": { stadium: "Nationals Park", roof_type: "open", altitude_ft: 25, park_factor: 1.00, run_factor: 1.00, home_run_factor: 1.02 }
};

function localDate(date?: string) {
  return date || tradingLocalDate();
}

function localDateWindow(date?: string) {
  return tradingLocalDateWindow(date);
}

function rawObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function findCatalog(homeTeam: string | null, venueName: string | null) {
  if (homeTeam && PARK_CATALOG[homeTeam]) return PARK_CATALOG[homeTeam];
  if (venueName) {
    return Object.values(PARK_CATALOG).find((entry) => String(entry.stadium || "").toLowerCase() === venueName.toLowerCase()) || null;
  }
  return null;
}

function buildPayload(row: Record<string, any>): Record<string, any> {
  const raw = rawObject(row.raw_data);
  const venueName = row.venue_name ? String(row.venue_name) : null;
  const catalog = findCatalog(row.home_team ? String(row.home_team) : null, venueName);
  const fetchedAt = new Date().toISOString();
  const parkContext = catalog
    ? {
        ...catalog,
        stadium: venueName || catalog.stadium,
        source_label: "PARK_STATIC_CONTEXT",
        source_url: "internal_static_mlb_park_catalog",
        fetched_at: fetchedAt,
        confidence_score: venueName ? 85 : 75
      }
    : {
        status: "MISSING",
        missing_reason: "PARK_STATIC_CONTEXT_MISSING",
        source_label: null,
        fetched_at: fetchedAt,
        confidence_score: 0
      };
  const weatherRaw = rawObject(raw.weather_context);
  const weatherContext = Object.keys(weatherRaw).length && !weatherRaw.missing_reason
    ? weatherRaw
    : {
        status: "MISSING",
        missing_reason: "WEATHER_SOURCE_MISSING",
        source_label: null,
        source_url: null,
        fetched_at: fetchedAt,
        confidence_score: 0
      };
  const payload = {
    park_context: parkContext,
    stadium: (parkContext as Record<string, unknown>).stadium || venueName || null,
    park_factor: (parkContext as Record<string, unknown>).park_factor || null,
    run_environment: (parkContext as Record<string, unknown>).run_factor || null,
    roof_type: (parkContext as Record<string, unknown>).roof_type || null,
    weather_context: weatherContext,
    weather_missing_reason: (weatherContext as Record<string, unknown>).missing_reason || null,
    mlb_park_weather_context_version: "safe_v1",
    mlb_park_weather_context_updated_at: fetchedAt
  };
  return {
    ...row,
    park_ready: !!catalog,
    weather_ready: !(weatherContext as Record<string, unknown>).missing_reason,
    payload
  };
}

async function loadRows(db: Queryable, input: MlbParkWeatherInput) {
  const window = localDateWindow(input.date);
  const limit = Math.max(1, Math.min(300, Number(input.limit || 120)));
  const result = await db.query(
    `
      SELECT
        rps.id AS snapshot_id,
        rps.match_id,
        rps.status AS ticket_status,
        rps.raw_data,
        m.match_date AS kickoff,
        m.status::text AS match_status,
        v.name AS venue_name,
        home_team.name AS home_team,
        away_team.name AS away_team
      FROM real_paper_snapshots rps
      LEFT JOIN matches m ON m.id = rps.match_id
      LEFT JOIN venues v ON v.id = m.venue_id
      LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
      LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
      LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
      LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
      WHERE rps.sport_slug = 'baseball'
        AND rps.league_slug = 'mlb'
        AND COALESCE(rps.data_state, 'FRESH') = 'FRESH'
        AND rps.duplicate_of_id IS NULL
        AND (
          (m.match_date >= $1::timestamptz AND m.match_date < $2::timestamptz)
          OR (rps.entry_timestamp >= $1::timestamptz AND rps.entry_timestamp < $2::timestamptz)
          OR rps.status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED', 'ARCHIVED')
        )
      ORDER BY COALESCE(m.match_date, rps.entry_timestamp) ASC
      LIMIT $3
    `,
    [window.start, window.end, limit]
  );
  return { window, rows: result.rows.map(buildPayload) };
}

function summarize(rows: Array<Record<string, any>>, updated = 0) {
  return {
    scanned: rows.length,
    park_ready: rows.filter((row) => row.park_ready).length,
    weather_ready: rows.filter((row) => row.weather_ready).length,
    weather_missing: rows.filter((row) => !row.weather_ready).length,
    updated,
    missing: {
      park_context: rows.filter((row) => !row.park_ready).length,
      weather_context: rows.filter((row) => !row.weather_ready).length
    }
  };
}

export async function getMlbParkWeatherStatus(db: Queryable, input: MlbParkWeatherInput = {}) {
  const { window, rows } = await loadRows(db, input);
  return {
    system_status: "MLB_PARK_WEATHER_CONTEXT_SAFE_V1",
    date: window.selectedDate,
    persistence_mode: "READ_ONLY",
    ...summarize(rows),
    rows: rows.map((row) => ({
      snapshot_id: row.snapshot_id,
      match_id: row.match_id,
      match: `${row.away_team || "Away"} @ ${row.home_team || "Home"}`,
      kickoff: row.kickoff,
      stadium: row.payload.stadium,
      park_ready: row.park_ready,
      weather_ready: row.weather_ready,
      weather_missing_reason: row.payload.weather_missing_reason,
      recommendation: row.weather_ready
        ? "Park/weather listo para preflight."
        : "Park estatico permitido; clima sigue faltante hasta fuente verificable."
    })),
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}

export async function runMlbParkWeatherContext(db: Queryable, input: MlbParkWeatherInput = {}) {
  const { window, rows } = await loadRows(db, input);
  const apply = input.apply === true;
  let updated = 0;
  if (apply) {
    for (const row of rows) {
      await db.query(
        `
          UPDATE real_paper_snapshots
          SET raw_data = COALESCE(raw_data, '{}'::jsonb) || $1::jsonb,
              updated_at = NOW()
          WHERE id = $2
        `,
        [JSON.stringify(row.payload), row.snapshot_id]
      );
      updated += 1;
    }
  }
  return {
    system_status: "MLB_PARK_WEATHER_CONTEXT_SAFE_V1",
    date: window.selectedDate,
    run_mode: apply ? "APPLY_STATIC_PARK_AND_WEATHER_MISSING_FLAGS" : "DRY_RUN",
    applied: apply,
    ...summarize(rows, updated),
    rows: rows.map((row) => ({
      snapshot_id: row.snapshot_id,
      match_id: row.match_id,
      match: `${row.away_team || "Away"} @ ${row.home_team || "Home"}`,
      stadium: row.payload.stadium,
      park_ready: row.park_ready,
      weather_ready: row.weather_ready,
      payload: row.payload
    })),
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}
