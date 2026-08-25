import { FOOTBALL_LEAGUES, FOOTBALL_STANDARD_MARKETS, FootballLeagueConfig, FootballMarketKey } from "./football-leagues.config.js";
import { resolveFootballLeagueId } from "./football-league-aliases.js";
import {
  competitionToLeagueConfig,
  getCompetitionByLeagueIdFromRows,
  getCompetitionRows,
  getMarketBlockReasonForCompetition,
  isMarketEnabledForCompetitionRow
} from "./football-competition-registry.js";

export type FootballLabStatus = "ACCUMULATING_EARLY" | "ACCUMULATING" | "WATCH" | "READY_FOR_REVIEW" | "COOLING" | "BLOCKED" | "DISABLED";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

type FootballMarketLabRow = {
  sport: "soccer";
  league_id: string;
  league_display_name: string;
  tier: FootballLeagueConfig["tier"];
  priority: FootballLeagueConfig["priority"];
  country_or_region: string;
  confederation: string;
  flow: FootballLeagueConfig["flow"];
  market: FootballMarketKey;
  total: number;
  closed: number;
  pending: number;
  wins: number;
  losses: number;
  pushes: number;
  win_rate: number | null;
  profit: number;
  avg_odds: number | null;
  avg_model_prob: number | null;
  brier: number | null;
  clv: number | null;
  status: FootballLabStatus;
  recommendation: string;
  sample_progress_to_20: number;
  sample_progress_to_50: number;
  sample_progress_to_75: number;
  latest_signal_at: string | null;
};

type FootballSignalInput = {
  match_id?: string;
  league?: string;
  league_id?: string;
  market: FootballMarketKey;
  selection: string;
  home_team: string;
  away_team: string;
  model_version?: string;
  provider?: string;
  model_probability: number;
  market_odds: number;
  expected_value: number;
  bankroll_allocation?: number;
  dry_run?: boolean;
  raw_data?: Record<string, unknown>;
};

type FootballFeedRow = {
  league_id: string | null;
  league_name: string | null;
  market: FootballMarketKey;
  dry_run: boolean;
  status: "DRY_RUN_WOULD_INSERT" | "DRY_RUN_WOULD_OBSERVE" | "INSERTED" | "OBSERVATION_ONLY" | "SKIPPED" | "BLOCKED" | "DUPLICATE";
  reason?: string;
  processed?: boolean;
  flow?: "shadow_paper" | "observation_only";
};

function hasTrustedSourceConsensus(rawData?: Record<string, unknown>): boolean {
  const consensus = String(rawData?.source_consensus ?? "").toLowerCase();
  if (consensus.includes("onefootball")) return true;

  const verified = rawData?.consensus_verified === true;
  const evidenceUrl = String(rawData?.consensus_evidence_url ?? rawData?.official_source_url ?? "").trim();
  const hasOfficialSource = consensus.includes("official")
    || consensus.includes("mls")
    || consensus.includes("league_source");

  return verified && evidenceUrl !== "" && hasOfficialSource;
}

function getFixtureTrustBlockReason(signal: FootballSignalInput, dryRun: boolean): string | null {
  const rawData = signal.raw_data ?? {};
  const validationStatus = String(rawData.validation_status ?? "").toUpperCase();
  const observationOnly = isObservationOnly(signal);

  if (rawData.kickoff_trusted === false || validationStatus === "KICKOFF_UNTRUSTED") {
    return "KICKOFF_UNTRUSTED";
  }

  if (validationStatus === "TEAM_MISMATCH" || validationStatus === "TEAM_SIDE_MISMATCH") {
    return validationStatus;
  }

  if (validationStatus === "LEAGUE_MISMATCH" || validationStatus === "STATUS_MISMATCH") {
    return validationStatus;
  }

  if (!observationOnly && rawData.requires_onefootball_consensus === true && !hasTrustedSourceConsensus(rawData)) {
    return "SOURCE_CONSENSUS_REQUIRED";
  }

  if (!dryRun && !observationOnly) {
    if (rawData.kickoff_trusted !== true) {
      return "KICKOFF_UNTRUSTED";
    }
    if (!hasTrustedSourceConsensus(rawData)) {
      return "SOURCE_CONSENSUS_REQUIRED";
    }
  }

  return null;
}

function isObservationOnly(signal: FootballSignalInput): boolean {
  const rawData = signal.raw_data ?? {};
  return rawData.observation_only === true
    || String(rawData.feed_status ?? rawData.status ?? "").toUpperCase() === "OBSERVATION_ONLY";
}

function normalizeSnapshotSelection(selection: string): "home" | "away" | "draw" | "over" | "under" | "yes" | "no" | "home_draw" | "home_away" | "draw_away" | null {
  const normalized = selection.toLowerCase();
  if (["home", "home_dnb", "local"].includes(normalized)) return "home";
  if (["away", "away_dnb", "visitor", "visitante"].includes(normalized)) return "away";
  if (["draw", "tie", "empate"].includes(normalized)) return "draw";
  if (["home_draw", "home_or_draw", "1x"].includes(normalized)) return "home_draw";
  if (["home_away", "home_or_away", "12"].includes(normalized)) return "home_away";
  if (["draw_away", "draw_or_away", "x2"].includes(normalized)) return "draw_away";
  if (normalized.startsWith("over")) return "over";
  if (normalized.startsWith("under")) return "under";
  if (["yes", "btts_yes", "si"].includes(normalized)) return "yes";
  if (["no", "btts_no"].includes(normalized)) return "no";
  return null;
}

function quoteOddsColumns(selection: "home" | "away" | "draw" | "over" | "under" | "yes" | "no" | "home_draw" | "home_away" | "draw_away", odds: number) {
  return {
    home_odds: selection === "home" || selection === "over" || selection === "yes" || selection === "home_draw" ? odds : null,
    away_odds: selection === "away" || selection === "under" || selection === "no" || selection === "draw_away" ? odds : null,
    draw_odds: selection === "draw" || selection === "home_away" ? odds : null
  };
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOddsSource(value?: string): string {
  const source = (value ?? "manual_shadow").trim() || "manual_shadow";
  return source.length <= 30 ? source : source.slice(0, 30);
}

function getLeague(leagueId: string) {
  return FOOTBALL_LEAGUES.find((league) => league.league_id === leagueId) ?? null;
}

export function getFootballLabStatus(league: FootballLeagueConfig, market: FootballMarketKey, metrics: { closed: number; wins: number; losses: number; profit: number; clv: number | null }): FootballLabStatus {
  if (!league.enabled || league.priority === "DISABLED") return "DISABLED";
  if (!league.markets_enabled.includes(market)) return "DISABLED";
  if (league.league_id === "fifa-world-cup-2026" && market === "btts") return "BLOCKED";
  if (metrics.profit <= -500 && metrics.closed >= 15) return "BLOCKED";
  if (metrics.closed < league.min_closed_before_watch) return "ACCUMULATING_EARLY";
  if (metrics.closed < league.min_closed_before_review) return "ACCUMULATING";
  if (metrics.closed >= 75 && metrics.profit > 0 && (metrics.clv === null || metrics.clv >= 0)) return "READY_FOR_REVIEW";
  if (metrics.closed >= 50 && metrics.profit > 0) return "WATCH";
  if (metrics.closed >= 50 && metrics.profit <= 0) return "COOLING";
  return "ACCUMULATING";
}

function recommendationFor(status: FootballLabStatus, row: Pick<FootballMarketLabRow, "league_display_name" | "market" | "closed" | "pending">) {
  if (status === "BLOCKED") return "Bloqueado por mercado o performance; no alimentar decisiones.";
  if (status === "DISABLED") return "Liga o mercado deshabilitado.";
  if (status === "READY_FOR_REVIEW") return "Listo para revision formal; no promover globalmente.";
  if (status === "WATCH") return "Seguir en watch por liga + mercado; falta auditoria 75+.";
  if (status === "COOLING") return "Enfriandose; revisar antes de ampliar muestra.";
  if (status === "ACCUMULATING_EARLY") return `Muestra temprana: ${row.closed}/20. Solo observacion.`;
  if (row.pending > 0) return "Hay pendientes; correr settlement cuando terminen.";
  return `Acumular Shadow Paper para ${row.league_display_name} ${row.market}: ${row.closed}/50 cerradas.`;
}

export async function getFootballMarketLab(db: Queryable) {
  const registryRows = await getCompetitionRows(db);
  const activeLeagues = registryRows.length ? registryRows.map(competitionToLeagueConfig) : FOOTBALL_LEAGUES;
  const leagueIds = activeLeagues.map((league) => league.league_id);
  const result = await db.query(
    `
      SELECT
        league_slug,
        market_type,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED'))::int AS closed,
        COUNT(*) FILTER (WHERE status IN ('PENDING', 'PENDING_RESULT', 'PENDING_RESULTS', 'OPEN'))::int AS pending,
        COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
        COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
        COUNT(*) FILTER (WHERE status = 'PUSH')::int AS pushes,
        ROUND(COALESCE(SUM(net_profit) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')), 0)::numeric, 4) AS profit,
        ROUND(AVG(market_odds) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED'))::numeric, 4) AS avg_odds,
        ROUND(AVG(model_probability) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED'))::numeric, 6) AS avg_model_prob,
        ROUND(AVG(POWER(model_probability - CASE WHEN status = 'WIN' THEN 1 ELSE 0 END, 2)) FILTER (WHERE status IN ('WIN', 'LOSS'))::numeric, 6) AS brier,
        ROUND(AVG(NULLIF(raw_data->>'clv', '')::numeric) FILTER (WHERE raw_data ? 'clv')::numeric, 6) AS clv,
        MAX(COALESCE(settled_at, placed_at, updated_at, created_at)) AS latest_signal_at
      FROM paper_trades
      WHERE league_slug = ANY($1::text[])
        AND market_type = ANY($2::text[])
      GROUP BY league_slug, market_type
    `,
    [leagueIds, FOOTBALL_STANDARD_MARKETS]
  );

  const metricsByKey = new Map<string, Record<string, unknown>>();
  for (const row of result.rows) {
    metricsByKey.set(`${String(row.league_slug)}:${String(row.market_type)}`, row);
  }

  const rows: FootballMarketLabRow[] = [];
  for (const league of activeLeagues) {
    for (const market of league.markets_enabled) {
      const raw = metricsByKey.get(`${league.league_id}:${market}`);
      const wins = toNumber(raw?.wins);
      const losses = toNumber(raw?.losses);
      const closed = toNumber(raw?.closed);
      const clv = toNullableNumber(raw?.clv);
      const base = {
        sport: "soccer" as const,
        league_id: league.league_id,
        league_display_name: league.display_name,
        tier: league.tier,
        priority: league.priority,
        country_or_region: league.country_or_region,
        confederation: league.confederation,
        flow: league.flow,
        market,
        total: toNumber(raw?.total),
        closed,
        pending: toNumber(raw?.pending),
        wins,
        losses,
        pushes: toNumber(raw?.pushes),
        win_rate: wins + losses > 0 ? wins / (wins + losses) : null,
        profit: toNumber(raw?.profit),
        avg_odds: toNullableNumber(raw?.avg_odds),
        avg_model_prob: toNullableNumber(raw?.avg_model_prob),
        brier: toNullableNumber(raw?.brier),
        clv,
        sample_progress_to_20: Math.min(1, closed / 20),
        sample_progress_to_50: Math.min(1, closed / 50),
        sample_progress_to_75: Math.min(1, closed / 75),
        latest_signal_at: raw?.latest_signal_at ? String(raw.latest_signal_at) : null
      };
      const status = getFootballLabStatus(league, market, { closed, wins, losses, profit: base.profit, clv });
      rows.push({ ...base, status, recommendation: recommendationFor(status, base) });
    }
  }

  const best = rows.filter((row) => row.closed > 0 && row.status !== "BLOCKED" && row.status !== "DISABLED").sort((a, b) => b.profit - a.profit || b.closed - a.closed)[0] ?? null;
  const worst = rows.filter((row) => row.closed > 0).sort((a, b) => a.profit - b.profit || b.closed - a.closed)[0] ?? null;
  const visibleRows = rows.filter((row) => row.tier !== "GLOBAL" || row.total > 0 || row.status === "BLOCKED");
  const collapsedGlobal = rows.filter((row) => row.tier === "GLOBAL" && row.total === 0 && row.status !== "BLOCKED");
  const closestTo50 = rows
    .filter((row) => row.status === "ACCUMULATING" && row.closed > 0 && row.closed < 50)
    .sort((a, b) => b.closed - a.closed || b.profit - a.profit)[0] ?? null;

  return {
    system_status: "FOOTBALL_MARKET_LAB_SHADOW_PAPER_ONLY",
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    real_candidate_count: 0,
    count: rows.length,
    visible_count: visibleRows.length,
    collapsed_global_count: collapsedGlobal.length,
    rows,
    visible_rows: visibleRows,
    best_current_market: best,
    worst_current_market: worst,
    blocked_markets: rows.filter((row) => row.status === "BLOCKED"),
    global_leagues_collapsed: collapsedGlobal.map((row) => row.league_id + ":" + row.market),
    favorite_leagues_without_data: activeLeagues.filter((league) => league.priority === "FAVORITE" && rows.every((row) => row.league_id !== league.league_id || row.total === 0)).map((league) => league.league_id),
    next_closest_to_50: closestTo50,
    recommendation: closestTo50 ? `Siguiente meta: ${closestTo50.league_display_name} ${closestTo50.market} va ${closestTo50.closed}/50.` : "Alimentar ligas FAVORITE y WATCH; GLOBAL queda colapsado hasta tener datos.",
    guardrails: {
      shadow_paper_only: true,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false
    }
  };
}

export async function getFootballShadowFeedStatus(db: Queryable) {
  const lab = await getFootballMarketLab(db);
  const dryRunExamples = [
    {
      name: "Liga MX shadow dry-run",
      method: "POST",
      endpoint: "/api/v1/internal/analytics/football-shadow-feed",
      body: {
        dry_run: true,
        signals: [
          {
            match_id: "11111111-1111-4111-8111-111111111111",
            league: "liga mx",
            market: "moneyline_3way",
            selection: "home",
            home_team: "Liga MX Home",
            away_team: "Liga MX Away",
            model_probability: 0.56,
            market_odds: 2.1,
            expected_value: 0.05,
            provider: "manual_shadow_liga_mx"
          },
          {
            match_id: "11111111-1111-4111-8111-111111111112",
            league: "liga mx",
            market: "total_goals_2_5",
            selection: "over_2_5",
            home_team: "Liga MX Home",
            away_team: "Liga MX Away",
            model_probability: 0.55,
            market_odds: 1.95,
            expected_value: 0.04,
            provider: "manual_shadow_liga_mx"
          },
          {
            match_id: "11111111-1111-4111-8111-111111111113",
            league: "liga mx",
            market: "draw_no_bet",
            selection: "home_dnb",
            home_team: "Liga MX Home",
            away_team: "Liga MX Away",
            model_probability: 0.58,
            market_odds: 1.8,
            expected_value: 0.03,
            provider: "manual_shadow_liga_mx"
          }
        ]
      }
    },
    {
      name: "MLS shadow dry-run",
      method: "POST",
      endpoint: "/api/v1/internal/analytics/football-shadow-feed",
      body: {
        dry_run: true,
        signals: [
          {
            match_id: "22222222-2222-4222-8222-222222222221",
            league: "mls",
            market: "moneyline_3way",
            selection: "home",
            home_team: "MLS Home",
            away_team: "MLS Away",
            model_probability: 0.56,
            market_odds: 2.1,
            expected_value: 0.05,
            provider: "manual_shadow_mls"
          },
          {
            match_id: "22222222-2222-4222-8222-222222222222",
            league: "mls",
            market: "total_goals_2_5",
            selection: "over_2_5",
            home_team: "MLS Home",
            away_team: "MLS Away",
            model_probability: 0.55,
            market_odds: 1.95,
            expected_value: 0.04,
            provider: "manual_shadow_mls"
          },
          {
            match_id: "22222222-2222-4222-8222-222222222223",
            league: "mls",
            market: "draw_no_bet",
            selection: "home_dnb",
            home_team: "MLS Home",
            away_team: "MLS Away",
            model_probability: 0.58,
            market_odds: 1.8,
            expected_value: 0.03,
            provider: "manual_shadow_mls"
          }
        ]
      }
    }
  ];
  return {
    system_status: "FOOTBALL_SHADOW_FEED_STATUS",
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    shadow_paper_only: true,
    dry_run_examples: dryRunExamples,
    ready_leagues: ["liga-mx", "mls"].map((leagueId) => ({
      league_id: leagueId,
      rows: lab.rows.filter((row) => row.league_id === leagueId)
    })),
    rows: lab.rows.map((row) => ({
      league_id: row.league_id,
      tier: row.tier,
      country_or_region: row.country_or_region,
      market: row.market,
      inserted: row.total,
      skipped: 0,
      blocked: row.status === "BLOCKED" ? row.total || 1 : 0,
      duplicates: 0,
      pending_results: row.pending,
      latest_signal_at: row.latest_signal_at,
      status: row.status
    }))
  };
}

export async function processFootballShadowFeed(db: Queryable, body: { dry_run?: boolean; signals?: FootballSignalInput[] }) {
  const dryRun = body.dry_run !== false;
  const signals = body.signals ?? [];
  const registryRows = await getCompetitionRows(db);
  const summary = { inserted: 0, observed: 0, would_insert: 0, would_observe: 0, skipped: 0, blocked: 0, duplicates: 0, dry_run: dryRun };
  const rows: FootballFeedRow[] = [];

  for (const signal of signals) {
    const leagueId = resolveFootballLeagueId(signal.league_id ?? signal.league ?? "") ?? "";
    const league = getLeague(leagueId);
    if (!league || !league.enabled || league.priority === "DISABLED") {
      summary.skipped += 1;
      rows.push({ league_id: leagueId || null, league_name: null, market: signal.market, dry_run: dryRun, status: "SKIPPED", reason: "league_not_enabled" });
      continue;
    }
    const isManualReview = signal.raw_data?.manual_review === true || signal.raw_data?.manual_review_required === true;
    const competition = getCompetitionByLeagueIdFromRows(leagueId, registryRows);
    const registryBlock = getMarketBlockReasonForCompetition(competition, signal.market, isManualReview);
    if (registryBlock) {
      summary.skipped += 1;
      rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "SKIPPED", reason: registryBlock });
      continue;
    }
    if (league.tier === "MANUAL_ONLY" && !(signal.provider ?? "manual_shadow").includes("manual_shadow") && !isManualReview) {
      summary.skipped += 1;
      rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "SKIPPED", reason: "manual_only_requires_manual_shadow" });
      continue;
    }
    if (!isMarketEnabledForCompetitionRow(competition, signal.market, isManualReview) && !league.markets_enabled.includes(signal.market)) {
      summary.skipped += 1;
      rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "SKIPPED", reason: "MARKET_NOT_ENABLED" });
      continue;
    }
    if (signal.market === "btts" && !dryRun && !isManualReview) {
      summary.skipped += 1;
      rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "SKIPPED", reason: "btts_requires_manual_review" });
      continue;
    }
    if (getFootballLabStatus(league, signal.market, { closed: 0, wins: 0, losses: 0, profit: 0, clv: null }) === "BLOCKED") {
      summary.blocked += 1;
      rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "BLOCKED", reason: "market_blocked" });
      continue;
    }
    if (!signal.match_id) {
      summary.skipped += 1;
      rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "SKIPPED", reason: "missing_match_id" });
      continue;
    }
    const fixtureTrustBlock = getFixtureTrustBlockReason(signal, dryRun);
    if (fixtureTrustBlock) {
      summary.blocked += 1;
      rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "BLOCKED", reason: fixtureTrustBlock });
      continue;
    }

    const observationOnly = isObservationOnly(signal);
    const modelVersion = signal.model_version ?? "carlos_v1_football";
    if (observationOnly) {
      const snapshotSelection = normalizeSnapshotSelection(signal.selection);
      if (!snapshotSelection) {
        summary.skipped += 1;
        rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "SKIPPED", reason: "unsupported_observation_selection" });
        continue;
      }
      const duplicateObservation = await db.query(
        `
          SELECT id
          FROM odds_snapshots
          WHERE match_id = $1
            AND provider_name = $2
            AND market_type = $3
            AND selection = $4
            AND captured_at = COALESCE(($5::jsonb->>'odds_timestamp')::timestamptz, NOW())
          LIMIT 1
        `,
        [signal.match_id, signal.provider ?? "manual_shadow", signal.market, snapshotSelection, JSON.stringify(signal.raw_data ?? {})]
      );
      if (duplicateObservation.rows.length > 0) {
        summary.duplicates += 1;
        rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "DUPLICATE", reason: "observation_snapshot_exists" });
        continue;
      }
      if (dryRun) {
        summary.would_observe += 1;
        rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "DRY_RUN_WOULD_OBSERVE", processed: true, flow: "observation_only" });
        continue;
      }

      const oddsColumns = quoteOddsColumns(snapshotSelection, signal.market_odds);
      const rawData = JSON.stringify({
        ...(signal.raw_data ?? {}),
        processed: true,
        flow: "observation_only",
        feed_status: "OBSERVATION_ONLY",
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false
      });
      const insertObservation = await db.query(
        `
          WITH quote_insert AS (
            INSERT INTO market_quotes (
              match_id, provider_name, market_type, line, home_odds, away_odds,
              draw_odds, captured_at, raw_data
            )
            VALUES (
              $1, $2, $3, NULL, $4, $5, $6,
              COALESCE(($7::jsonb->>'odds_timestamp')::timestamptz, NOW()),
              $7::jsonb
            )
            RETURNING id, captured_at
          )
          INSERT INTO odds_snapshots (
            market_quote_id, match_id, sport_slug, league_slug, provider_name,
            source_name, bookmaker, external_event_id, bookmaker_event_id,
            market_type, line, selection, odds, snapshot_role, captured_at,
            quality_score, quality_flags, raw_data
          )
          SELECT
            qi.id, $1,
            CASE
              WHEN l.slug LIKE '%world-cup%' OR s.slug = 'soccer' THEN 'soccer'
              ELSE s.slug
            END,
            l.slug,
            $2,
            COALESCE(NULLIF($7::jsonb->>'source', ''), $2),
            NULLIF($7::jsonb->>'bookmaker', ''),
            NULLIF($7::jsonb->>'event_id', ''),
            NULLIF($7::jsonb->>'bookmaker_event_id', ''),
            $3,
            NULL,
            $8,
            $9,
            'manual_shadow',
            qi.captured_at,
            CASE WHEN LOWER($2) LIKE '%manual%' OR LOWER($2) LIKE '%shadow%' THEN 70 ELSE 85 END,
            ARRAY['OBSERVATION_ONLY']::text[]
              || CASE WHEN LOWER($2) LIKE '%manual%' OR LOWER($2) LIKE '%shadow%' THEN ARRAY['MANUAL_OR_SHADOW']::text[] ELSE ARRAY[]::text[] END,
            $7::jsonb
          FROM quote_insert qi
          JOIN v_valid_matches m ON m.id = $1
          JOIN leagues l ON l.id = m.league_id
          JOIN sports s ON s.id = l.sport_id
          ON CONFLICT (market_quote_id, selection) WHERE market_quote_id IS NOT NULL DO NOTHING
          RETURNING id
        `,
        [
          signal.match_id,
          signal.provider ?? "manual_shadow",
          signal.market,
          oddsColumns.home_odds,
          oddsColumns.away_odds,
          oddsColumns.draw_odds,
          rawData,
          snapshotSelection,
          signal.market_odds
        ]
      );
      if (insertObservation.rows.length === 0) {
        summary.duplicates += 1;
        rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "DUPLICATE", reason: "observation_conflict_do_nothing" });
        continue;
      }

      summary.observed += 1;
      rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "OBSERVATION_ONLY", processed: true, flow: "observation_only" });
      continue;
    }

    const duplicate = await db.query(
      `
        SELECT id
        FROM paper_trades
        WHERE match_id = $1
          AND market_type = $2
          AND selection = $3
          AND model_version = $4
        LIMIT 1
      `,
      [signal.match_id, signal.market, signal.selection, modelVersion]
    );
    if (duplicate.rows.length > 0) {
      summary.duplicates += 1;
      rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "DUPLICATE", reason: "match_market_selection_model_exists" });
      continue;
    }

    if (dryRun) {
      summary.would_insert += 1;
      rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "DRY_RUN_WOULD_INSERT", processed: true, flow: "shadow_paper" });
      continue;
    }

    const providerName = signal.provider ?? "manual_shadow";
    const oddsSource = normalizeOddsSource(providerName);
    const rawData = JSON.stringify({
      ...(signal.raw_data ?? {}),
      processed: true,
      flow: "shadow_paper",
      full_provider_name: providerName,
      odds_source_normalized: oddsSource
    });

    const insert = await db.query(
      `
        INSERT INTO paper_trades (
          match_id, league_slug, league_type, home_team, away_team, pick_executed,
          market_type, selection, model_version, odds_source, model_probability,
          market_odds, expected_value, bankroll_allocation, status, raw_data
        ) VALUES ($1, $2, 'football_shadow', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'PENDING', $14::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING id
      `,
      [
        signal.match_id,
        leagueId,
        signal.home_team,
        signal.away_team,
        signal.selection,
        signal.market,
        signal.selection,
        modelVersion,
        oddsSource,
        signal.model_probability,
        signal.market_odds,
        signal.expected_value,
        signal.bankroll_allocation ?? 0.01,
        rawData
      ]
    );
    if (insert.rows.length === 0) {
      summary.duplicates += 1;
      rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "DUPLICATE", reason: "conflict_do_nothing" });
      continue;
    }

    summary.inserted += 1;
    rows.push({ league_id: leagueId, league_name: league.display_name, market: signal.market, dry_run: dryRun, status: "INSERTED", processed: true, flow: "shadow_paper" });
  }

  const byLeagueMarket = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = `${row.league_id ?? "unknown"}:${row.market}`;
    const current = byLeagueMarket.get(key) ?? {
      league_id: row.league_id,
      league_name: row.league_name,
      market: row.market,
      dry_run: dryRun,
      inserted: 0,
      would_insert: 0,
      skipped: 0,
      duplicates: 0,
      blocked: 0,
      errors: 0,
      examples: []
    };
    if (row.status === "INSERTED") current.inserted = Number(current.inserted) + 1;
    if (row.status === "OBSERVATION_ONLY") current.observed = Number(current.observed ?? 0) + 1;
    if (row.status === "DRY_RUN_WOULD_INSERT") current.would_insert = Number(current.would_insert) + 1;
    if (row.status === "DRY_RUN_WOULD_OBSERVE") current.would_observe = Number(current.would_observe ?? 0) + 1;
    if (row.status === "SKIPPED") current.skipped = Number(current.skipped) + 1;
    if (row.status === "DUPLICATE") current.duplicates = Number(current.duplicates) + 1;
    if (row.status === "BLOCKED") current.blocked = Number(current.blocked) + 1;
    const examples = current.examples as FootballFeedRow[];
    if (examples.length < 3) examples.push(row);
    byLeagueMarket.set(key, current);
  }

  return {
    ...summary,
    rows,
    by_league_market: Array.from(byLeagueMarket.values()),
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    real_candidate_count: 0
  };
}




