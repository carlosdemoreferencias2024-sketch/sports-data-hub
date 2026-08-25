import { tradingLocalDateWindow } from "./timezone.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

export type CandidatePreflightInput = {
  match_id?: string;
  decision_as_of?: string;
  date?: string;
  sport?: string;
  limit?: number;
};

function normalizeSport(input?: string) {
  const sport = String(input || "all").toLowerCase();
  if (["football", "soccer", "futbol", "fútbol"].includes(sport)) return "soccer";
  if (["baseball", "mlb"].includes(sport)) return "baseball";
  if (["nfl", "american-football", "american_football", "american football"].includes(sport)) return "american_football";
  if (["nba", "basketball", "baloncesto"].includes(sport)) return "basketball";
  return "all";
}

function guardrails() {
  return {
    persistence_mode: "APPEND_ONLY_CANDIDATE_SNAPSHOT",
    real_candidate_count: 0,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    autopost_enabled: false,
    kill_switch: true
  };
}

export async function runCandidatePreflight(db: Queryable, input: CandidatePreflightInput) {
  if (!input.match_id) throw new Error("candidate_preflight_match_id_required");
  const decisionAsOf = input.decision_as_of || new Date().toISOString();
  const result = await db.query(
    "SELECT * FROM candidate_preflight($1::uuid, $2::timestamptz)",
    [input.match_id, decisionAsOf]
  );
  const row = result.rows[0];
  if (!row) throw new Error("candidate_preflight_snapshot_not_created");
  return {
    system_status: "CANDIDATE_PREFLIGHT_SAFE_V1",
    candidate_snapshot: row,
    eligible_for_shadow_ticket: row.verdict === "PASS",
    guardrails: guardrails()
  };
}

export async function getCandidatePreflightStatus(db: Queryable, input: CandidatePreflightInput = {}) {
  const window = tradingLocalDateWindow(input.date);
  const sport = normalizeSport(input.sport);
  const limit = Math.max(1, Math.min(300, Number(input.limit || 120)));
  const result = await db.query(
    `
      SELECT
        snapshot.*,
        match.sport_slug AS sport,
        match.league_slug AS league,
        match.home_team,
        match.away_team,
        match.scheduled_start AS kickoff,
        verify_candidate_snapshot(snapshot.id) AS hash_valid
      FROM forecast_candidate_snapshots snapshot
      JOIN forecast_matches match ON match.match_id = snapshot.match_id
      WHERE match.scheduled_start >= $1::timestamptz
        AND match.scheduled_start < $2::timestamptz
        AND ($3::text = 'all' OR match.sport_slug = $3::text)
        AND ($4::uuid IS NULL OR snapshot.match_id = $4::uuid)
      ORDER BY match.scheduled_start, snapshot.created_at DESC
      LIMIT $5
    `,
    [window.start, window.end, sport, input.match_id || null, limit]
  );
  return {
    system_status: "CANDIDATE_PREFLIGHT_SAFE_V1",
    date: window.selectedDate,
    sport,
    rows: result.rows,
    scanned: result.rows.length,
    passed: result.rows.filter((row) => row.verdict === "PASS" && row.hash_valid === true).length,
    failed: result.rows.filter((row) => row.verdict !== "PASS" || row.hash_valid !== true).length,
    guardrails: guardrails()
  };
}
