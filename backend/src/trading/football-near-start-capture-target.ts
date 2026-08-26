import { tradingLocalDateWindow } from "./timezone.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type TargetQuery = {
  date?: unknown;
  match_id?: unknown;
  min_minutes?: unknown;
  max_minutes?: unknown;
};

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export async function getFootballNearStartCaptureTarget(db: Queryable, input: TargetQuery = {}) {
  const selectedDate = typeof input.date === "string" ? input.date : undefined;
  const window = tradingLocalDateWindow(selectedDate);
  const matchId = String(input.match_id || "").trim() || null;
  const minMinutes = boundedNumber(input.min_minutes, 5, 0, 90);
  const maxMinutes = boundedNumber(input.max_minutes, 90, minMinutes, 180);
  const result = await db.query(
    `
      SELECT
        m.id AS match_id,
        m.match_date AS kickoff,
        l.slug AS league_slug,
        mapping.provider_name,
        mapping.external_match_id AS provider_event_id,
        COALESCE(home_team.name, 'Home') AS home_team,
        COALESCE(away_team.name, 'Away') AS away_team,
        EXTRACT(EPOCH FROM (m.match_date - NOW())) / 60.0 AS minutes_until_start,
        schedule_validation.result AS schedule_validation,
        identity_validation.result AS identity_validation
      FROM v_valid_matches m
      JOIN leagues l ON l.id = m.league_id
      JOIN sports s ON s.id = l.sport_id
      LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
      LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
      LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
      LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
      LEFT JOIN LATERAL (
        SELECT provider_name, external_match_id
        FROM forecast_provider_match_mappings
        WHERE match_id = m.id
          AND (
            LOWER(REPLACE(provider_name, '_', '-')) LIKE '%api-football%'
            OR LOWER(provider_name) LIKE '%espn%'
          )
        ORDER BY
          CASE WHEN LOWER(REPLACE(provider_name, '_', '-')) LIKE '%api-football%' THEN 0 ELSE 1 END,
          verified_at DESC,
          id DESC
        LIMIT 1
      ) mapping ON TRUE
      LEFT JOIN LATERAL (
        SELECT result
        FROM forecast_slate_validations
        WHERE match_id = m.id AND validation_type = 'schedule'
        ORDER BY validated_at DESC, id DESC
        LIMIT 1
      ) schedule_validation ON TRUE
      LEFT JOIN LATERAL (
        SELECT result
        FROM forecast_slate_validations
        WHERE match_id = m.id AND validation_type = 'identity'
        ORDER BY validated_at DESC, id DESC
        LIMIT 1
      ) identity_validation ON TRUE
      WHERE s.slug = 'soccer'
        AND m.match_date >= $1::timestamptz
        AND m.match_date < $2::timestamptz
        AND ($3::uuid IS NULL OR m.id = $3::uuid)
        AND m.match_date BETWEEN NOW() + ($4::double precision * INTERVAL '1 minute')
                             AND NOW() + ($5::double precision * INTERVAL '1 minute')
        AND mapping.external_match_id IS NOT NULL
        AND schedule_validation.result = 'VALID'
        AND identity_validation.result = 'VALID'
      ORDER BY m.match_date ASC, m.id ASC
      LIMIT 1
    `,
    [window.start, window.end, matchId, minMinutes, maxMinutes]
  );
  const row = result.rows[0] || null;
  return {
    system_status: row ? "FOOTBALL_NEAR_START_CAPTURE_TARGET_READY" : "FOOTBALL_NEAR_START_CAPTURE_NO_TARGET",
    target: row ? {
      match_id: String(row.match_id),
      league_slug: String(row.league_slug),
      provider_name: String(row.provider_name),
      provider_event_id: String(row.provider_event_id),
      home_team: String(row.home_team),
      away_team: String(row.away_team),
      kickoff: new Date(row.kickoff).toISOString(),
      minutes_until_start: Number(Number(row.minutes_until_start).toFixed(1)),
      schedule_validation: String(row.schedule_validation),
      identity_validation: String(row.identity_validation)
    } : null,
    guardrails: {
      max_focus: 1,
      auto_import: false,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}
