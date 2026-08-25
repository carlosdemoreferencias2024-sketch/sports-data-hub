import { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { db } from "../../db/index.js";
import { decidePick } from "../../trading/pick-decision-engine.js";
import { confirmMatchup } from "../../trading/matchup-confirmation-engine.js";
import { auditHighEvDuplicate } from "../../trading/high-ev-duplicate-audit.js";
import { getFootballCommandCenter } from "../../trading/football-global-engine.js";
import { getFootballMarketLab, getFootballShadowFeedStatus, processFootballShadowFeed } from "../../trading/football-market-lab.js";
import { settleFootballShadow } from "../../trading/football-shadow-settlement.js";
import { getFootballPendingSettlementMonitor } from "../../trading/football-pending-settlement-monitor.js";
import { getFootballFeedQualityReport } from "../../trading/football-feed-quality-report.js";
import { getFootballTodayUniverse, processFootballTodayUniverse } from "../../trading/football-today-universe.js";
import {
  getFootballConfirmedPickChain,
  getFootballLeagueTrustScores,
  getFootballPlayerIntelligence,
  getFootballReadinessGate,
  getFootballTeamIntelligence
} from "../../trading/football-intelligence.js";
import { getFootballCompetitionRegistry } from "../../trading/football-competition-registry.js";
import { getFootballDataGatewayStatus, hydrateFootballIntelligence, hydrateFootballManualContext } from "../../trading/football-data-gateway.js";
import { processFootballOwnedSignals } from "../../trading/football-owned-signal-api.js";
import {
  buildConsensusForMatch,
  getExpectedLineupEngine,
  getSportsIntelligenceCoreStatus,
  getSportsMatchHistoryContext,
  getSportsPlayerContext,
  getSportsTeamContext,
  recordSourceObservations,
  recordSportsContextData,
  rebuildExpectedLineupsFromHistory
} from "../../trading/sports-intelligence-core.js";
import {
  getHistoricalIntelligenceStatus,
  getMatchHistoricalContext,
  getPlayerHistory,
  getTeamHistory,
  ingestHistoricalMatches,
  ingestPlayerHistory,
  rebuildHistoricalContext
} from "../../trading/sports-historical-intelligence.js";
import { getMatchDataHarvesterStatus, runMatchDataHarvester } from "../../trading/match-data-harvester.js";
import { getBottleneckBySource, getChainPreflightStatus, getMatchPreflightStatus, runChainPreflight, runMatchPreflight } from "../../trading/match-preflight-engine.js";
import { getCandidatePreflightStatus, runCandidatePreflight } from "../../trading/candidate-preflight-engine.js";
import { getClosingWindowWatch } from "../../trading/closing-window-watch.js";
import { getClosingCaptureDraft } from "../../trading/closing-capture-draft.js";
import { getFootballManualLineupStatus, recordFootballManualVerifiedLineup } from "../../trading/football-manual-lineups.js";
import { getManualVerifiedSourceRegistry } from "../../trading/source-registry.js";
import { getManualVerifiedSourceCaptureStatus, recordManualVerifiedSourceCapture } from "../../trading/manual-verified-source-capture.js";
import { getSourceCaptureAssistant, getSourceCaptureAssistantRules, recordSourceCaptureAssistantEvidence } from "../../trading/source-capture-assistant.js";
import { getMlbNearStartHarvesterStatus, runMlbNearStartHarvester } from "../../trading/mlb-near-start-harvester.js";
import { getMlbNearStartSchedule, runMlbNearStartSchedule } from "../../trading/mlb-near-start-schedule.js";
import { getMlbParkWeatherStatus, runMlbParkWeatherContext } from "../../trading/mlb-park-weather-context.js";
import { getMlbFixtureTimeRepairStatus, runMlbFixtureTimeRepair } from "../../trading/mlb-fixture-time-repair.js";
import { getOperationalWindowQueue } from "../../trading/operational-window-orchestrator.js";
import { getOperationalAlerts } from "../../trading/operational-alerts.js";
import { getCleanSampleQueue } from "../../trading/clean-sample-queue.js";
import { loadCalendarTrustDecisions } from "../../trading/calendar-trust-gate.js";
import { getOddsSnapshotCache, recordManualOddsSnapshot } from "../../trading/odds-snapshot-cache.js";
import { getShadowTicketChain } from "../../trading/shadow-ticket-chain.js";
import {
  calculateAndRecordForecastGate,
  getForecastSampleGovernanceStatus
} from "../../trading/forecast-sample-governance.js";
import { sportTaxonomyMap } from "../../trading/sport-taxonomy.js";
import { addDaysToLocalDate, tradingLocalDateWindow } from "../../trading/timezone.js";
import {
  computeFootballFairOdds,
  computeFootballFairOddsV3,
  FOOTBALL_FAIR_ODDS_MODEL_CONFIG,
  FOOTBALL_FAIR_ODDS_V3_CONFIG,
  footballFairOddsArtifactSha256,
  footballFairOddsV3ArtifactSha256,
  type FootballFairOddsContext,
  type FootballFormObservation
} from "../../trading/football-fair-odds-model.js";
import { registerForecastModelVersion } from "../../trading/forecast-chain.js";
import { runNflOwnedFairOdds } from "../../trading/nfl-fair-odds-service.js";
import { runNbaOwnedFairOdds } from "../../trading/nba-fair-odds-service.js";
import { runNbaNearStartContext } from "../../trading/nba-near-start-service.js";

const ACTIVE_FOOTBALL_FAIR_ODDS_MODEL = process.env.FOOTBALL_FAIR_ODDS_ACTIVE_VERSION === "v2"
  ? "sports_data_hub_football_fair_odds_v2"
  : "sports_data_hub_football_fair_odds_v3";
const ACTIVE_FOOTBALL_FAIR_ODDS_VERSION = process.env.FOOTBALL_FAIR_ODDS_ACTIVE_VERSION === "v2" ? "v2" : "v3";

const consensusQuerySchema = z.object({
  sport: z.string().min(1).max(40).optional(),
  league_slug: z.string().min(1).max(80).optional(),
  market_type: z.string().min(1).max(80).optional(),
  min_quality: z.coerce.number().min(0).max(100).default(80),
  max_age_hours: z.coerce.number().int().positive().max(24 * 30).default(72),
  min_books: z.coerce.number().int().min(1).max(20).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const backtestQuerySchema = z.object({
  sport: z.string().min(1).max(40).default("baseball"),
  league_slug: z.string().min(1).max(80).default("mlb"),
  market_type: z.string().min(1).max(80).default("moneyline_2way"),
  min_model_probability: z.coerce.number().min(0).max(1).default(0.60),
  min_ev: z.coerce.number().min(-1).max(10).default(0.05),
  min_odds: z.coerce.number().min(1).max(100).default(2.01),
  pick: z.string().min(1).max(40).optional(),
  bookmaker: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000)
});

const registryQuerySchema = z.object({
  status: z.enum(["active", "frozen", "candidate", "retired"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

function booleanQuery(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return defaultValue;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "y", "si", "sí", "on"].includes(normalized)) {
        return true;
      }
      if (["false", "0", "no", "n", "off"].includes(normalized)) {
        return false;
      }
    }
    return value;
  }, z.boolean()).default(defaultValue);
}

const ruleExplorerQuerySchema = z.object({
  active_only: booleanQuery(true),
  min_closed: z.coerce.number().int().min(1).max(1000).default(1),
  persist: booleanQuery(false),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const ruleWatchlistQuerySchema = z.object({
  status: z.enum(["watch", "hot", "cooling", "rejected", "ready_for_real_paper_plus", "reviewed", "retired"]).default("watch"),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const governanceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

const MIN_BRIER_CLOSED_SAMPLE = 20;
const MIN_LOG_LOSS_CLOSED_SAMPLE = 20;
const MIN_SEGMENT_PROMOTION_SAMPLE = 30;
const MIN_TRAINER_SAMPLE = 50;

const footballPerformanceSegmentsQuerySchema = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  min_closed: z.coerce.number().int().min(1).max(500).default(MIN_SEGMENT_PROMOTION_SAMPLE),
  limit: z.coerce.number().int().min(1).max(500).default(120)
});

const matchOpsQuerySchema = z.object({
  date: z.string().optional(),
  sport: z.string().optional(),
  window: z.string().optional(),
  apply: booleanQuery(false),
  include_backlog: booleanQuery(false),
  current_slate_only: booleanQuery(true),
  include_legacy: booleanQuery(false),
  limit: z.coerce.number().int().min(1).max(300).default(120)
});

const candidatePreflightQuerySchema = z.object({
  match_id: z.string().uuid().optional(),
  decision_as_of: z.string().datetime({ offset: true }).optional(),
  date: z.string().optional(),
  sport: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(300).default(120)
});

function mergeQueryBody(query: unknown, body: unknown) {
  return {
    ...((query ?? {}) as Record<string, unknown>),
    ...((body ?? {}) as Record<string, unknown>)
  };
}

function localDateWindow(date?: string) {
  return tradingLocalDateWindow(date);
}

function shiftLocalDate(date: string, offsetDays: number) {
  return addDaysToLocalDate(date, offsetDays);
}

const staleArchiveQuerySchema = z.object({
  apply: booleanQuery(false),
  dry_run: booleanQuery(true),
  max_age_hours: z.coerce.number().int().min(1).max(24 * 365).default(24),
  sport: z.string().min(1).max(40).default("baseball"),
  league_slug: z.string().min(1).max(80).default("mlb"),
  market_type: z.string().min(1).max(80).default("moneyline_2way"),
  reason: z.string().min(1).max(80).default("stale_line"),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const freshArchiveQuerySchema = z.object({
  apply: booleanQuery(false),
  max_age_minutes: z.coerce.number().int().min(5).max(24 * 60).default(30),
  duplicate_window_minutes: z.coerce.number().int().min(1).max(24 * 60).default(30),
  sport: z.string().min(1).max(40).default("baseball"),
  league_slug: z.string().min(1).max(80).default("mlb"),
  market_type: z.string().min(1).max(80).default("moneyline_2way"),
  limit: z.coerce.number().int().min(1).max(1000).default(250)
});

const dataQualityQuerySchema = z.object({
  apply: booleanQuery(false),
  sport: z.string().min(1).max(40).default("baseball"),
  league_slug: z.string().min(1).max(80).default("mlb"),
  market_type: z.string().min(1).max(80).default("moneyline_2way"),
  limit: z.coerce.number().int().min(1).max(1000).default(250)
});

const confirmedVsEvQuerySchema = z.object({
  sport: z.string().min(1).max(40).default("baseball"),
  league_slug: z.string().min(1).max(80).default("mlb"),
  market_type: z.string().min(1).max(80).default("moneyline_2way"),
  min_sample_size: z.coerce.number().int().min(5).max(1000).default(150),
  limit: z.coerce.number().int().min(1).max(5000).default(2000)
});

const evOutlierQuerySchema = z.object({
  apply: booleanQuery(false),
  sport: z.string().min(1).max(40).default("baseball"),
  league_slug: z.string().min(1).max(80).default("mlb"),
  market_type: z.string().min(1).max(80).default("moneyline_2way"),
  lookback_days: z.coerce.number().int().min(7).max(365).default(60),
  stddev_multiplier: z.coerce.number().min(1).max(5).default(2),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});
const manualAlertQuerySchema = z.object({
  persist: booleanQuery(false),
  grade: z.enum(["A", "B", "C", "D", "F"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12)
});

function addFilter(values: Array<string | number>, filters: string[], column: string, value?: string) {
  if (value) {
    filters.push(`${column} = $${values.push(value)}`);
  }
}

const ruleExplorerSql = `
  WITH rule_results AS (
    SELECT
      br.id,
      br.rule_key,
      br.rule_name,
      br.sport_slug,
      br.league_slug,
      br.market_type,
      br.min_model_probability,
      br.min_ev,
      br.min_odds,
      br.max_odds,
      br.pick,
      br.bookmaker,
      br.min_closed,
      br.sample_limit,
      br.is_active,
      br.notes,
      bw.status AS watchlist_status,
      bw.promoted_at AS watchlist_promoted_at,
      COALESCE(sample.closed, 0)::int AS closed,
      COALESCE(sample.wins, 0)::int AS wins,
      COALESCE(sample.losses, 0)::int AS losses,
      COALESCE(sample.pushes, 0)::int AS pushes,
      sample.avg_entry_odds,
      sample.avg_closing_odds,
      sample.avg_model_probability,
      sample.avg_expected_value,
      sample.avg_clv,
      COALESCE(sample.positive_clv, 0)::int AS positive_clv,
      COALESCE(sample.profit_units, 0)::numeric AS profit_units,
      sample.first_pick_at,
      sample.last_pick_at
    FROM backtest_rules br
    LEFT JOIN backtest_rule_watchlist bw ON bw.rule_id = br.id AND bw.status = 'watch'
    LEFT JOIN LATERAL (
      WITH sample AS (
        SELECT *
        FROM real_paper_snapshots rps
        WHERE rps.sport_slug = br.sport_slug
          AND rps.league_slug = br.league_slug
          AND rps.market_type = br.market_type
          AND rps.model_probability >= br.min_model_probability
          AND rps.expected_value >= br.min_ev
          AND rps.entry_odds >= br.min_odds
          AND (br.max_odds IS NULL OR rps.entry_odds <= br.max_odds)
          AND (br.pick IS NULL OR rps.pick = br.pick)
          AND (br.bookmaker IS NULL OR rps.bookmaker = br.bookmaker)
          AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
        ORDER BY rps.entry_timestamp DESC
        LIMIT br.sample_limit
      )
      SELECT
        COUNT(*)::int AS closed,
        COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
        COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
        COUNT(*) FILTER (WHERE status = 'PUSH')::int AS pushes,
        ROUND(AVG(entry_odds)::numeric, 4) AS avg_entry_odds,
        ROUND(AVG(closing_odds) FILTER (WHERE closing_odds IS NOT NULL)::numeric, 4) AS avg_closing_odds,
        ROUND(AVG(model_probability)::numeric, 6) AS avg_model_probability,
        ROUND(AVG(expected_value)::numeric, 6) AS avg_expected_value,
        ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
        COUNT(*) FILTER (WHERE clv > 0)::int AS positive_clv,
        ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
        MIN(entry_timestamp) AS first_pick_at,
        MAX(entry_timestamp) AS last_pick_at
      FROM sample
    ) sample ON TRUE
    WHERE ($1::boolean = FALSE OR br.is_active = TRUE)
  )
  SELECT
    *,
    CASE WHEN wins + losses > 0 THEN ROUND((wins::numeric / (wins + losses)), 6) ELSE NULL END AS win_rate,
    CASE WHEN closed > 0 THEN ROUND((positive_clv::numeric / closed), 6) ELSE NULL END AS positive_clv_rate,
    CASE
      WHEN closed < GREATEST(min_closed, $2::int) THEN 'ACCUMULATE'
      WHEN COALESCE(avg_clv, 0) > 0 AND profit_units > 0 THEN 'PROMOTE_TO_WATCHLIST'
      WHEN profit_units > 0 THEN 'PROFIT_ONLY_REVIEW'
      WHEN COALESCE(avg_clv, 0) > 0 THEN 'CLV_ONLY_REVIEW'
      ELSE 'RULE_REJECTED'
    END AS decision,
    CASE
      WHEN closed < GREATEST(min_closed, $2::int) THEN 'Keep accumulating'
      WHEN COALESCE(avg_clv, 0) > 0 AND profit_units > 0 THEN 'Promote to watchlist'
      WHEN profit_units > 0 THEN 'Profit positive, CLV review'
      WHEN COALESCE(avg_clv, 0) > 0 THEN 'CLV positive, profit review'
      ELSE 'Reject or keep in shadow'
    END AS recommendation,
    ROUND(
      (
        CASE WHEN closed >= GREATEST(min_closed, $2::int) THEN 100 ELSE closed::numeric END
        + COALESCE(profit_units, 0) / 10
        + COALESCE(avg_clv, 0) * 1000
        + COALESCE((CASE WHEN wins + losses > 0 THEN wins::numeric / (wins + losses) ELSE 0 END), 0) * 50
        + COALESCE((CASE WHEN closed > 0 THEN positive_clv::numeric / closed ELSE 0 END), 0) * 25
      )::numeric,
      4
    ) AS rule_score
  FROM rule_results
  ORDER BY
    CASE
      WHEN closed >= GREATEST(min_closed, $2::int) AND COALESCE(avg_clv, 0) > 0 AND profit_units > 0 THEN 0
      WHEN closed >= GREATEST(min_closed, $2::int) THEN 1
      ELSE 2
    END,
    rule_score DESC,
    closed DESC
  LIMIT $3
`;

async function buildSafetySuiteStatus() {
  const candidates = [
    process.env.SAFETY_SUITE_REPORT_PATH,
    path.resolve(process.cwd(), "uploads", "safety-suite", "latest.json"),
    path.resolve(process.cwd(), "backend", "uploads", "safety-suite", "latest.json"),
    path.join(os.tmpdir(), "sports-data-hub-safety-suite-latest.json")
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as Record<string, any>;
      const ok = parsed.system_status === "SAFETY_SUITE_OK";
      return {
        system_status: ok ? "SAFETY_SUITE_OK" : "SAFETY_SUITE_FAILED",
        source: "latest_report",
        report_path: candidate,
        checked_at: parsed.finished_at || parsed.checked_at || null,
        age_seconds: parsed.finished_at ? Math.max(0, Math.round((Date.now() - new Date(parsed.finished_at).getTime()) / 1000)) : null,
        results: parsed.results || [],
        recommendation: ok ? "Safety Suite OK: sistema seguro para observacion/captura. No significa pick listo." : "Safety Suite fallo: detener operacion y revisar el paso fallido.",
        guardrails: {
          real_candidate_count: 0,
          real_money_enabled: false,
          kelly_enabled: false,
          telegram_auto_enabled: false,
          auto_post_allowed: false,
          kill_switch_enabled: true
        }
      };
    } catch {
      // Try the next path.
    }
  }

  return {
    system_status: "SAFETY_SUITE_NO_REPORT_YET",
    source: "runtime_guardrails_only",
    report_path: null,
    checked_at: new Date().toISOString(),
    age_seconds: null,
    results: [
      { name: "dashboard_runtime", code: 0 },
      { name: "guardrails_default", code: 0 }
    ],
    recommendation: "No hay reporte latest.json visible para el backend. Corre scripts\\run_safety_suite.cmd antes de operar slate.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      auto_post_allowed: false,
      kill_switch_enabled: true
    }
  };
}
export async function analyticsRoutes(app: FastifyInstance) {
  const addPublicAnalyticsAlias = (publicPath: string, internalPath: string) => {
    app.get(publicPath, async (request, reply) => {
      const queryString = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
      const apiKey = request.headers["x-api-key"] ?? request.headers["x-internal-api-key"] ?? "";
      const response = await app.inject({
        method: "GET",
        url: `${internalPath}${queryString}`,
        headers: {
          "x-internal-api-key": Array.isArray(apiKey) ? apiKey[0] ?? "" : String(apiKey)
        }
      });
      const contentType = response.headers["content-type"];
      if (contentType) reply.header("content-type", contentType);
      reply.code(response.statusCode);
      try {
        return JSON.parse(response.payload);
      } catch {
        return response.payload;
      }
    });
  };

  addPublicAnalyticsAlias("/api/v1/trading/market-promotion", "/api/v1/internal/analytics/market-promotion-rules");
  addPublicAnalyticsAlias("/api/trading/market-promotion", "/api/v1/internal/analytics/market-promotion-rules");
  addPublicAnalyticsAlias("/api/v1/trading/pilot-checklist", "/api/v1/internal/analytics/pilot-checklist");
  addPublicAnalyticsAlias("/api/trading/pilot-checklist", "/api/v1/internal/analytics/pilot-checklist");
  addPublicAnalyticsAlias("/api/v1/trading/manual-alert-report", "/api/v1/internal/analytics/manual-alert-report");
  addPublicAnalyticsAlias("/api/trading/manual-alert-report", "/api/v1/internal/analytics/manual-alert-report");

  app.get("/api/v1/internal/analytics/odds-consensus", async (request) => {
    const query = consensusQuerySchema.parse(request.query);
    const values: Array<string | number> = [query.min_quality, query.max_age_hours, query.min_books, query.limit];
    const filters: string[] = [
      "os.quality_score >= $1",
      "os.snapshot_role IN ('market', 'entry', 'live')",
      "os.captured_at >= NOW() - ($2::int * INTERVAL '1 hour')"
    ];
    addFilter(values, filters, "os.sport_slug", query.sport);
    addFilter(values, filters, "os.league_slug", query.league_slug);
    addFilter(values, filters, "os.market_type", query.market_type);

    const result = await db.query(
      `
        WITH latest AS (
          SELECT DISTINCT ON (
            os.match_id,
            os.market_type,
            COALESCE(os.line, -9999),
            os.selection,
            os.provider_name,
            COALESCE(os.bookmaker, os.provider_name)
          )
            os.*
          FROM odds_snapshots os
          WHERE ${filters.join(" AND ")}
          ORDER BY
            os.match_id,
            os.market_type,
            COALESCE(os.line, -9999),
            os.selection,
            os.provider_name,
            COALESCE(os.bookmaker, os.provider_name),
            os.captured_at DESC
        ),
        grouped AS (
          SELECT
            l.match_id,
            l.sport_slug,
            l.league_slug,
            l.market_type,
            l.line,
            l.selection,
            COUNT(DISTINCT COALESCE(l.bookmaker, l.provider_name))::int AS provider_count,
            ROUND(AVG(l.odds)::numeric, 4) AS consensus_odds,
            ROUND(MIN(l.odds)::numeric, 4) AS min_odds,
            ROUND(MAX(l.odds)::numeric, 4) AS max_odds,
            ROUND(COALESCE(STDDEV_POP(l.odds), 0)::numeric, 6) AS odds_stddev,
            ROUND(AVG(l.quality_score)::numeric, 2) AS avg_quality_score,
            MAX(l.captured_at) AS latest_captured_at,
            ARRAY_AGG(DISTINCT COALESCE(l.bookmaker, l.provider_name)) AS providers
          FROM latest l
          GROUP BY l.match_id, l.sport_slug, l.league_slug, l.market_type, l.line, l.selection
        )
        SELECT
          g.*,
          m.slug AS match_slug,
          home.name AS home_team_name,
          away.name AS away_team_name,
          CONCAT(home.name, ' vs ', away.name) AS match,
          CASE
            WHEN g.provider_count >= 2 AND g.max_odds / NULLIF(g.min_odds, 0) - 1 >= 0.12 THEN 'ODDS_DISPERSION'
            WHEN g.avg_quality_score < 90 THEN 'QUALITY_WATCH'
            ELSE 'CLEAN'
          END AS consensus_status,
          ROUND(
            LEAST(100, GREATEST(0,
              g.avg_quality_score
              + LEAST(g.provider_count, 5) * 2
              - CASE WHEN g.provider_count >= 2 AND g.max_odds / NULLIF(g.min_odds, 0) - 1 >= 0.12 THEN 15 ELSE 0 END
            ))::numeric,
            2
          ) AS consensus_score
        FROM grouped g
        JOIN v_valid_matches m ON m.id = g.match_id
        LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'home'
        LEFT JOIN teams home ON home.id = mh.team_id
        LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'away'
        LEFT JOIN teams away ON away.id = ma.team_id
        WHERE g.provider_count >= $3
        ORDER BY g.latest_captured_at DESC, consensus_score DESC
        LIMIT $4
      `,
      values
    );

    return {
      filters: query,
      count: result.rows.length,
      rows: result.rows,
      guardrails: {
        alpha_clean_threshold: 80,
        real_money_enabled: false
      }
    };
  });

  app.get("/api/v1/internal/analytics/market-lab", async (request) => {
    const query = consensusQuerySchema.parse(request.query);
    const values: Array<string | number> = [query.min_quality, query.max_age_hours, query.limit];
    const filters: string[] = [
      "quality_score >= $1",
      "captured_at >= NOW() - ($2::int * INTERVAL '1 hour')"
    ];
    addFilter(values, filters, "sport_slug", query.sport);
    addFilter(values, filters, "league_slug", query.league_slug);
    addFilter(values, filters, "market_type", query.market_type);

    const result = await db.query(
      `
        SELECT
          sport_slug,
          league_slug,
          market_type,
          snapshot_role,
          COUNT(*)::int AS snapshots,
          COUNT(DISTINCT match_id)::int AS matches,
          COUNT(DISTINCT COALESCE(bookmaker, provider_name))::int AS providers,
          ROUND(AVG(quality_score)::numeric, 2) AS avg_quality_score,
          COUNT(*) FILTER (WHERE quality_score >= 80)::int AS clean_snapshots,
          COUNT(*) FILTER (WHERE quality_score < 80)::int AS review_snapshots,
          ROUND(AVG(odds)::numeric, 4) AS avg_odds,
          ROUND(MIN(odds)::numeric, 4) AS min_odds,
          ROUND(MAX(odds)::numeric, 4) AS max_odds,
          MAX(captured_at) AS latest_captured_at
        FROM odds_snapshots
        WHERE ${filters.join(" AND ")}
        GROUP BY sport_slug, league_slug, market_type, snapshot_role
        ORDER BY latest_captured_at DESC, snapshots DESC
        LIMIT $3
      `,
      values
    );

    return { filters: query, count: result.rows.length, rows: result.rows };
  });

  app.get("/api/v1/internal/analytics/backtest-lab", async (request) => {
    const query = backtestQuerySchema.parse(request.query);
    const values: Array<string | number> = [
      query.sport,
      query.league_slug,
      query.market_type,
      query.min_model_probability,
      query.min_ev,
      query.min_odds,
      query.limit
    ];
    const filters: string[] = [
      "sport_slug = $1",
      "league_slug = $2",
      "market_type = $3",
      "model_probability >= $4",
      "expected_value >= $5",
      "entry_odds >= $6",
      "status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')"
    ];
    addFilter(values, filters, "pick", query.pick);
    addFilter(values, filters, "bookmaker", query.bookmaker);

    const result = await db.query(
      `
        WITH sample AS (
          SELECT *
          FROM real_paper_snapshots
          WHERE ${filters.join(" AND ")}
          ORDER BY entry_timestamp DESC
          LIMIT $7
        )
        SELECT
          COUNT(*)::int AS closed,
          COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
          COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
          COUNT(*) FILTER (WHERE status = 'PUSH')::int AS pushes,
          ROUND(AVG(entry_odds)::numeric, 4) AS avg_entry_odds,
          ROUND(AVG(closing_odds) FILTER (WHERE closing_odds IS NOT NULL)::numeric, 4) AS avg_closing_odds,
          ROUND(AVG(model_probability)::numeric, 6) AS avg_model_probability,
          ROUND(AVG(expected_value)::numeric, 6) AS avg_expected_value,
          ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
          COUNT(*) FILTER (WHERE clv > 0)::int AS positive_clv,
          ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
          MIN(entry_timestamp) AS first_pick_at,
          MAX(entry_timestamp) AS last_pick_at
        FROM sample
      `,
      values
    );
    const row = result.rows[0] ?? {};
    const closed = Number(row.closed ?? 0);
    const wins = Number(row.wins ?? 0);
    const losses = Number(row.losses ?? 0);
    const positiveClv = Number(row.positive_clv ?? 0);

    return {
      filters: query,
      summary: {
        ...row,
        win_rate: wins + losses > 0 ? wins / (wins + losses) : null,
        positive_clv_rate: closed > 0 ? positiveClv / closed : null,
        decision:
          closed < 50
            ? "ACCUMULATE"
            : Number(row.avg_clv ?? 0) > 0 && Number(row.profit_units ?? 0) > 0
              ? "RULE_PASSED_REVIEW"
              : "RULE_NEEDS_REVIEW"
      },
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false
      }
    };
  });

  app.get("/api/v1/internal/analytics/backtest-rules", async (request) => {
    const query = ruleExplorerQuerySchema.parse(request.query);
    const values: Array<string | number | boolean> = [query.limit];
    const activeFilter = query.active_only ? "WHERE is_active = TRUE" : "";
    const result = await db.query(
      `
        SELECT *
        FROM backtest_rules
        ${activeFilter}
        ORDER BY is_active DESC, rule_key
        LIMIT $1
      `,
      values
    );
    return { filters: query, count: result.rows.length, rows: result.rows };
  });

  app.get("/api/v1/internal/analytics/rule-explorer", async (request) => {
    const query = ruleExplorerQuerySchema.parse(request.query);
    const result = await db.query(ruleExplorerSql, [query.active_only, query.min_closed, query.limit]);

    let watchlistPromoted = 0;
    if (query.persist) {
      for (const row of result.rows) {
        await db.query(
          `
            INSERT INTO backtest_runs (run_name, sport_slug, league_slug, market_type, filters, results)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
          `,
          [
            row.rule_key,
            row.sport_slug,
            row.league_slug,
            row.market_type,
            JSON.stringify({
              rule_key: row.rule_key,
              min_model_probability: row.min_model_probability,
              min_ev: row.min_ev,
              min_odds: row.min_odds,
              max_odds: row.max_odds,
              pick: row.pick,
              bookmaker: row.bookmaker,
              min_closed: row.min_closed,
              sample_limit: row.sample_limit
            }),
            JSON.stringify({
              closed: row.closed,
              wins: row.wins,
              losses: row.losses,
              pushes: row.pushes,
              win_rate: row.win_rate,
              positive_clv_rate: row.positive_clv_rate,
              avg_entry_odds: row.avg_entry_odds,
              avg_closing_odds: row.avg_closing_odds,
              avg_model_probability: row.avg_model_probability,
              avg_expected_value: row.avg_expected_value,
              avg_clv: row.avg_clv,
              positive_clv: row.positive_clv,
              profit_units: row.profit_units,
              decision: row.decision,
              rule_score: row.rule_score
            })
          ]
        );

        if (row.decision === "PROMOTE_TO_WATCHLIST") {
          await db.query(
            `
              INSERT INTO backtest_rule_watchlist (
                rule_id,
                rule_key,
                status,
                promoted_reason,
                metrics
              )
              VALUES ($1, $2, 'watch', $3, $4::jsonb)
              ON CONFLICT (rule_id) DO UPDATE SET
                status = 'watch',
                rule_key = EXCLUDED.rule_key,
                promoted_reason = EXCLUDED.promoted_reason,
                metrics = EXCLUDED.metrics,
                updated_at = NOW()
            `,
            [
              row.id,
              row.rule_key,
              "50+ closed with positive profit and positive CLV",
              JSON.stringify({
                closed: row.closed,
                wins: row.wins,
                losses: row.losses,
                pushes: row.pushes,
                win_rate: row.win_rate,
                positive_clv_rate: row.positive_clv_rate,
                avg_entry_odds: row.avg_entry_odds,
                avg_closing_odds: row.avg_closing_odds,
                avg_model_probability: row.avg_model_probability,
                avg_expected_value: row.avg_expected_value,
                avg_clv: row.avg_clv,
                positive_clv: row.positive_clv,
                profit_units: row.profit_units,
                rule_score: row.rule_score,
                recommendation: row.recommendation
              })
            ]
          );
          watchlistPromoted += 1;
        }
      }
    }

    if (!query.persist) {
      for (const row of result.rows) {
        if (row.decision !== "PROMOTE_TO_WATCHLIST") continue;
        await db.query(
          `
            INSERT INTO backtest_rule_watchlist (
              rule_id,
              rule_key,
              status,
              promoted_reason,
              metrics
            )
            VALUES ($1, $2, 'watch', $3, $4::jsonb)
            ON CONFLICT (rule_id) DO UPDATE SET
              status = 'watch',
              rule_key = EXCLUDED.rule_key,
              promoted_reason = EXCLUDED.promoted_reason,
              metrics = EXCLUDED.metrics,
              updated_at = NOW()
          `,
          [
            row.id,
            row.rule_key,
            "50+ closed with positive profit and positive CLV",
            JSON.stringify({
              closed: row.closed,
              wins: row.wins,
              losses: row.losses,
              pushes: row.pushes,
              win_rate: row.win_rate,
              positive_clv_rate: row.positive_clv_rate,
              avg_entry_odds: row.avg_entry_odds,
              avg_closing_odds: row.avg_closing_odds,
              avg_model_probability: row.avg_model_probability,
              avg_expected_value: row.avg_expected_value,
              avg_clv: row.avg_clv,
              positive_clv: row.positive_clv,
              profit_units: row.profit_units,
              rule_score: row.rule_score,
              recommendation: row.recommendation
            })
          ]
        );
        watchlistPromoted += 1;
      }
    }

    return {
      filters: query,
      count: result.rows.length,
      rows: result.rows,
      persisted: query.persist ? result.rows.length : 0,
      watchlist_promoted: watchlistPromoted,
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false
      }
    };
  });

  app.get("/api/v1/internal/analytics/rule-watchlist", async (request) => {
    const query = ruleWatchlistQuerySchema.parse(request.query);
    const result = await db.query(
      `
        SELECT
          bw.id,
          bw.rule_id,
          bw.rule_key,
          bw.status,
          bw.promoted_reason,
          bw.metrics,
          bw.promoted_at,
          bw.updated_at,
          br.rule_name,
          br.sport_slug,
          br.league_slug,
          br.market_type,
          br.min_model_probability,
          br.min_ev,
          br.min_odds,
          br.max_odds,
          br.pick,
          br.bookmaker,
          br.min_closed,
          br.sample_limit,
          br.is_active
        FROM backtest_rule_watchlist bw
        JOIN backtest_rules br ON br.id = bw.rule_id
        WHERE bw.status = $1
        ORDER BY
          COALESCE((bw.metrics->>'rule_score')::numeric, 0) DESC,
          bw.promoted_at DESC
        LIMIT $2
      `,
      [query.status, query.limit]
    );

    return {
      filters: query,
      count: result.rows.length,
      rows: result.rows,
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false
      }
    };
  });

  app.get("/api/v1/internal/analytics/formal-mlb-75-audit", async () => {
    const result = await db.query(
      `
        WITH base AS (
          SELECT
            'overall'::text AS group_type,
            'all'::text AS group_value,
            *
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
          UNION ALL
          SELECT
            'price_role',
            CASE
              WHEN entry_odds >= 2.0501 THEN 'underdogs'
              WHEN entry_odds <= 1.9499 THEN 'favorites'
              ELSE 'pickem'
            END,
            *
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
          UNION ALL
          SELECT 'pick', pick, *
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
          UNION ALL
          SELECT 'odds_band', CASE WHEN entry_odds >= 2.01 THEN 'odds_2_01_plus' ELSE 'odds_under_2_01' END, *
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
          UNION ALL
          SELECT
            'model_prob',
            CASE
              WHEN model_probability >= 0.60 THEN 'prob_60_plus'
              WHEN model_probability >= 0.55 THEN 'prob_55_60'
              ELSE 'prob_52_55'
            END,
            *
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
          UNION ALL
          SELECT
            'clv_sign',
            CASE WHEN COALESCE(clv, 0) > 0 THEN 'clv_positive' ELSE 'clv_flat_or_negative' END,
            *
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
        )
        SELECT
          group_type,
          group_value,
          COUNT(*)::int AS closed,
          COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
          COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
          COUNT(*) FILTER (WHERE status = 'PUSH')::int AS pushes,
          ROUND(AVG(entry_odds)::numeric, 4) AS avg_entry_odds,
          ROUND(AVG(closing_odds) FILTER (WHERE closing_odds IS NOT NULL)::numeric, 4) AS avg_closing_odds,
          ROUND(AVG(model_probability)::numeric, 6) AS avg_model_probability,
          ROUND(AVG(expected_value)::numeric, 6) AS avg_expected_value,
          ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
          COUNT(*) FILTER (WHERE clv > 0)::int AS positive_clv,
          ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
          CASE WHEN COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS')) > 0
            THEN ROUND((COUNT(*) FILTER (WHERE status = 'WIN')::numeric / COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS'))), 6)
            ELSE NULL
          END AS win_rate,
          CASE WHEN COUNT(*) > 0 THEN ROUND((COUNT(*) FILTER (WHERE clv > 0)::numeric / COUNT(*)), 6) ELSE NULL END AS positive_clv_rate,
          CASE
            WHEN COUNT(*) < 75 AND group_type = 'overall' THEN 'NO_APTO_ACCUMULATE'
            WHEN COUNT(*) < 20 AND group_type <> 'overall' THEN 'NO_APTO_SMALL_SAMPLE'
            WHEN COALESCE(AVG(clv) FILTER (WHERE clv IS NOT NULL), 0) > 0 AND COALESCE(SUM(profit_loss), 0) > 0 THEN 'APTO_REVIEW'
            WHEN COALESCE(SUM(profit_loss), 0) > 0 THEN 'NO_APTO_CLV_REVIEW'
            WHEN COALESCE(AVG(clv) FILTER (WHERE clv IS NOT NULL), 0) > 0 THEN 'NO_APTO_PROFIT_REVIEW'
            ELSE 'NO_APTO'
          END AS recommendation
        FROM base
        GROUP BY group_type, group_value
        ORDER BY
          CASE group_type
            WHEN 'overall' THEN 0
            WHEN 'price_role' THEN 1
            WHEN 'pick' THEN 2
            WHEN 'odds_band' THEN 3
            WHEN 'model_prob' THEN 4
            WHEN 'clv_sign' THEN 5
            ELSE 6
          END,
          closed DESC
      `
    );

    const overall = result.rows.find((row) => row.group_type === "overall");
    return {
      count: result.rows.length,
      overall,
      rows: result.rows,
      final_recommendation:
        overall?.recommendation === "APTO_REVIEW"
          ? "APTO_PARA_REVISION_MANUAL_NO_DINERO_REAL"
          : "NO_APTO_SEGUIR_ACUMULANDO",
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false
      }
    };
  });

  app.get("/api/v1/internal/analytics/market-promotion-rules", async () => {
    const result = await db.query(
      `
        WITH metrics AS (
          SELECT
            'mlb_moneyline' AS rule_key,
            'baseball' AS sport_slug,
            'mlb' AS league_slug,
            'moneyline_2way' AS market_type,
            'overall' AS segment,
            75 AS required_closed,
            COUNT(*)::int AS current_closed,
            ROUND((COALESCE(SUM(profit_loss), 0) / 100.0)::numeric, 4) AS profit_units,
            ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
          UNION ALL
          SELECT
            'mlb_underdogs',
            'baseball',
            'mlb',
            'moneyline_2way',
            'underdogs',
            50,
            COUNT(*)::int,
            ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4),
            ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6)
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND entry_odds >= 2.0100
            AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
          UNION ALL
          SELECT 'mlb_totals', 'baseball', 'mlb', 'total_runs', 'overall', 50, 17, -381.0000, NULL
          UNION ALL
          SELECT 'mlb_run_line', 'baseball', 'mlb', 'run_line', 'overall', 50, 37, 10802.0000, NULL
          UNION ALL
          SELECT
            'worldcup_shadow',
            'soccer',
            'fifa-world-cup-2026',
            'multi_market',
            'overall',
            50,
            COALESCE(MIN(closed), 0)::int,
            COALESCE(SUM(profit_units), 0)::numeric,
            NULL
          FROM (
            SELECT market_type, COUNT(*)::int AS closed, COALESCE(SUM(net_profit), 0)::numeric AS profit_units
            FROM paper_trades
            WHERE league_type = 'soccer'
              AND league_slug = 'fifa-world-cup-2026'
              AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
            GROUP BY market_type
          ) wc
          UNION ALL
          SELECT
            'worldcup_btts',
            'soccer',
            'fifa-world-cup-2026',
            'btts',
            'overall',
            50,
            COUNT(*)::int,
            COALESCE(SUM(net_profit), 0)::numeric,
            NULL
          FROM paper_trades
          WHERE league_type = 'soccer'
            AND league_slug = 'fifa-world-cup-2026'
            AND market_type = 'btts'
            AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
        ),
        decisions AS (
          SELECT
            *,
            CASE
              WHEN rule_key = 'mlb_moneyline' AND current_closed >= required_closed AND COALESCE(avg_clv, 0) > 0 AND profit_units > 0 THEN 'READY_FOR_REVIEW'
              WHEN rule_key = 'mlb_underdogs' AND current_closed < required_closed THEN 'WAITING_SAMPLE'
              WHEN rule_key = 'mlb_underdogs' AND COALESCE(avg_clv, 0) > 0 AND profit_units > 0 THEN 'WATCHLIST_READY'
              WHEN rule_key IN ('mlb_totals', 'mlb_run_line', 'worldcup_btts') THEN 'BLOCKED'
              ELSE 'ACCUMULATING'
            END AS status,
            CASE
              WHEN rule_key = 'mlb_moneyline' THEN 'MLB Moneyline listo para revision manual, no para dinero real.'
              WHEN rule_key = 'mlb_underdogs' THEN 'Esperando 50 cerradas con profit y CLV positivo.'
              WHEN rule_key = 'mlb_totals' THEN 'Bloqueado: performance insuficiente en totals.'
              WHEN rule_key = 'mlb_run_line' THEN 'Bloqueado: run line requiere limpieza y convencion estable.'
              WHEN rule_key = 'worldcup_btts' THEN 'Bloqueado/Cooling: Mundial BTTS va negativo; no promover hasta nueva auditoria.'
              ELSE 'Mundial sigue acumulando hasta minimo 50 cerradas por mercado.'
            END AS recommendation,
            CASE
              WHEN rule_key IN ('mlb_totals', 'mlb_run_line', 'worldcup_btts') THEN 'market_blocked'
              WHEN current_closed < required_closed THEN 'sample_below_threshold'
              WHEN COALESCE(avg_clv, 0) <= 0 THEN 'clv_not_positive'
              WHEN profit_units <= 0 THEN 'profit_not_positive'
              ELSE NULL
            END AS guardrail_reason
          FROM metrics
        )
        INSERT INTO market_promotion_rules (
          rule_key,
          sport_slug,
          league_slug,
          market_type,
          segment,
          status,
          required_closed,
          current_closed,
          min_profit_units,
          min_avg_clv,
          recommendation,
          guardrail_reason,
          metrics,
          updated_at
        )
        SELECT
          rule_key,
          sport_slug,
          league_slug,
          market_type,
          segment,
          status,
          required_closed,
          current_closed,
          0,
          0,
          recommendation,
          guardrail_reason,
          jsonb_build_object('profit_units', profit_units, 'avg_clv', avg_clv),
          NOW()
        FROM decisions
        ON CONFLICT (rule_key) DO UPDATE SET
          status = EXCLUDED.status,
          current_closed = EXCLUDED.current_closed,
          recommendation = EXCLUDED.recommendation,
          guardrail_reason = EXCLUDED.guardrail_reason,
          metrics = EXCLUDED.metrics,
          updated_at = NOW()
        RETURNING *
      `
    );

    return {
      count: result.rows.length,
      rows: result.rows,
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false
      }
    };
  });

  app.get("/api/v1/internal/analytics/no-bet-intelligence", async () => {
    const result = await db.query(
      `
        WITH insights AS (
          SELECT 'market_promotion' AS source, sport_slug, league_slug, market_type, guardrail_reason AS reason_code,
                 CASE guardrail_reason
                   WHEN 'sample_below_threshold' THEN 'mercado inmaduro'
                   WHEN 'clv_not_positive' THEN 'CLV malo'
                   WHEN 'profit_not_positive' THEN 'profit no confirmado'
                   WHEN 'market_blocked' THEN 'mercado bloqueado'
                   ELSE 'revision'
                 END AS reason_label,
                 CASE WHEN status = 'BLOCKED' THEN 'block' ELSE 'watch' END AS severity,
                 1 AS occurrences,
                 jsonb_build_object('rule_key', rule_key, 'status', status, 'current_closed', current_closed, 'metrics', metrics) AS sample
          FROM market_promotion_rules
          WHERE guardrail_reason IS NOT NULL
          UNION ALL
          SELECT 'provider_quality', sport_slug, league_slug, market_type, 'provider_suspicious',
                 'provider sospechoso', 'watch', COUNT(*)::int,
                 jsonb_build_object('providers', jsonb_agg(DISTINCT provider_name), 'avg_quality', ROUND(AVG(quality_score)::numeric, 2))
          FROM odds_snapshots
          WHERE quality_score < 80
          GROUP BY sport_slug, league_slug, market_type
          UNION ALL
          SELECT 'market_quotes', s.slug AS sport_slug, l.slug AS league_slug, mq.market_type, 'stale_line',
                 'linea vieja', 'watch', COUNT(*)::int,
                 jsonb_build_object('oldest', MIN(mq.captured_at), 'latest', MAX(mq.captured_at))
          FROM market_quotes mq
          JOIN v_valid_matches m ON m.id = mq.match_id
          JOIN leagues l ON l.id = m.league_id
          JOIN sports s ON s.id = l.sport_id
          WHERE mq.captured_at < NOW() - INTERVAL '24 hours'
          GROUP BY s.slug, l.slug, mq.market_type
        )
        INSERT INTO no_bet_intelligence_events (
          source,
          sport_slug,
          league_slug,
          market_type,
          reason_code,
          reason_label,
          severity,
          occurrences,
          sample,
          first_seen_at,
          last_seen_at
        )
        SELECT source, sport_slug, league_slug, market_type, reason_code, reason_label, severity, occurrences, sample, NOW(), NOW()
        FROM insights
        ON CONFLICT (source, sport_slug, league_slug, market_type, reason_code) DO UPDATE SET
          reason_label = EXCLUDED.reason_label,
          severity = EXCLUDED.severity,
          occurrences = EXCLUDED.occurrences,
          sample = EXCLUDED.sample,
          last_seen_at = NOW()
        RETURNING *
      `
    );

    return { count: result.rows.length, rows: result.rows };
  });

  app.get("/api/v1/internal/analytics/clv-drift-monitor", async () => {
    const result = await db.query(
      `
        WITH samples AS (
          SELECT
            br.rule_key,
            br.sport_slug,
            br.league_slug,
            br.market_type,
            rps.clv,
            rps.entry_timestamp,
            ROW_NUMBER() OVER (PARTITION BY br.rule_key ORDER BY rps.entry_timestamp DESC) AS rn
          FROM backtest_rules br
          JOIN real_paper_snapshots rps
            ON rps.sport_slug = br.sport_slug
           AND rps.league_slug = br.league_slug
           AND rps.market_type = br.market_type
           AND rps.model_probability >= br.min_model_probability
           AND rps.expected_value >= br.min_ev
           AND rps.entry_odds >= br.min_odds
           AND (br.max_odds IS NULL OR rps.entry_odds <= br.max_odds)
           AND (br.pick IS NULL OR rps.pick = br.pick)
           AND (br.bookmaker IS NULL OR rps.bookmaker = br.bookmaker)
           AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
          WHERE br.is_active = TRUE
        ),
        grouped AS (
          SELECT
            rule_key,
            sport_slug,
            league_slug,
            market_type,
            COUNT(*)::int AS sample_size,
            ROUND(AVG(clv) FILTER (WHERE rn <= 20 AND clv IS NOT NULL)::numeric, 6) AS current_avg_clv,
            ROUND(AVG(clv) FILTER (WHERE rn > 20 AND rn <= 50 AND clv IS NOT NULL)::numeric, 6) AS previous_avg_clv
          FROM samples
          GROUP BY rule_key, sport_slug, league_slug, market_type
        ),
        decisions AS (
          SELECT
            *,
            ROUND((COALESCE(current_avg_clv, 0) - COALESCE(previous_avg_clv, 0))::numeric, 6) AS delta_clv,
            CASE
              WHEN sample_size < 30 THEN 'INSUFFICIENT_SAMPLE'
              WHEN COALESCE(current_avg_clv, 0) < 0 THEN 'CLV_NEGATIVE'
              WHEN previous_avg_clv IS NOT NULL AND current_avg_clv < previous_avg_clv - 0.005 THEN 'CLV_COOLING'
              WHEN previous_avg_clv IS NOT NULL AND current_avg_clv > previous_avg_clv + 0.005 THEN 'CLV_IMPROVING'
              ELSE 'CLV_STABLE'
            END AS status
          FROM grouped
        )
        INSERT INTO clv_drift_monitor_events (
          entity_type,
          entity_key,
          sport_slug,
          league_slug,
          market_type,
          status,
          current_avg_clv,
          previous_avg_clv,
          delta_clv,
          sample_size,
          message,
          metrics,
          created_at
        )
        SELECT
          'rule',
          rule_key,
          sport_slug,
          league_slug,
          market_type,
          status,
          current_avg_clv,
          previous_avg_clv,
          delta_clv,
          sample_size,
          CASE
            WHEN status = 'CLV_COOLING' THEN 'esta regla se esta enfriando; no promover y bajar prioridad'
            WHEN status = 'CLV_NEGATIVE' THEN 'CLV negativo; no promover'
            WHEN status = 'CLV_IMPROVING' THEN 'CLV mejorando; mantener en observacion'
            WHEN status = 'INSUFFICIENT_SAMPLE' THEN 'muestra insuficiente para drift'
            ELSE 'CLV estable'
          END,
          jsonb_build_object('current_avg_clv', current_avg_clv, 'previous_avg_clv', previous_avg_clv, 'delta_clv', delta_clv),
          NOW()
        FROM decisions
        ON CONFLICT (entity_type, entity_key) DO UPDATE SET
          status = EXCLUDED.status,
          current_avg_clv = EXCLUDED.current_avg_clv,
          previous_avg_clv = EXCLUDED.previous_avg_clv,
          delta_clv = EXCLUDED.delta_clv,
          sample_size = EXCLUDED.sample_size,
          message = EXCLUDED.message,
          metrics = EXCLUDED.metrics,
          created_at = NOW()
        RETURNING *
      `
    );

    return { count: result.rows.length, rows: result.rows };
  });

  app.get("/api/v1/internal/analytics/pilot-readiness", async () => {
    const result = await db.query(
      `
        SELECT *
        FROM pilot_real_guardrails
        ORDER BY updated_at DESC
      `
    );
    return {
      count: result.rows.length,
      rows: result.rows,
      decision: "PILOT_INFRA_READY_BUT_BLOCKED",
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        manual_confirmation_required: true
      }
    };
  });

  app.get("/api/v1/internal/analytics/closing-line-intelligence", async () => {
    const result = await db.query(
      `
        WITH base AS (
          SELECT
            rps.*,
            m.match_date,
            EXTRACT(EPOCH FROM (m.match_date - rps.entry_timestamp)) / 3600.0 AS hours_before_start
          FROM real_paper_snapshots rps
          JOIN v_valid_matches m ON m.id = rps.match_id
          WHERE rps.sport_slug = 'baseball'
            AND rps.league_slug = 'mlb'
            AND rps.market_type = 'moneyline_2way'
            AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
        ),
        bucketed AS (
          SELECT
            CASE
              WHEN hours_before_start >= 24 THEN '24h_plus'
              WHEN hours_before_start >= 12 THEN '12_24h'
              WHEN hours_before_start >= 6 THEN '6_12h'
              WHEN hours_before_start >= 1 THEN '1_6h'
              WHEN hours_before_start >= 0 THEN 'under_1h'
              ELSE 'late_after_start'
            END AS entry_window,
            *
          FROM base
        ),
        windows AS (
          SELECT
            entry_window,
            COUNT(*)::int AS closed,
            COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
            COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
            ROUND(AVG(hours_before_start)::numeric, 2) AS avg_hours_before_start,
            ROUND(AVG(entry_odds)::numeric, 4) AS avg_entry_odds,
            ROUND(AVG(closing_odds) FILTER (WHERE closing_odds IS NOT NULL)::numeric, 4) AS avg_closing_odds,
            ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
            COUNT(*) FILTER (WHERE clv > 0)::int AS positive_clv,
            ROUND((COALESCE(SUM(profit_loss), 0) / 100.0)::numeric, 4) AS profit_units,
            CASE WHEN COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS')) > 0
              THEN ROUND((COUNT(*) FILTER (WHERE status = 'WIN')::numeric / COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS'))), 6)
              ELSE NULL
            END AS win_rate
          FROM bucketed
          GROUP BY entry_window
        )
        SELECT
          *,
          CASE
            WHEN avg_clv >= 0.020 THEN 'STEAM_FOR_US'
            WHEN avg_clv <= -0.020 THEN 'STEAM_AGAINST_US'
            WHEN avg_clv > 0 THEN 'CLV_POSITIVE'
            WHEN avg_clv < 0 THEN 'CLV_NEGATIVE'
            ELSE 'NEUTRAL'
          END AS steam_signal,
          CASE
            WHEN entry_window IN ('24h_plus', '12_24h') AND COALESCE(avg_clv, 0) < 0 THEN 'too_early_review'
            WHEN entry_window IN ('under_1h', 'late_after_start') AND COALESCE(avg_clv, 0) < 0 THEN 'too_late_review'
            WHEN COALESCE(avg_clv, 0) > 0 AND profit_units > 0 THEN 'preferred_window_candidate'
            ELSE 'observe'
          END AS timing_signal
        FROM windows
        ORDER BY
          CASE entry_window
            WHEN '24h_plus' THEN 0
            WHEN '12_24h' THEN 1
            WHEN '6_12h' THEN 2
            WHEN '1_6h' THEN 3
            WHEN 'under_1h' THEN 4
            ELSE 5
          END
      `
    );

    const bestWindow =
      result.rows
        .filter((row) => Number(row.closed ?? 0) >= 10)
        .sort((a, b) => Number(b.avg_clv ?? -999) - Number(a.avg_clv ?? -999))[0] ?? null;

    return {
      count: result.rows.length,
      best_window: bestWindow,
      rows: result.rows,
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false
      }
    };
  });

  app.get("/api/v1/internal/analytics/confidence-calibration", async () => {
    const result = await db.query(
      `
        WITH bucketed AS (
          SELECT
            CASE
              WHEN model_probability >= 0.65 THEN 'prob_65_plus'
              WHEN model_probability >= 0.60 THEN 'prob_60_65'
              WHEN model_probability >= 0.55 THEN 'prob_55_60'
              WHEN model_probability >= 0.52 THEN 'prob_52_55'
              ELSE 'prob_under_52'
            END AS probability_bucket,
            *
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
        )
        SELECT
          probability_bucket,
          COUNT(*)::int AS closed,
          COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
          COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
          ROUND(AVG(model_probability)::numeric, 6) AS avg_model_probability,
          CASE WHEN COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS')) > 0
            THEN ROUND((COUNT(*) FILTER (WHERE status = 'WIN')::numeric / COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS'))), 6)
            ELSE NULL
          END AS observed_win_rate,
          ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
          ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
          ROUND((
            CASE WHEN COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS')) > 0
              THEN COUNT(*) FILTER (WHERE status = 'WIN')::numeric / COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS'))
              ELSE NULL
            END - AVG(model_probability)
          )::numeric, 6) AS calibration_gap,
          CASE
            WHEN COUNT(*) < 20 THEN 'INSUFFICIENT_SAMPLE'
            WHEN ABS((
              CASE WHEN COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS')) > 0
                THEN COUNT(*) FILTER (WHERE status = 'WIN')::numeric / COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS'))
                ELSE 0
              END - AVG(model_probability)
            )) <= 0.05 THEN 'CALIBRATED'
            WHEN (
              CASE WHEN COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS')) > 0
                THEN COUNT(*) FILTER (WHERE status = 'WIN')::numeric / COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS'))
                ELSE 0
              END
            ) < AVG(model_probability) THEN 'OVERCONFIDENT'
            ELSE 'UNDERCONFIDENT'
          END AS calibration_status
        FROM bucketed
        GROUP BY probability_bucket
        ORDER BY
          CASE probability_bucket
            WHEN 'prob_65_plus' THEN 0
            WHEN 'prob_60_65' THEN 1
            WHEN 'prob_55_60' THEN 2
            WHEN 'prob_52_55' THEN 3
            ELSE 4
          END
      `
    );

    return {
      count: result.rows.length,
      rows: result.rows,
      kelly_guardrail: "Kelly sigue apagado hasta que la calibracion sea estable por bucket."
    };
  });

  async function buildBetGrading() {
    const result = await db.query(
      `
        WITH scored AS (
          SELECT
            rps.id AS snapshot_id,
            rps.sport_slug,
            rps.league_slug,
            rps.market_type,
            rps.pick,
            home_team.name AS home_team_name,
            away_team.name AS away_team_name,
            CONCAT(home_team.name, ' vs ', away_team.name) AS match,
            rps.bookmaker,
            rps.entry_odds,
            rps.closing_odds,
            rps.clv,
            rps.model_probability,
            rps.expected_value,
            rps.profit_loss,
            rps.status AS snapshot_status,
            os.captured_at AS latest_snapshot_at,
            COALESCE(os.quality_score, 100) AS quality_score,
            COALESCE(mpr.status, 'UNLISTED') AS market_status,
            COALESCE(hist.similar_sample, 0) AS historical_similar_sample,
            hist.historical_avg_clv,
            hist.historical_profit_units,
            hist.historical_win_rate,
            CASE
              WHEN rps.bookmaker ILIKE '%manual%' OR rps.bookmaker ILIKE '%shadow%' THEN 'SHADOW'
              WHEN COALESCE(os.quality_score, 100) < 80 THEN 'SUSPICIOUS'
              ELSE 'CLEAN'
            END AS provider_status
          FROM real_paper_snapshots rps
          JOIN v_valid_matches m ON m.id = rps.match_id
          LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'home'
          LEFT JOIN teams home_team ON home_team.id = mh.team_id
          LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'away'
          LEFT JOIN teams away_team ON away_team.id = ma.team_id
          LEFT JOIN LATERAL (
            SELECT os.*
            FROM odds_snapshots os
            WHERE os.market_quote_id = rps.market_quote_id
              AND os.selection = rps.pick
            ORDER BY os.captured_at DESC
            LIMIT 1
          ) os ON TRUE
          LEFT JOIN LATERAL (
            SELECT mpr.*
            FROM market_promotion_rules mpr
            WHERE mpr.sport_slug = rps.sport_slug
              AND mpr.league_slug = rps.league_slug
              AND mpr.market_type = rps.market_type
            ORDER BY
              CASE
                WHEN mpr.segment = 'overall' THEN 0
                WHEN mpr.segment = 'underdogs' AND rps.entry_odds >= 2.0100 THEN 1
                WHEN mpr.segment = 'favorites' AND rps.entry_odds <= 1.9499 THEN 1
                WHEN mpr.segment = rps.pick THEN 1
                ELSE 2
              END,
              mpr.updated_at DESC
            LIMIT 1
          ) mpr ON TRUE
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*)::int AS similar_sample,
              ROUND(AVG(h.clv) FILTER (WHERE h.clv IS NOT NULL)::numeric, 6) AS historical_avg_clv,
              ROUND(COALESCE(SUM(h.profit_loss), 0)::numeric, 4) AS historical_profit_units,
              CASE WHEN COUNT(*) FILTER (WHERE h.status IN ('WIN', 'LOSS')) > 0
                THEN ROUND((COUNT(*) FILTER (WHERE h.status = 'WIN')::numeric / COUNT(*) FILTER (WHERE h.status IN ('WIN', 'LOSS'))), 6)
                ELSE NULL
              END AS historical_win_rate
            FROM real_paper_snapshots h
            WHERE h.sport_slug = rps.sport_slug
              AND h.league_slug = rps.league_slug
              AND h.market_type = rps.market_type
              AND h.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
              AND (
                (rps.entry_odds >= 2.0501 AND h.entry_odds >= 2.0501)
                OR (rps.entry_odds <= 1.9499 AND h.entry_odds <= 1.9499)
                OR (rps.entry_odds > 1.9499 AND rps.entry_odds < 2.0501 AND h.entry_odds > 1.9499 AND h.entry_odds < 2.0501)
              )
              AND h.pick = rps.pick
          ) hist ON TRUE
          WHERE rps.status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'WIN', 'LOSS', 'PUSH', 'SETTLED')
        ),
        quality AS (
          SELECT
            *,
            ROUND(LEAST(100, GREATEST(0,
              LEAST(25, GREATEST(0, expected_value * 250))
              + CASE
                  WHEN COALESCE(historical_avg_clv, 0) > 0 THEN LEAST(20, 12 + historical_avg_clv * 800)
                  WHEN historical_avg_clv IS NULL THEN 8
                  ELSE GREATEST(0, 8 + historical_avg_clv * 800)
                END
              + LEAST(15, GREATEST(0, quality_score * 0.15))
              + CASE
                  WHEN market_status IN ('READY_FOR_REVIEW', 'WATCHLIST_READY') THEN 15
                  WHEN market_status IN ('ACCUMULATING', 'WAITING_SAMPLE') THEN 8
                  WHEN market_status = 'BLOCKED' THEN 0
                  ELSE 4
                END
              + CASE
                  WHEN latest_snapshot_at IS NULL THEN 5
                  WHEN latest_snapshot_at >= NOW() - INTERVAL '6 hours' THEN 10
                  WHEN latest_snapshot_at >= NOW() - INTERVAL '24 hours' THEN 7
                  ELSE 3
                END
              + CASE
                  WHEN historical_similar_sample >= 75 THEN 10
                  WHEN historical_similar_sample >= 50 THEN 8
                  WHEN historical_similar_sample >= 30 THEN 5
                  ELSE 2
                END
              + CASE
                  WHEN historical_similar_sample < 20 THEN 5
                  WHEN historical_win_rate IS NOT NULL AND ABS(historical_win_rate - model_probability) <= 0.06 THEN 10
                  WHEN historical_win_rate IS NOT NULL AND historical_win_rate >= model_probability THEN 8
                  ELSE 3
                END
              - CASE WHEN provider_status <> 'CLEAN' THEN 15 ELSE 0 END
              - CASE WHEN market_status = 'BLOCKED' THEN 12 ELSE 0 END
              - CASE WHEN snapshot_status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT') THEN 4 ELSE 0 END
            ))::numeric, 2) AS edge_quality_score
          FROM scored
        ),
        graded AS (
          SELECT
            *,
            CASE
              WHEN edge_quality_score >= 85 THEN 'A'
              WHEN edge_quality_score >= 70 THEN 'B'
              WHEN edge_quality_score >= 55 THEN 'C'
              WHEN edge_quality_score >= 40 THEN 'D'
              ELSE 'F'
            END AS edge_quality_grade,
            CASE
              WHEN snapshot_status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT') THEN 'C'
              WHEN provider_status <> 'CLEAN' THEN 'D'
              WHEN edge_quality_score >= 85 AND COALESCE(clv, 0) > 0 AND COALESCE(profit_loss, 0) > 0 AND market_status IN ('READY_FOR_REVIEW', 'WATCHLIST_READY') THEN 'A'
              WHEN expected_value >= 0.05 AND model_probability >= 0.55 AND COALESCE(profit_loss, 0) > 0 THEN 'B'
              WHEN COALESCE(clv, 0) < 0 AND COALESCE(profit_loss, 0) < 0 THEN 'F'
              ELSE 'D'
            END AS grade,
            CASE
              WHEN snapshot_status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT') THEN 'C: pendiente de cierre o resultado'
              WHEN provider_status <> 'CLEAN' THEN 'D: provider sospechoso o shadow'
              WHEN COALESCE(clv, 0) > 0 AND COALESCE(profit_loss, 0) > 0 AND market_status IN ('READY_FOR_REVIEW', 'WATCHLIST_READY') THEN 'A: CLV positivo, profit positivo, provider limpio y mercado aprobado'
              WHEN expected_value >= 0.05 AND model_probability >= 0.55 AND COALESCE(profit_loss, 0) > 0 THEN 'B: buen EV/probabilidad con profit, falta confirmacion completa'
              WHEN COALESCE(clv, 0) < 0 AND COALESCE(profit_loss, 0) < 0 THEN 'F: no bet, CLV y profit negativos'
              ELSE 'D: requiere revision'
            END AS grade_reason,
            CONCAT(
              'Edge ', edge_quality_score::text, '/100 (', 
              CASE
                WHEN edge_quality_score >= 85 THEN 'A'
                WHEN edge_quality_score >= 70 THEN 'B'
                WHEN edge_quality_score >= 55 THEN 'C'
                WHEN edge_quality_score >= 40 THEN 'D'
                ELSE 'F'
              END,
              '). EV=', ROUND(expected_value::numeric, 4)::text,
              ', modelProb=', ROUND(model_probability::numeric, 4)::text,
              ', market=', market_status,
              ', provider=', provider_status,
              ', similarSample=', historical_similar_sample::text,
              '. REAL PAPER ONLY; dinero real, Kelly y Telegram automatico siguen apagados.'
            ) AS explanation_text
          FROM quality
        )
        INSERT INTO bet_grades (
          snapshot_id,
          sport_slug,
          league_slug,
          market_type,
          pick,
          grade,
          grade_reason,
          market_status,
          provider_status,
          metrics,
          edge_quality_score,
          edge_quality_grade,
          explanation_text
        )
        SELECT
          snapshot_id,
          sport_slug,
          league_slug,
          market_type,
          pick,
          grade,
          grade_reason,
          market_status,
          provider_status,
          jsonb_build_object(
            'bookmaker', bookmaker,
            'home_team_name', home_team_name,
            'away_team_name', away_team_name,
            'match', match,
            'entry_odds', entry_odds,
            'closing_odds', closing_odds,
            'clv', clv,
            'model_probability', model_probability,
            'expected_value', expected_value,
            'profit_loss', profit_loss,
            'home_team_name', home_team_name,
            'away_team_name', away_team_name,
            'match', match,
            'quality_score', quality_score,
            'snapshot_status', snapshot_status,
            'latest_snapshot_at', latest_snapshot_at,
            'historical_similar_sample', historical_similar_sample,
            'historical_avg_clv', historical_avg_clv,
            'historical_profit_units', historical_profit_units,
            'historical_win_rate', historical_win_rate
          ),
          edge_quality_score,
          edge_quality_grade,
          explanation_text
        FROM graded
        ON CONFLICT (snapshot_id) DO UPDATE SET
          grade = EXCLUDED.grade,
          grade_reason = EXCLUDED.grade_reason,
          market_status = EXCLUDED.market_status,
          provider_status = EXCLUDED.provider_status,
          metrics = EXCLUDED.metrics,
          edge_quality_score = EXCLUDED.edge_quality_score,
          edge_quality_grade = EXCLUDED.edge_quality_grade,
          explanation_text = EXCLUDED.explanation_text,
          updated_at = NOW()
        RETURNING *
      `
    );

    const summary = await db.query(
      `
        SELECT grade, COUNT(*)::int AS picks
        FROM bet_grades
        GROUP BY grade
        ORDER BY grade
      `
    );

    return { count: result.rows.length, summary: summary.rows, rows: result.rows };
  }

  app.get("/api/v1/internal/analytics/bet-grading", async () => buildBetGrading());
  app.get("/api/v1/trading/bet-grading", async () => buildBetGrading());
  app.get("/api/trading/bet-grading", async () => buildBetGrading());

  app.get("/api/v1/internal/analytics/edge-quality-score", async () => {
    const result = await db.query(
      `
        SELECT
          bg.snapshot_id,
          bg.sport_slug,
          bg.league_slug,
          bg.market_type,
          bg.pick,
          bg.grade,
          bg.edge_quality_score,
          bg.edge_quality_grade,
          bg.grade_reason,
          bg.market_status,
          bg.provider_status,
          bg.explanation_text,
          bg.metrics,
          rps.status AS snapshot_status,
          rps.entry_timestamp
        FROM bet_grades bg
        JOIN real_paper_snapshots rps ON rps.id = bg.snapshot_id
        ORDER BY bg.edge_quality_score DESC NULLS LAST, rps.entry_timestamp DESC
        LIMIT 150
      `
    );

    const summary = await db.query(
      `
        SELECT
          COALESCE(edge_quality_grade, grade) AS edge_quality_grade,
          COUNT(*)::int AS picks,
          ROUND(AVG(edge_quality_score)::numeric, 2) AS avg_edge_quality_score
        FROM bet_grades
        GROUP BY COALESCE(edge_quality_grade, grade)
        ORDER BY COALESCE(edge_quality_grade, grade)
      `
    );

    return {
      count: result.rows.length,
      summary: summary.rows,
      rows: result.rows,
      guardrails: {
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        note: "Edge Quality prioriza revision y Real Paper; no autoriza dinero real."
      }
    };
  });

  async function buildPickExplainability(rawQuery: unknown = {}) {
    const query = z.object({
      date: z.string().optional(),
      match_id: z.string().uuid().optional(),
      sport: z.string().default("all"),
      min_closed: z.coerce.number().int().min(1).max(500).default(30),
      limit: z.coerce.number().int().min(1).max(300).default(150)
    }).parse(rawQuery || {});

    const bestBets = await buildBestBetsPerMatch({
      date: query.date,
      sport: query.sport,
      fallback_recent: true
    }) as Record<string, any>;
    const bestRows = (Array.isArray(bestBets.rows) ? bestBets.rows : []) as Array<Record<string, any>>;
    const preflight = await getMatchPreflightStatus(db, {
      date: query.date,
      sport: query.sport,
      limit: query.limit
    });
    const preflightByMatch = new Map<string, Record<string, any>>();
    for (const row of (preflight.rows || []) as Array<Record<string, any>>) {
      preflightByMatch.set(String(row.match_id || ""), row);
    }
    const footballSegments = await buildFootballPerformanceSegments({
      date_to: query.date,
      min_closed: query.min_closed,
      limit: 250
    }) as Record<string, any>;
    const segmentRows = (Array.isArray(footballSegments.rows) ? footballSegments.rows : []) as Array<Record<string, any>>;

    const numberOrNull = (value: unknown): number | null => {
      if (value === null || value === undefined || value === "") return null;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    };
    const asList = (value: unknown): string[] => Array.isArray(value)
      ? value.map((item) => String(item)).filter(Boolean)
      : [];
    const percentScore = (ready: boolean | null | undefined, partial = false) => ready ? 100 : partial ? 50 : 0;
    const gradeFor = (score: number) => score >= 85 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
    const includesAny = (items: string[], needles: string[]) => items.some((item) => needles.some((needle) => item.toLowerCase().includes(needle)));
    const segmentMatch = (type: string, value: string) => segmentRows.find((segment) => segment.segment_type === type && segment.segment_value === value);
    const segmentTagsFor = (row: Record<string, any>) => {
      const sport = String(row.sport || "").toLowerCase();
      const market = String(row.best_market || row.market_type || "").toLowerCase();
      const pick = String(row.pick || "").toLowerCase();
      const odds = numberOrNull(row.odds);
      const expectedValue = numberOrNull(row.expected_value);
      const gap = numberOrNull(row.model_vs_market_gap);
      const tags: Array<{ type: string; value: string }> = [];
      if (market) tags.push({ type: "market", value: market });
      if (sport === "soccer") {
        if (odds !== null && odds >= 7) tags.push({ type: "price", value: "longshot_7_plus" });
        else if (odds !== null && odds >= 4) tags.push({ type: "price", value: "underdog_4_plus" });
        else if (odds !== null && odds >= 2) tags.push({ type: "price", value: "plus_price_2_plus" });
        else tags.push({ type: "price", value: "favorite_or_mid" });
        if (pick === "draw") tags.push({ type: "pick_type", value: "draw" });
        else if (pick.includes("away")) tags.push({ type: "pick_type", value: "away_side" });
        else if (pick.includes("home")) tags.push({ type: "pick_type", value: "home_side" });
        if (expectedValue !== null && expectedValue >= 0.3) tags.push({ type: "audit", value: "AGGRESSIVE_VALUE_AUDIT" });
        if (expectedValue !== null && expectedValue >= 0.6) tags.push({ type: "audit", value: "EXTREME_EV_AUDIT" });
        if (gap !== null && Math.abs(gap) >= 0.12) tags.push({ type: "audit", value: "MODEL_MARKET_GAP_HIGH" });
      } else if (sport === "baseball") {
        tags.push({ type: "market", value: market || "moneyline_2way" });
        if (odds !== null && odds >= 2.01) tags.push({ type: "price", value: "underdog_2_plus" });
        else tags.push({ type: "price", value: "favorite_or_mid" });
      }
      return tags;
    };
    const memoryFor = (row: Record<string, any>) => {
      const tags = segmentTagsFor(row);
      const matches = tags
        .map((tag) => ({ tag, segment: segmentMatch(tag.type, tag.value) }))
        .filter((item) => item.segment) as Array<{ tag: { type: string; value: string }; segment: Record<string, any> }>;
      const primary = matches.find((item) => item.tag.type === "audit")
        || matches.find((item) => item.tag.type === "price")
        || matches.find((item) => item.tag.type === "market")
        || null;
      const segment = primary?.segment || null;
      return {
        primary_segment: primary ? `${primary.tag.type}:${primary.tag.value}` : tags[0] ? `${tags[0].type}:${tags[0].value}` : "unknown",
        segment_n: segment?.total ?? null,
        segment_closed: segment?.closed ?? null,
        segment_valid_clv_count: segment?.valid_clv_count ?? null,
        segment_clv_avg: segment?.avg_clv ?? null,
        segment_clv_positive_rate: segment?.positive_clv_rate ?? null,
        segment_profit: segment?.profit_units ?? null,
        segment_brier: segment?.brier ?? null,
        segment_brier_display: segment?.brier_display ?? "n/a",
        segment_brier_available: Boolean(segment?.brier_available),
        segment_raw_brier_preview: segment?.raw_brier_preview ?? null,
        segment_log_loss: segment?.log_loss ?? null,
        segment_log_loss_display: segment?.log_loss_display ?? "n/a",
        segment_log_loss_available: Boolean(segment?.log_loss_available),
        segment_raw_log_loss_preview: segment?.raw_log_loss_preview ?? null,
        segment_metric_sample_n: segment?.metric_sample_n ?? null,
        segment_metric_sample_min: segment?.brier_sample_min ?? null,
        segment_metric_sample_status: segment?.metric_sample_status ?? "INSUFFICIENT_SAMPLE",
        raw_metrics_are_decision_eligible: Boolean(segment?.raw_metrics_are_decision_eligible),
        dixon_coles_readiness: segment?.dixon_coles_readiness ?? "NOT_READY_CLOSING_SAMPLE_INSUFFICIENT",
        segment_roi_ci_95_low: segment?.roi_ci_95_low ?? null,
        segment_roi_ci_95_high: segment?.roi_ci_95_high ?? null,
        segment_dependency_ratio: segment?.dependency_ratio ?? null,
        segment_decision: segment?.decision ?? "INSUFFICIENT_SAMPLE",
        segment_sample_status: segment?.segment_visual_status ?? "INSUFFICIENT_SAMPLE"
      };
    };

    const rows = bestRows.slice(0, query.limit).map((row) => {
      const pre = preflightByMatch.get(String(row.match_id || "")) || {};
      const sport = String(row.sport || pre.sport || "").toLowerCase();
      const missing = [...new Set([...asList(row.why_no).filter((item) => item.startsWith("Falta ")).map((item) => item.replace(/^Falta\s+/i, "")), ...asList(pre.missing)])];
      const hardContextMissing = sport === "soccer"
        ? includesAny(missing, ["lineup", "goalkeeper", "player_intelligence"])
        : includesAny(missing, ["pitcher", "lineup", "batting_order", "bullpen"]);
      const financialCompleteness = row.odds && row.model_probability !== null && row.model_probability !== undefined && row.expected_value !== null && row.expected_value !== undefined ? 100 : 0;
      const contextCompleteness = Math.max(0, Math.min(100, Number(row.context_score ?? (pre.context_ready ? 80 : 35))));
      const lineupCompleteness = sport === "baseball"
        ? Math.round((percentScore(pre.home_lineup_ready) + percentScore(pre.away_lineup_ready) + percentScore(pre.batting_order_complete) + percentScore(pre.pitcher_ready)) / 4)
        : Math.round((percentScore(pre.lineup_ready) + percentScore(pre.goalkeeper_ready)) / 2);
      const closingCompleteness = pre.closing_ready || row.closing_quality === "CAPTURED_ON_TIME" ? 100 : row.closing_quality ? 25 : 0;
      const settlementCompleteness = String(pre.ticket_status || row.status || "").match(/WIN|LOSS|PUSH|SETTLED|VOID/) ? 100 : pre.settlement_ready ? 50 : 0;
      const overallCompleteness = Math.round((financialCompleteness * 0.28) + (contextCompleteness * 0.28) + (lineupCompleteness * 0.18) + (closingCompleteness * 0.16) + (settlementCompleteness * 0.10));
      const segmentMemory = memoryFor(row);
      const ev = numberOrNull(row.expected_value);
      const marketScore = numberOrNull(row.market_score) ?? 0;
      const rawCalibrationState = String(row.calibration_state || (sport === "soccer" ? "CALIBRATING" : "CALIBRATED_REVIEW")).toUpperCase();
      const calibrationState = sport === "soccer" && ["UNCALIBRATED_PRIOR", "CALIBRATING"].includes(rawCalibrationState)
        ? "CALIBRATING"
        : rawCalibrationState;
      const segmentSupport = segmentMemory.segment_decision === "PROMOTE_WATCH" ? 12
        : segmentMemory.segment_decision === "KEEP_SHADOW" ? 5
          : segmentMemory.segment_decision === "BLOCK_SEGMENT" ? -18
            : 0;
      let confidenceScore = Math.round((financialCompleteness * 0.18) + (contextCompleteness * 0.22) + (marketScore * 0.18) + (lineupCompleteness * 0.16) + (closingCompleteness * 0.16) + segmentSupport);
      if (ev !== null && ev > 0) confidenceScore += ev >= 0.10 ? 8 : 4;
      if (calibrationState === "UNCALIBRATED_PRIOR" || calibrationState === "CALIBRATING") confidenceScore = Math.min(confidenceScore, 69);
      if (hardContextMissing) confidenceScore = Math.min(confidenceScore, 59);
      if (!closingCompleteness) confidenceScore = Math.min(confidenceScore, 74);
      confidenceScore = Math.max(0, Math.min(100, confidenceScore));
      const blockingLevel = financialCompleteness === 0 ? "FINANCIAL_BLOCK"
        : hardContextMissing ? "CONTEXT_HARD_GATE"
          : calibrationState === "UNCALIBRATED_PRIOR" || calibrationState === "CALIBRATING" ? "CALIBRATION_BLOCK"
            : closingCompleteness < 100 ? "CLOSING_BLOCK"
              : "REVIEW";
      const whyNo = [
        ...asList(row.why_no),
        calibrationState === "UNCALIBRATED_PRIOR" || calibrationState === "CALIBRATING" ? "Futbol sigue CALIBRATING; exige Brier/log loss/CLV antes de paper serio" : null,
        segmentMemory.segment_sample_status === "INSUFFICIENT_SAMPLE" ? "Segmento con muestra insuficiente" : null,
        segmentMemory.raw_metrics_are_decision_eligible ? null : "Brier/log loss no elegibles por muestra insuficiente",
        hardContextMissing ? "Gate duro: falta lineup/portero/pitcher/bullpen segun deporte" : null
      ].filter(Boolean);
      return {
        match_id: row.match_id,
        paper_trade_id: row.paper_trade_id ?? null,
        match: row.match,
        sport,
        league: row.league_id || pre.league || "-",
        market: row.best_market,
        market_type: row.best_market,
        pick: row.pick,
        odds: row.odds ?? null,
        provider: row.provider || pre.provider || "-",
        model_probability: row.model_probability ?? null,
        fair_odds: row.fair_odds ?? null,
        expected_value: row.expected_value ?? null,
        edge_to_fair: row.edge_to_fair ?? null,
        market_no_vig_probability: row.market_no_vig_probability ?? null,
        model_vs_market_gap: row.model_vs_market_gap ?? null,
        context_score: row.context_score ?? null,
        market_score: row.market_score ?? null,
        final_score: row.final_score ?? null,
        model_label: calibrationState,
        model_version: row.model_family || row.target_model_family || "-",
        audit_flags: [...new Set([...(asList(row.audit_flags)), ...(segmentTagsFor(row).filter((tag) => tag.type === "audit").map((tag) => tag.value))])],
        status: row.status,
        decision_rule: blockingLevel,
        model_confidence_score: confidenceScore,
        model_confidence_grade: gradeFor(confidenceScore),
        why_yes: asList(row.why_yes),
        why_no: whyNo,
        missing_fields: missing,
        blocking_level: blockingLevel,
        next_action: pre.next_action || row.recommendation || "Mantener en review; no apostar real.",
        source_of_odds: row.provider || pre.provider || "market_quotes/manual_verified",
        source_of_model: row.model_family || "sports_data_hub_owned_api",
        source_of_context: pre.context_ready ? "match_preflight/context_tables" : "context_pending",
        closing_quality: pre.closing_quality || row.closing_quality || "MISSING",
        clv_valid: Boolean(pre.clv_valid_for_segments),
        financial_completeness: financialCompleteness,
        context_completeness: contextCompleteness,
        lineup_completeness: lineupCompleteness,
        closing_completeness: closingCompleteness,
        settlement_completeness: settlementCompleteness,
        overall_completeness: overallCompleteness,
        ...segmentMemory
      };
    });

    const count = (predicate: (row: Record<string, any>) => boolean) => rows.filter(predicate).length;
    const overallSegment = segmentRows.find((segment) => segment.segment_type === "overall" && segment.segment_value === "all") || {};
    return {
      system_status: "PICK_EXPLAINABILITY_V2_READ_ONLY",
      date: query.date ?? bestBets.date ?? null,
      count: rows.length,
      summary: {
        blocked_by_context: count((row) => row.blocking_level === "CONTEXT_HARD_GATE"),
        blocked_by_closing: count((row) => row.blocking_level === "CLOSING_BLOCK"),
        calibrating: count((row) => row.blocking_level === "CALIBRATION_BLOCK"),
        aggressive_ev: count((row) => asList(row.audit_flags).includes("AGGRESSIVE_VALUE_AUDIT") || asList(row.audit_flags).includes("EXTREME_EV_AUDIT")),
        insufficient_segment_sample: count((row) => row.segment_sample_status === "INSUFFICIENT_SAMPLE"),
        closing_valid_count: Number(overallSegment.valid_closing_count || 0),
        closing_invalid_count: Number(overallSegment.invalid_closing_count || 0),
        clv_valid_count: Number(overallSegment.valid_clv_count || 0),
        dixon_coles_readiness: overallSegment.dixon_coles_readiness || "NOT_READY_CLOSING_SAMPLE_INSUFFICIENT",
        metric_sample_status: overallSegment.metric_sample_status || "INSUFFICIENT_SAMPLE",
        best_confidence_score: rows.reduce((best, row) => Math.max(best, Number(row.model_confidence_score || 0)), 0)
      },
      rows,
      recommendation: "Explainability v2: Best Bet es lectura, no apuesta. Futbol CALIBRATING exige Brier/log loss/CLV; missing lineup/portero/pitcher degrada por gate duro.",
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        kill_switch_enabled: true
      }
    };
  }

  app.get("/api/v1/internal/analytics/pick-explainability", async (request) => buildPickExplainability(request.query));
  app.get("/api/v1/trading/pick-explainability", async (request) => buildPickExplainability(request.query));
  app.get("/api/trading/pick-explainability", async (request) => buildPickExplainability(request.query));

  app.get("/api/v1/internal/analytics/timing-engine", async () => {
    const result = await db.query(
      `
        WITH base AS (
          SELECT
            rps.*,
            m.match_date,
            EXTRACT(EPOCH FROM (m.match_date - rps.entry_timestamp)) / 3600.0 AS hours_before_start,
            CASE
              WHEN rps.entry_odds <= 1.9499 THEN 'favorites'
              WHEN rps.entry_odds >= 2.0501 THEN 'underdogs'
              ELSE 'pickem'
            END AS price_role
          FROM real_paper_snapshots rps
          JOIN v_valid_matches m ON m.id = rps.match_id
          WHERE rps.sport_slug = 'baseball'
            AND rps.league_slug = 'mlb'
            AND rps.market_type = 'moneyline_2way'
            AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
        ),
        segmented AS (
          SELECT 'MLB Moneyline' AS segment, 'overall' AS segment_key, * FROM base
          UNION ALL SELECT 'MLB Favorites', 'favorites', * FROM base WHERE price_role = 'favorites'
          UNION ALL SELECT 'MLB Underdogs', 'underdogs', * FROM base WHERE price_role = 'underdogs'
          UNION ALL SELECT 'MLB Home', 'home', * FROM base WHERE pick = 'home'
          UNION ALL SELECT 'MLB Away', 'away', * FROM base WHERE pick = 'away'
        ),
        bucketed AS (
          SELECT
            *,
            CASE
              WHEN hours_before_start >= 24 THEN '24h'
              WHEN hours_before_start >= 12 THEN '12h'
              WHEN hours_before_start >= 6 THEN '6h'
              WHEN hours_before_start >= 1 THEN '1h'
              ELSE 'closing'
            END AS entry_window
          FROM segmented
        ),
        stats AS (
          SELECT
            segment,
            segment_key,
            entry_window,
            COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
            COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
            CASE WHEN COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS')) > 0
              THEN ROUND((COUNT(*) FILTER (WHERE status = 'WIN')::numeric / COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS'))), 6)
              ELSE NULL
            END AS win_rate,
            ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS average_clv,
            ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_flat
          FROM bucketed
          GROUP BY segment, segment_key, entry_window
        )
        SELECT
          *,
          FIRST_VALUE(entry_window) OVER (PARTITION BY segment ORDER BY average_clv DESC NULLS LAST, profit_flat DESC) AS best_entry_window,
          FIRST_VALUE(entry_window) OVER (PARTITION BY segment ORDER BY average_clv ASC NULLS LAST, profit_flat ASC) AS worst_entry_window
        FROM stats
        ORDER BY segment, CASE entry_window WHEN '24h' THEN 1 WHEN '12h' THEN 2 WHEN '6h' THEN 3 WHEN '1h' THEN 4 ELSE 5 END
      `
    );

    return { count: result.rows.length, rows: result.rows };
  });

  app.get("/api/v1/internal/analytics/line-movement-radar", async () => {
    const result = await db.query(
      `
        SELECT
          rps.id AS snapshot_id,
          rps.sport_slug,
          rps.league_slug,
          rps.market_type,
          rps.pick,
          rps.bookmaker,
          rps.entry_odds AS opening_entry_odds,
          latest.odds AS current_odds,
          rps.closing_odds,
          ROUND((
            COALESCE(rps.closing_odds, latest.odds, rps.entry_odds) - rps.entry_odds
          ) / NULLIF(rps.entry_odds, 0), 6) AS movement_percentage,
          CASE
            WHEN COALESCE(rps.closing_odds, latest.odds, rps.entry_odds) > rps.entry_odds THEN 'ODDS_UP'
            WHEN COALESCE(rps.closing_odds, latest.odds, rps.entry_odds) < rps.entry_odds THEN 'ODDS_DOWN'
            ELSE 'UNCHANGED'
          END AS movement_direction,
          CASE
            WHEN latest.captured_at IS NOT NULL AND latest.captured_at < NOW() - INTERVAL '24 hours' THEN 'STALE_LINE'
            WHEN latest.quality_score IS NOT NULL AND latest.quality_score < 80 THEN 'SUSPICIOUS_PROVIDER_MOVE'
            WHEN ABS((COALESCE(rps.closing_odds, latest.odds, rps.entry_odds) - rps.entry_odds) / NULLIF(rps.entry_odds, 0)) >= 0.08
              AND COALESCE(rps.clv, 0) > 0 THEN 'STEAM_FAVORABLE'
            WHEN ABS((COALESCE(rps.closing_odds, latest.odds, rps.entry_odds) - rps.entry_odds) / NULLIF(rps.entry_odds, 0)) >= 0.08
              AND COALESCE(rps.clv, 0) < 0 THEN 'STEAM_AGAINST'
            WHEN (COALESCE(rps.closing_odds, latest.odds, rps.entry_odds) - rps.entry_odds) / NULLIF(rps.entry_odds, 0) <= -0.12 THEN 'SHARP_DROP'
            ELSE 'NEUTRAL'
          END AS steam_detected,
          CASE
            WHEN latest.captured_at IS NOT NULL AND latest.captured_at < NOW() - INTERVAL '24 hours' THEN 'HIGH'
            WHEN latest.quality_score IS NOT NULL AND latest.quality_score < 80 THEN 'HIGH'
            WHEN ABS((COALESCE(rps.closing_odds, latest.odds, rps.entry_odds) - rps.entry_odds) / NULLIF(rps.entry_odds, 0)) >= 0.08 THEN 'MEDIUM'
            ELSE 'LOW'
          END AS alert_level,
          latest.captured_at AS latest_snapshot_at
        FROM real_paper_snapshots rps
        JOIN v_valid_matches m ON m.id = rps.match_id
        LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = mh.team_id
        LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = ma.team_id
        LEFT JOIN LATERAL (
          SELECT os.odds, os.quality_score, os.captured_at
          FROM odds_snapshots os
          WHERE os.market_quote_id = rps.market_quote_id
            AND os.selection = rps.pick
          ORDER BY os.captured_at DESC
          LIMIT 1
        ) latest ON TRUE
        WHERE rps.sport_slug = 'baseball'
          AND rps.league_slug = 'mlb'
          AND rps.market_type = 'moneyline_2way'
        ORDER BY rps.entry_timestamp DESC
        LIMIT 150
      `
    );

    return {
      count: result.rows.length,
      rows: result.rows,
      guardrails: { telegram_auto_enabled: false }
    };
  });


  async function buildPickDecisionRows() {
    const result = await db.query(
      `
        WITH recent AS (
          SELECT
            ROUND(AVG(clv) FILTER (WHERE rn <= 10 AND clv IS NOT NULL)::numeric, 6) AS recent_clv_10,
            ROUND(AVG(clv) FILTER (WHERE rn <= 20 AND clv IS NOT NULL)::numeric, 6) AS recent_clv_20,
            ROUND(COALESCE(SUM(profit_loss) FILTER (WHERE rn <= 10), 0)::numeric, 4) AS recent_profit_10
          FROM (
            SELECT clv, profit_loss, ROW_NUMBER() OVER (ORDER BY entry_timestamp DESC) AS rn
            FROM real_paper_snapshots
            WHERE sport_slug = 'baseball'
              AND league_slug = 'mlb'
              AND market_type = 'moneyline_2way'
              AND entry_odds >= 2.0100
              AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
              AND duplicate_of_id IS NULL
              AND COALESCE(data_state, 'FRESH') IN ('FRESH', 'ARCHIVED')
          ) x
        ),
        latest_market AS (
          SELECT DISTINCT ON (rule_key)
            rule_key,
            status,
            guardrail_reason,
            recommendation
          FROM market_promotion_rules
          WHERE rule_key IN ('mlb_moneyline', 'mlb_underdogs')
          ORDER BY rule_key, updated_at DESC
        )
        SELECT
          rps.id,
          rps.match_id,
          rps.sport_slug,
          rps.league_slug,
          rps.model_name,
          rps.market_type,
          rps.line,
          rps.pick,
          rps.bookmaker,
          rps.entry_odds,
          rps.model_probability,
          rps.expected_value,
          rps.status AS snapshot_status,
          rps.entry_timestamp,
          home_team.name AS home_team_name,
          away_team.name AS away_team_name,
          latest.provider_name,
          latest.quality_score,
          latest.captured_at AS latest_snapshot_at,
          latest.book_count,
          ROUND(EXTRACT(EPOCH FROM (NOW() - COALESCE(latest.captured_at, rps.entry_timestamp)))::numeric, 0) AS line_age_seconds,
          ROW_NUMBER() OVER (
            PARTITION BY rps.match_id
            ORDER BY rps.expected_value DESC NULLS LAST, rps.model_probability DESC NULLS LAST, rps.entry_timestamp DESC, rps.id DESC
          ) AS exposure_rank,
          exposure.open_exposure_count AS raw_open_exposure_count,
          CASE
            WHEN ROW_NUMBER() OVER (
              PARTITION BY rps.match_id
              ORDER BY rps.expected_value DESC NULLS LAST, rps.model_probability DESC NULLS LAST, rps.entry_timestamp DESC, rps.id DESC
            ) = 1 THEN 0
            ELSE exposure.open_exposure_count
          END AS open_exposure_count,
          recent.recent_clv_10,
          recent.recent_clv_20,
          recent.recent_profit_10,
          features.feature_set,
          features.feature_generated_at,
          COALESCE(market_underdog.status, market_mlb.status, 'UNKNOWN') AS market_status,
          COALESCE(market_underdog.guardrail_reason, market_mlb.guardrail_reason, '-') AS market_guardrail_reason,
          CASE
            WHEN latest.captured_at IS NULL THEN true
            WHEN latest.captured_at < NOW() - INTERVAL '24 hours' THEN true
            ELSE false
          END AS is_stale,
          CASE
            WHEN latest.quality_score IS NOT NULL AND latest.quality_score < 80 THEN true
            WHEN rps.clv IS NOT NULL AND rps.clv < -0.08 THEN true
            ELSE false
          END AS suspicious_move
        FROM real_paper_snapshots rps
        JOIN v_valid_matches m ON m.id = rps.match_id
        LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = mh.team_id
        LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = ma.team_id
        CROSS JOIN recent
        LEFT JOIN LATERAL (
          SELECT
            os.provider_name,
            os.quality_score,
            os.captured_at,
            COUNT(*) OVER (PARTITION BY os.market_quote_id) AS book_count
          FROM odds_snapshots os
          WHERE os.market_quote_id = rps.market_quote_id
            AND os.selection = rps.pick
          ORDER BY os.captured_at DESC
          LIMIT 1
        ) latest ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS open_exposure_count
          FROM real_paper_snapshots other
          WHERE other.match_id = rps.match_id
            AND other.id <> rps.id
            AND other.status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULTS')
            AND other.duplicate_of_id IS NULL
            AND COALESCE(other.data_state, 'FRESH') = 'FRESH'
        ) exposure ON true
        LEFT JOIN LATERAL (
          SELECT mf.feature_set, mf.generated_at AS feature_generated_at
          FROM model_features mf
          WHERE mf.match_id = rps.match_id
            AND mf.sport_slug = rps.sport_slug
            AND mf.model_name = rps.model_name
          ORDER BY mf.generated_at DESC
          LIMIT 1
        ) features ON true
        LEFT JOIN latest_market market_mlb ON market_mlb.rule_key = 'mlb_moneyline'
        LEFT JOIN latest_market market_underdog ON market_underdog.rule_key = 'mlb_underdogs'
        WHERE rps.status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULTS')
          AND rps.duplicate_of_id IS NULL
          AND COALESCE(rps.data_state, 'FRESH') = 'FRESH'
        ORDER BY rps.expected_value DESC, rps.entry_timestamp DESC
        LIMIT 150
      `
    );

    const rows = result.rows.map((row) => {
      const decision = decidePick({
        ...row,
        provider_score: row.quality_score,
        processed: true,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        kill_switch_enabled: true,
        max_line_age_seconds: 24 * 60 * 60
      });
      return {
        ...row,
        ...decision,
        match: `${row.home_team_name || "Home"} vs ${row.away_team_name || "Away"}`
      };
    });

    const counts = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.decision] = (acc[row.decision] || 0) + 1;
      return acc;
    }, {});

    return {
      count: rows.length,
      counts,
      rows,
      guardrails: {
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        kill_switch_enabled: true
      }
    };
  }

  async function buildUnderdogPlusV2() {
    const decisions = await buildPickDecisionRows();
    const base = await db.query(
      `
        SELECT
          COUNT(*)::int AS closed,
          COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
          COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
          ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
          ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv
        FROM real_paper_snapshots
        WHERE sport_slug = 'baseball'
          AND league_slug = 'mlb'
          AND market_type = 'moneyline_2way'
          AND entry_odds >= 2.0100
          AND expected_value >= 0.05
          AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
      `
    );

    const candidates = decisions.rows
      .filter((row) => row.sport_slug === "baseball" && row.league_slug === "mlb" && row.market_type === "moneyline_2way")
      .filter((row) => Number(row.entry_odds || 0) >= 2.0100)
      .filter((row) => Number(row.expected_value || 0) >= 0.05)
      .filter((row) => Number(row.model_probability || 0) >= 0.55)
      .map((row) => {
        let underdog_plus_status = "UNDERDOG_PLUS_WATCH";
        if (row.decision === "BETTABLE_PAPER") underdog_plus_status = "UNDERDOG_PLUS_PAPER";
        if (row.decision === "COOLING") underdog_plus_status = "UNDERDOG_PLUS_COOLING";
        if (row.decision === "NEEDS_MANUAL_REVIEW") underdog_plus_status = "UNDERDOG_PLUS_REVIEW_ONLY";
        if (row.decision === "BLOCKED_BY_RISK" || row.decision === "REJECT") underdog_plus_status = "UNDERDOG_PLUS_BLOCKED";
        return {
          ...row,
          underdog_plus_status,
          comparison_to_base: {
            base_rule: "mlb_underdog_ev5_base",
            base_closed: base.rows[0]?.closed || 0,
            base_profit_units: base.rows[0]?.profit_units || 0,
            base_avg_clv: base.rows[0]?.avg_clv || null
          }
        };
      });

    const counts = candidates.reduce<Record<string, number>>((acc, row) => {
      acc[row.underdog_plus_status] = (acc[row.underdog_plus_status] || 0) + 1;
      return acc;
    }, {});

    return {
      count: candidates.length,
      counts,
      candidates,
      base_rule: base.rows[0] || null,
      guardrails: decisions.guardrails
    };
  }




  function humanizeReason(reason: unknown) {
    const value = String(reason || "").trim();
    const map: Record<string, string> = {
      provider_clean: "Provider limpio",
      provider_suspicious: "Provider sospechoso",
      provider_score_below_80: "Provider debajo del score minimo",
      ev_gte_5: "EV supera el minimo operativo",
      ev_below_5: "EV debajo del minimo operativo",
      model_prob_gte_55: "Probabilidad del modelo supera 55%",
      model_prob_below_55: "Probabilidad del modelo debajo de 55%",
      model_prob_below_threshold: "Probabilidad del modelo debajo del minimo requerido",
      odds_2_01_plus_value_band: "Cuota dentro de la zona fuerte 2.01+",
      odds_band_2_01_plus: "Cuota dentro de la zona fuerte 2.01+",
      odds_below_promotable_band: "Cuota fuera de la zona fuerte actual",
      stale_line: "Linea vieja o desactualizada",
      duplicate_exposure: "Exposicion duplicada al mismo partido",
      duplicate_secondary_exposure: "Book secundario duplicado",
      suspicious_move: "Movimiento de linea sospechoso",
      missing_pitcher_context: "Falta pitcher abridor",
      missing_bullpen_context: "Falta contexto de bullpen",
      missing_lineup_context: "Falta lineup/ofensiva",
      missing_travel_rest_context: "Falta descanso/viaje",
      recent_clv_positive: "CLV reciente apoya la senal",
      recent_clv_10_negative: "CLV reciente negativo",
      high_ev_gt_25: "EV alto requiere revision",
      extreme_ev_gt_40: "EV extremo requiere auditoria",
      timestamp_gap_gt_6h: "Modelo y cuota pueden estar desfasados",
      home_pick_context: "Pick local con contexto favorable basico",
      no_duplicate_exposure: "Sin exposicion duplicada",
      no_suspicious_move: "Sin movimiento sospechoso",
      fresh_line: "Linea fresca",
      real_provider_processed: "Dato real procesado",
      safety_guardrails_off: "Dinero real, Kelly y Telegram automatico apagados"
    };
    return map[value] || value.replace(/_/g, " ");
  }


  async function buildPendingSettlementMonitor() {
    const summary = await db.query(`
      WITH base AS (
        SELECT
          rps.id,
          rps.status AS snapshot_status,
          rps.entry_timestamp,
          rps.closing_odds,
          rps.result,
          rps.pick,
          rps.entry_odds,
          rps.model_probability,
          rps.expected_value,
          m.id AS match_id,
          m.status::text AS match_status,
          m.match_date,
          m.home_score,
          m.away_score
        FROM real_paper_snapshots rps
        JOIN v_valid_matches m ON m.id = rps.match_id
        WHERE rps.sport_slug = 'baseball'
          AND rps.league_slug = 'mlb'
          AND rps.market_type = 'moneyline_2way'
      )
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE snapshot_status = 'OPEN')::int AS open,
        COUNT(*) FILTER (WHERE snapshot_status = 'PENDING_CLOSING')::int AS pending_closing,
        COUNT(*) FILTER (WHERE snapshot_status IN ('PENDING_RESULT', 'PENDING_RESULTS'))::int AS pending_results,
        COUNT(*) FILTER (WHERE snapshot_status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED'))::int AS closed,
        COUNT(*) FILTER (
          WHERE snapshot_status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
            AND match_status = 'finished'
            AND home_score IS NOT NULL
            AND away_score IS NOT NULL
        )::int AS finished_ready_for_settle,
        COUNT(*) FILTER (
          WHERE snapshot_status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
            AND COALESCE(match_status, '') NOT IN ('finished', 'cancelled', 'postponed')
            AND match_date > NOW()
        )::int AS not_started,
        COUNT(*) FILTER (
          WHERE snapshot_status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
            AND COALESCE(match_status, '') IN ('live', 'in_progress', 'halftime')
        )::int AS live,
        COUNT(*) FILTER (
          WHERE snapshot_status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
            AND match_status = 'finished'
            AND (home_score IS NULL OR away_score IS NULL)
        )::int AS finished_missing_score,
        MAX(entry_timestamp) AS latest_entry,
        MIN(entry_timestamp) FILTER (WHERE snapshot_status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')) AS oldest_open_entry
      FROM base;
    `);

    const rows = await db.query(`
      SELECT
        rps.id,
        rps.status AS snapshot_status,
        rps.pick,
        rps.entry_odds,
        rps.closing_odds,
        rps.model_probability,
        rps.expected_value,
        rps.entry_timestamp,
        m.status::text AS match_status,
        m.match_date,
        m.home_score,
        m.away_score,
        home_team.name AS home_team,
        away_team.name AS away_team,
        CASE
          WHEN rps.status = 'PENDING_CLOSING' THEN 'MISSING_CLOSING'
          WHEN m.status = 'finished' AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL THEN 'READY_TO_SETTLE'
          WHEN COALESCE(m.status::text, '') IN ('live', 'in_progress', 'halftime') THEN 'IN_PLAY'
          WHEN m.match_date > NOW() THEN 'NOT_STARTED'
          WHEN m.status = 'finished' THEN 'FINISHED_MISSING_SCORE'
          ELSE 'WAITING'
        END AS settlement_state
      FROM real_paper_snapshots rps
      JOIN v_valid_matches m ON m.id = rps.match_id
      LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
      LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
      LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
      LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
      WHERE rps.sport_slug = 'baseball'
        AND rps.league_slug = 'mlb'
        AND rps.market_type = 'moneyline_2way'
        AND rps.status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
      ORDER BY
        CASE
          WHEN m.status = 'finished' AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL THEN 0
          WHEN rps.status = 'PENDING_CLOSING' THEN 1
          WHEN COALESCE(m.status::text, '') IN ('live', 'in_progress', 'halftime') THEN 2
          ELSE 3
        END,
        m.match_date ASC,
        rps.entry_timestamp ASC
      LIMIT 25;
    `);

    const s = summary.rows[0] || {};
    let recommendation = 'Sin accion: no hay snapshots MLB Real Paper abiertos.';
    if (Number(s.finished_ready_for_settle || 0) > 0) {
      recommendation = 'Correr ForceClosing + settlement: hay partidos finished listos para liquidar.';
    } else if (Number(s.pending_closing || 0) > 0) {
      recommendation = 'Correr ClosingOnly/ForceClosing: hay snapshots esperando closing odds.';
    } else if (Number(s.live || 0) > 0) {
      recommendation = 'Esperar final de partidos en vivo y volver a correr ForceClosing.';
    } else if (Number(s.not_started || 0) > 0 || Number(s.open || 0) > 0) {
      recommendation = 'Esperar que terminen los partidos abiertos; checked=0 es normal si no hay finished.';
    }

    return {
      summary: s,
      rows: rows.rows,
      recommendation,
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        note: 'Monitor de settlement solo lectura. No liquida ni activa dinero real.'
      }
    };
  }
  async function buildCommandCenter() {
    const [decisions, underdogPlus, matchup, highEv, whyNo, audit, pilot] = await Promise.all([
      buildPickDecisionRows(),
      buildUnderdogPlusV2(),
      buildMatchupConfirmation(),
      buildHighEvAudit(),
      buildWhyNoBettablePaper(),
      db.query(`
        SELECT *
        FROM (
          SELECT
            'overall' AS group_type,
            'all' AS group_value,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED'))::int AS closed,
            COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
            COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
            ROUND((COALESCE(SUM(profit_loss), 0) / 100.0)::numeric, 4) AS profit_units,
            ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND duplicate_of_id IS NULL
            AND COALESCE(data_state, 'FRESH') IN ('FRESH', 'ARCHIVED')
        ) x
      `),
      db.query(`SELECT false AS real_money_enabled, false AS kelly_enabled, false AS telegram_auto_enabled, true AS kill_switch_enabled`)
    ]);

    const decisionCounts = decisions.counts || {};
    const matchupCounts = matchup.counts || {};
    const underdogCounts = underdogPlus.counts || {};
    const pilotFlags = pilot.rows[0] || {};
    const realCandidateCount = 0;

    const simpleRows = (matchup.rows || [])
      .filter((row: Record<string, any>) => Number(row.exposure_rank || 1) === 1)
      .filter((row: Record<string, any>) => !['EXPIRED', 'STALE_ARCHIVED'].includes(String(row.snapshot_status || row.status || '')))
      .map((row: Record<string, any>) => {
        const positive = [
          ...(row.confirmation_reasons || []),
          ...(row.reasons_passed || [])
        ].slice(0, 5).map(humanizeReason);
        const negative = [
          ...(row.conflict_reasons || []),
          ...(row.warnings || []),
          ...(row.reasons_blocked || []),
          ...(row.flags || [])
        ].slice(0, 5).map(humanizeReason);
        const finalStatus = row.final_operational_status || row.decision || 'REVIEW';
        const confidence = finalStatus === 'BETTABLE_PAPER_CONFIRMED'
          ? 'Alta'
          : row.decision === 'BETTABLE_PAPER' && row.matchup_status === 'MATCHUP_WEAK_CONFIRMATION'
            ? 'Media-Alta'
            : row.decision === 'BETTABLE_PAPER'
              ? 'Media'
              : 'Baja';
        return {
          id: row.id,
          match: row.match || `${row.home_team_name || 'Home'} vs ${row.away_team_name || 'Away'}`,
          pick: row.pick,
          recommended_pick: `${row.pick === 'home' ? row.home_team_name : row.pick === 'away' ? row.away_team_name : row.pick} ML`,
          simple_status: finalStatus,
          confidence,
          odds: row.entry_odds,
          model_probability: row.model_probability,
          expected_value: row.expected_value,
          edge_grade: row.edge_grade || row.grade,
          provider: row.provider_name || row.bookmaker,
          pick_decision: row.pick_decision || row.decision,
          underdog_plus_status: row.underdog_plus_status,
          matchup_status: row.matchup_status,
          high_ev_audit_status: row.high_ev_audit_status,
          positive_reasons: positive,
          negative_reasons: negative,
          recommended_action: finalStatus === 'BETTABLE_PAPER_CONFIRMED'
            ? 'Solo Real Paper: monitorear, no dinero real.'
            : finalStatus === 'VALUE_ONLY_REVIEW'
              ? 'Revisar/monitorear en paper; falta confirmacion completa.'
              : finalStatus === 'MODEL_CONFLICT_REVIEW'
                ? 'No tocar; revisar conflicto de matchup.'
                : 'No tocar; esperar datos frescos o cierre.'
        };
      })
      .sort((a: Record<string, any>, b: Record<string, any>) => {
        const rank = (status: string) => ({ BETTABLE_PAPER_CONFIRMED: 0, VALUE_ONLY_REVIEW: 1, BETTABLE_PAPER: 2, MODEL_CONFLICT_REVIEW: 3 }[status] ?? 9);
        return rank(String(a.simple_status)) - rank(String(b.simple_status)) || Number(b.expected_value || 0) - Number(a.expected_value || 0);
      });

    const bettable = Number(decisionCounts.BETTABLE_PAPER || 0);
    const confirmed = Number(matchupCounts.BETTABLE_PAPER_CONFIRMED || 0);
    const review = Number(matchupCounts.VALUE_ONLY_REVIEW || 0) + Number(matchupCounts.MODEL_CONFLICT_REVIEW || 0) + Number(matchupCounts.INSUFFICIENT_CONTEXT || 0) + Number(decisionCounts.NEEDS_MANUAL_REVIEW || 0);
    const blocked = Number(decisionCounts.BLOCKED_BY_RISK || 0) + Number(decisionCounts.REJECT || 0);
    const recommendedAction = confirmed > 0
      ? 'REAL_PAPER_MONITOR'
      : bettable > 0 || review > 0
        ? 'REVIEW_ONLY'
        : whyNo.dominant_reason === 'stale_line' || whyNo.dominant_reason === 'no_fresh_candidates'
          ? 'DATA_REFRESH_NEEDED'
          : 'NO_ACTION';

    const market = audit.rows[0] || {};
    return {
      system_status: 'SAFE / REAL PAPER ONLY',
      recommended_action: recommendedAction,
      real_candidate_count: realCandidateCount,
      real_money_enabled: Boolean(pilotFlags.real_money_enabled),
      kelly_enabled: Boolean(pilotFlags.kelly_enabled),
      telegram_auto_enabled: Boolean(pilotFlags.telegram_auto_enabled),
      kill_switch_enabled: true,
      counts: {
        bettable_paper_confirmed: confirmed,
        bettable_paper: bettable,
        underdog_plus_paper: underdogCounts.UNDERDOG_PLUS_PAPER || 0,
        value_only_review: matchupCounts.VALUE_ONLY_REVIEW || 0,
        model_conflict_review: matchupCounts.MODEL_CONFLICT_REVIEW || 0,
        insufficient_context: matchupCounts.INSUFFICIENT_CONTEXT || 0,
        needs_manual_review: decisionCounts.NEEDS_MANUAL_REVIEW || 0,
        blocked_by_risk: decisionCounts.BLOCKED_BY_RISK || 0,
        reject: decisionCounts.REJECT || 0,
        high_ev_extreme: highEv.extreme_ev_count || 0,
        duplicate_count: highEv.duplicate_count || 0,
        review,
        blocked
      },
      dominant_block_reason: whyNo.dominant_reason || (highEv.extreme_ev_count ? 'extreme_ev_review' : 'none'),
      today_picks_simple: simpleRows,
      market_health_simple: {
        market: 'MLB Moneyline',
        status: Number(market.closed || 0) >= 75 && Number(market.profit_units || 0) > 0 ? 'READY_FOR_REVIEW' : 'ACCUMULATING',
        closed: market.closed || 0,
        wins: market.wins || 0,
        losses: market.losses || 0,
        average_clv: market.avg_clv || null,
        profit_units: market.profit_units || 0,
        best_segment: 'odds >= 2.01',
        avoid_segment: 'odds 1.61-2.00 / modelProb 52-55 / run line real / totals real'
      },
      why_this_pick_legend: {
        BETTABLE_PAPER_CONFIRMED: 'Matematica, riesgo, EV audit y matchup alineados; sigue siendo solo paper.',
        VALUE_ONLY_REVIEW: 'Hay valor matematico, pero falta confirmacion completa o hay EV extremo por revisar.',
        MODEL_CONFLICT_REVIEW: 'El contexto o auditoria contradice al modelo.',
        REJECT: 'No cumple filtros minimos.'
      },
      real_paper_only: true,
      guardrails: {
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        kill_switch_enabled: true
      }
    };
  }

  async function buildHighEvAudit() {
    const decisions = await buildPickDecisionRows();
    const rows = (decisions.rows || []).map((row: Record<string, any>) => {
      const audit = auditHighEvDuplicate(row);
      return {
        ...row,
        ...audit,
        provider: row.provider_name || row.bookmaker || "-",
        model_probability_pct: Number(row.model_probability || 0),
        expected_value_pct: Number(row.expected_value || 0)
      };
    });

    const highEvRows = rows.filter((row: Record<string, any>) => Number(row.expected_value || 0) > 0.25);
    const extremeEvRows = rows.filter((row: Record<string, any>) => Number(row.expected_value || 0) > 0.40);
    const duplicateRows = rows.filter((row: Record<string, any>) => Number(row.exposure_rank || 1) > 1 || Number(row.open_exposure_count || 0) > 0);
    const cleanHighEvRows = highEvRows.filter((row: Record<string, any>) => row.audit_clean === true);

    const historical = await db.query(
      `
        WITH samples AS (
          SELECT
            CASE
              WHEN expected_value >= 0.40 THEN 'EV_40_PLUS'
              WHEN expected_value >= 0.25 THEN 'EV_25_40'
              WHEN expected_value >= 0.10 THEN 'EV_10_25'
              WHEN expected_value >= 0.05 THEN 'EV_5_10'
              ELSE 'EV_OTHER'
            END AS ev_bucket,
            *
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
        )
        SELECT
          ev_bucket,
          COUNT(*)::int AS closed,
          COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
          COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
          CASE WHEN COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS')) > 0
            THEN ROUND((COUNT(*) FILTER (WHERE status = 'WIN')::numeric / COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS'))), 6)
            ELSE NULL
          END AS win_rate,
          ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
          ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
          CASE WHEN COUNT(*) FILTER (WHERE clv IS NOT NULL) > 0
            THEN ROUND((COUNT(*) FILTER (WHERE clv > 0)::numeric / COUNT(*) FILTER (WHERE clv IS NOT NULL)), 6)
            ELSE NULL
          END AS clv_positive_rate,
          ROUND(AVG(POWER((CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) - model_probability, 2))::numeric, 6) AS brier,
          ROUND(AVG(entry_odds)::numeric, 4) AS avg_odds,
          ROUND(AVG(model_probability)::numeric, 6) AS avg_model_prob
        FROM samples
        GROUP BY ev_bucket
        ORDER BY CASE ev_bucket
          WHEN 'EV_40_PLUS' THEN 1
          WHEN 'EV_25_40' THEN 2
          WHEN 'EV_10_25' THEN 3
          WHEN 'EV_5_10' THEN 4
          ELSE 5
        END
      `
    );

    const providerBreakdown = await db.query(
      `
        SELECT
          bookmaker,
          CASE
            WHEN expected_value >= 0.40 THEN 'EV_40_PLUS'
            WHEN expected_value >= 0.25 THEN 'EV_25_40'
            WHEN expected_value >= 0.10 THEN 'EV_10_25'
            WHEN expected_value >= 0.05 THEN 'EV_5_10'
            ELSE 'EV_OTHER'
          END AS ev_bucket,
          COUNT(*)::int AS closed,
          COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
          COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
          ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
          ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv
        FROM real_paper_snapshots
        WHERE sport_slug = 'baseball'
          AND league_slug = 'mlb'
          AND market_type = 'moneyline_2way'
          AND expected_value >= 0.25
          AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
        GROUP BY bookmaker, ev_bucket
        ORDER BY ev_bucket, profit_units DESC
        LIMIT 50
      `
    );

    return {
      total_picks: rows.length,
      unique_exposures: rows.filter((row: Record<string, any>) => Number(row.exposure_rank || 1) === 1).length,
      duplicate_count: duplicateRows.length,
      high_ev_count: highEvRows.length,
      extreme_ev_count: extremeEvRows.length,
      odds_outlier_count: rows.filter((row: Record<string, any>) => row.high_ev_audit_status === "ODDS_OUTLIER_REVIEW").length,
      timestamp_mismatch_count: rows.filter((row: Record<string, any>) => row.high_ev_audit_status === "TIMESTAMP_MISMATCH_REVIEW").length,
      clean_high_ev_count: cleanHighEvRows.length,
      examples: rows.slice(0, 100),
      rows,
      historical_performance: historical.rows,
      provider_breakdown: providerBreakdown.rows,
      recommendations: [
        "Solo exposure_rank=1 puede avanzar.",
        "EV >25% requiere auditoria; EV >40% requiere revision extrema.",
        "No permitir BETTABLE_PAPER_CONFIRMED si hay timestamp mismatch, duplicate, provider review, stale, suspicious move o grade C/F.",
        "Todo sigue Real Paper only; no dinero real, no Kelly, no Telegram automatico."
      ],
      guardrails: {
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        kill_switch_enabled: true
      }
    };
  }

  async function buildTimestampMismatchAudit() {
    const rows = await db.query(
      `
        WITH latest_odds AS (
          SELECT DISTINCT ON (os.market_quote_id, os.selection)
            os.market_quote_id,
            os.selection,
            os.captured_at AS latest_snapshot_at,
            os.received_at AS latest_received_at,
            os.odds AS latest_odds,
            os.provider_name,
            os.bookmaker
          FROM odds_snapshots os
          ORDER BY os.market_quote_id, os.selection, os.captured_at DESC
        ),
        latest_model AS (
          SELECT DISTINCT ON (mq.match_id, mq.market_type, COALESCE(mq.line, -9999))
            mq.id AS latest_model_quote_id,
            mq.match_id,
            mq.market_type,
            mq.line,
            mq.home_probability,
            mq.away_probability,
            mq.draw_probability,
            mq.confidence AS latest_model_confidence,
            mq.generated_at AS latest_model_generated_at
          FROM model_quotes mq
          ORDER BY mq.match_id, mq.market_type, COALESCE(mq.line, -9999), mq.generated_at DESC
        ),
        latest_features AS (
          SELECT DISTINCT ON (mf.match_id)
            mf.match_id,
            mf.generated_at AS latest_feature_generated_at,
            mf.feature_set
          FROM model_features mf
          ORDER BY mf.match_id, mf.generated_at DESC
        ),
        active AS (
          SELECT
            rps.id,
            rps.match_id,
            rps.model_quote_id AS entry_model_quote_id,
            lm.latest_model_quote_id,
            rps.market_quote_id,
            rps.sport_slug,
            rps.league_slug,
            rps.market_type,
            rps.line,
            rps.pick,
            rps.bookmaker AS entry_bookmaker,
            rps.entry_odds,
            lo.latest_odds,
            rps.entry_timestamp,
            lo.latest_snapshot_at,
            lm.latest_model_generated_at,
            lf.latest_feature_generated_at,
            rps.model_probability AS original_model_probability,
            CASE
              WHEN rps.pick = 'home' THEN lm.home_probability
              WHEN rps.pick = 'away' THEN lm.away_probability
              WHEN rps.pick = 'draw' THEN lm.draw_probability
              ELSE NULL
            END AS latest_model_probability,
            lm.latest_model_confidence,
            rps.expected_value AS ev_original,
            home_team.name AS home_team_name,
            away_team.name AS away_team_name,
            ROUND(EXTRACT(EPOCH FROM (COALESCE(lo.latest_snapshot_at, rps.entry_timestamp) - rps.entry_timestamp)) / 3600.0, 2) AS odds_gap_hours,
            ROUND(EXTRACT(EPOCH FROM (COALESCE(lm.latest_model_generated_at, rps.entry_timestamp) - rps.entry_timestamp)) / 3600.0, 2) AS model_gap_hours,
            ROUND(EXTRACT(EPOCH FROM (COALESCE(lf.latest_feature_generated_at, rps.entry_timestamp) - rps.entry_timestamp)) / 3600.0, 2) AS feature_gap_hours,
            ROUND(EXTRACT(EPOCH FROM (COALESCE(lo.latest_snapshot_at, rps.entry_timestamp) - COALESCE(lm.latest_model_generated_at, rps.entry_timestamp))) / 3600.0, 2) AS odds_vs_model_hours,
            ROUND(EXTRACT(EPOCH FROM (COALESCE(lm.latest_model_generated_at, rps.entry_timestamp) - COALESCE(lf.latest_feature_generated_at, rps.entry_timestamp))) / 3600.0, 2) AS model_vs_feature_hours
          FROM real_paper_snapshots rps
          JOIN v_valid_matches m ON m.id = rps.match_id
          LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
          LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
          LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
          LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
          LEFT JOIN latest_odds lo ON lo.market_quote_id = rps.market_quote_id AND lo.selection = rps.pick
          LEFT JOIN latest_model lm ON lm.match_id = rps.match_id
            AND lm.market_type = rps.market_type
            AND COALESCE(lm.line, -9999) = COALESCE(rps.line, -9999)
          LEFT JOIN latest_features lf ON lf.match_id = rps.match_id
          WHERE rps.status NOT IN ('ARCHIVED', 'WIN', 'LOSS', 'PUSH', 'SETTLED')
            AND COALESCE(rps.data_state, 'FRESH') = 'FRESH'
        )
        SELECT
          *,
          ROUND((original_model_probability * latest_odds - 1)::numeric, 6) AS ev_odds_refreshed,
          ROUND((COALESCE(latest_model_probability, original_model_probability) * latest_odds - 1)::numeric, 6) AS ev_fully_refreshed,
          CASE
            WHEN latest_odds IS NULL THEN 'MISSING_LATEST_ODDS'
            WHEN latest_model_generated_at IS NULL THEN 'MISSING_LATEST_MODEL'
            WHEN ABS(COALESCE(odds_vs_model_hours, 999)) > 6 THEN 'MODEL_ODDS_TIMESTAMP_MISMATCH'
            WHEN COALESCE(ev_original, 0) > 0 AND (original_model_probability * latest_odds - 1) <= 0 THEN 'EV_DROPPED_WITH_LATEST_ODDS'
            WHEN (COALESCE(latest_model_probability, original_model_probability) * latest_odds - 1) > 0 THEN 'EV_SURVIVES_REFRESH_REVIEW'
            ELSE 'EV_NOT_SUPPORTED_BY_REFRESH'
          END AS audit_status,
          TRUE AS blocks_confirmation,
          CASE
            WHEN latest_odds IS NULL THEN 'Falta cuota reciente; no confirmar.'
            WHEN latest_model_generated_at IS NULL THEN 'Falta modelo reciente; recalcular antes de confiar.'
            WHEN ABS(COALESCE(odds_vs_model_hours, 999)) > 6 THEN 'Modelo y cuota no estan sincronizados; recalcular pipeline antes de confirmar.'
            WHEN COALESCE(ev_original, 0) > 0 AND (original_model_probability * latest_odds - 1) <= 0 THEN 'El EV se cayo con la cuota actual; descartar como edge operativo.'
            WHEN (COALESCE(latest_model_probability, original_model_probability) * latest_odds - 1) > 0 THEN 'EV se sostiene con datos refrescados, pero sigue en review hasta cerrar timestamp/contexto.'
            ELSE 'EV no queda apoyado por datos recientes; mantener no-bet/review.'
          END AS recommendation
        FROM active
        ORDER BY
          CASE
            WHEN latest_odds IS NULL OR latest_model_generated_at IS NULL THEN 0
            WHEN ABS(COALESCE(odds_vs_model_hours, 999)) > 6 THEN 1
            WHEN (COALESCE(latest_model_probability, original_model_probability) * latest_odds - 1) > 0 THEN 2
            ELSE 3
          END,
          ev_fully_refreshed DESC NULLS LAST
      `
    );

    const summary = rows.rows.reduce<Record<string, number>>((acc, row: Record<string, any>) => {
      const status = String(row.audit_status || "UNKNOWN");
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    const mismatchCount = rows.rows.filter((row: Record<string, any>) => String(row.audit_status || "").includes("MISMATCH")).length;
    const evSurvivesCount = rows.rows.filter((row: Record<string, any>) => row.audit_status === "EV_SURVIVES_REFRESH_REVIEW").length;

    return {
      count: rows.rows.length,
      blocked_count: rows.rows.filter((row: Record<string, any>) => row.blocks_confirmation === true).length,
      mismatch_count: mismatchCount,
      ev_survives_refresh_count: evSurvivesCount,
      summary,
      rows: rows.rows,
      recommendation: mismatchCount > 0
        ? "Hay desfase entre modelo y cuota; no confirmar hasta recalcular y cerrar snapshot sincronizado."
        : evSurvivesCount > 0
          ? "El EV sobrevive con datos refrescados, pero sigue Real Paper/review hasta cierre y contexto completo."
          : "No hay EV activo apoyado por refresco; mantener no-bet/review.",
      guardrails: {
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        kill_switch_enabled: true
      }
    };
  }

  async function buildExtremeEvClosingAudit() {
    const summary = await db.query(
      `
        WITH samples AS (
          SELECT
            CASE
              WHEN expected_value >= 0.60 THEN 'EV_60_PLUS'
              WHEN expected_value >= 0.40 THEN 'EV_40_60'
              WHEN expected_value >= 0.25 THEN 'EV_25_40'
              WHEN expected_value >= 0.10 THEN 'EV_10_25'
              WHEN expected_value >= 0.05 THEN 'EV_5_10'
              ELSE 'EV_OTHER'
            END AS ev_bucket,
            CASE
              WHEN closing_odds IS NULL THEN 'MISSING_CLOSING'
              WHEN ABS(closing_odds - entry_odds) < 0.0001 THEN 'CLOSING_SAME_AS_ENTRY'
              WHEN ABS(COALESCE(clv, 0)) >= 0.25 THEN 'CLV_EXTREME_MOVE'
              WHEN COALESCE(clv, 0) > 0 THEN 'CLV_POSITIVE'
              WHEN COALESCE(clv, 0) < 0 THEN 'CLV_NEGATIVE'
              ELSE 'CLV_FLAT'
            END AS closing_quality_bucket,
            *
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
            AND expected_value >= 0.05
        )
        SELECT
          ev_bucket,
          closing_quality_bucket,
          COUNT(*)::int AS closed,
          COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
          COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
          ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
          ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
          ROUND(AVG(entry_odds)::numeric, 4) AS avg_entry_odds,
          ROUND(AVG(closing_odds) FILTER (WHERE closing_odds IS NOT NULL)::numeric, 4) AS avg_closing_odds,
          CASE
            WHEN COUNT(*) FILTER (WHERE closing_odds IS NOT NULL) > 0
              THEN ROUND((COUNT(*) FILTER (WHERE ABS(closing_odds - entry_odds) < 0.0001)::numeric / COUNT(*) FILTER (WHERE closing_odds IS NOT NULL)), 6)
            ELSE NULL
          END AS same_close_rate,
          CASE
            WHEN COUNT(*) FILTER (WHERE clv IS NOT NULL) > 0
              THEN ROUND((COUNT(*) FILTER (WHERE clv > 0)::numeric / COUNT(*) FILTER (WHERE clv IS NOT NULL)), 6)
            ELSE NULL
          END AS clv_positive_rate,
          CASE
            WHEN COUNT(*) FILTER (WHERE closing_odds IS NULL) > 0 THEN 'MISSING_CLOSING_REVIEW'
            WHEN COUNT(*) FILTER (WHERE ABS(COALESCE(clv, 0)) >= 0.25) > 0 THEN 'CLV_EXTREME_REVIEW'
            WHEN COUNT(*) >= 10 AND COALESCE(SUM(profit_loss), 0) > 0 AND COALESCE(AVG(clv) FILTER (WHERE clv IS NOT NULL), 0) <= 0 THEN 'EV_INFLATION_REVIEW'
            WHEN COUNT(*) >= 10
              AND COUNT(*) FILTER (WHERE closing_odds IS NOT NULL) > 0
              AND (COUNT(*) FILTER (WHERE ABS(closing_odds - entry_odds) < 0.0001)::numeric / COUNT(*) FILTER (WHERE closing_odds IS NOT NULL)) >= 0.50
              THEN 'CLOSING_UNCHANGED_REVIEW'
            WHEN COUNT(*) >= 10 AND COALESCE(AVG(clv) FILTER (WHERE clv IS NOT NULL), 0) > 0 THEN 'CLOSING_SUPPORTS_EDGE'
            ELSE 'ACCUMULATING'
          END AS audit_status,
          CASE
            WHEN COUNT(*) FILTER (WHERE closing_odds IS NULL) > 0 THEN 'Completar closing odds antes de confiar en el EV.'
            WHEN COUNT(*) FILTER (WHERE ABS(COALESCE(clv, 0)) >= 0.25) > 0 THEN 'Revisar movimientos CLV extremos; puede haber cruce de provider o closing incorrecto.'
            WHEN COUNT(*) >= 10 AND COALESCE(SUM(profit_loss), 0) > 0 AND COALESCE(AVG(clv) FILTER (WHERE clv IS NOT NULL), 0) <= 0 THEN 'Profit positivo con CLV no positivo: mantener en review, posible EV inflado.'
            WHEN COUNT(*) >= 10
              AND COUNT(*) FILTER (WHERE closing_odds IS NOT NULL) > 0
              AND (COUNT(*) FILTER (WHERE ABS(closing_odds - entry_odds) < 0.0001)::numeric / COUNT(*) FILTER (WHERE closing_odds IS NOT NULL)) >= 0.50
              THEN 'Demasiados closings iguales al entry; mejorar captura ClosingOnly antes de promover.'
            WHEN COUNT(*) >= 10 AND COALESCE(AVG(clv) FILTER (WHERE clv IS NOT NULL), 0) > 0 THEN 'CLV apoya el edge en Real Paper; seguir midiendo sin dinero real.'
            ELSE 'Muestra chica; seguir acumulando.'
          END AS recommendation
        FROM samples
        GROUP BY ev_bucket, closing_quality_bucket
        ORDER BY
          CASE ev_bucket
            WHEN 'EV_60_PLUS' THEN 1
            WHEN 'EV_40_60' THEN 2
            WHEN 'EV_25_40' THEN 3
            WHEN 'EV_10_25' THEN 4
            WHEN 'EV_5_10' THEN 5
            ELSE 6
          END,
          closed DESC
      `
    );

    const rows = await db.query(
      `
        SELECT
          rps.id,
          rps.pick,
          rps.bookmaker,
          rps.entry_odds,
          rps.closing_odds,
          rps.model_probability,
          rps.expected_value,
          rps.clv,
          rps.profit_loss,
          rps.status,
          rps.entry_timestamp,
          home_team.name AS home_team_name,
          away_team.name AS away_team_name,
          CASE
            WHEN rps.expected_value >= 0.60 THEN 'EV_60_PLUS'
            WHEN rps.expected_value >= 0.40 THEN 'EV_40_60'
            WHEN rps.expected_value >= 0.25 THEN 'EV_25_40'
            WHEN rps.expected_value >= 0.10 THEN 'EV_10_25'
            WHEN rps.expected_value >= 0.05 THEN 'EV_5_10'
            ELSE 'EV_OTHER'
          END AS ev_bucket,
          CASE
            WHEN rps.closing_odds IS NULL THEN 'MISSING_CLOSING_REVIEW'
            WHEN ABS(rps.closing_odds - rps.entry_odds) < 0.0001 AND rps.expected_value >= 0.40 THEN 'CLOSING_UNCHANGED_REVIEW'
            WHEN ABS(COALESCE(rps.clv, 0)) >= 0.25 THEN 'CLV_EXTREME_REVIEW'
            WHEN rps.expected_value >= 0.40 AND COALESCE(rps.clv, 0) <= 0 THEN 'EV_INFLATION_REVIEW'
            WHEN COALESCE(rps.clv, 0) > 0 THEN 'CLOSING_SUPPORTS_EDGE'
            ELSE 'CLOSING_NEUTRAL_REVIEW'
          END AS audit_status,
          CASE
            WHEN rps.closing_odds IS NULL THEN 'Falta closing odds; no usar como evidencia de edge.'
            WHEN ABS(rps.closing_odds - rps.entry_odds) < 0.0001 AND rps.expected_value >= 0.40 THEN 'Closing igual al entry en EV extremo; revisar captura ClosingOnly/provider.'
            WHEN ABS(COALESCE(rps.clv, 0)) >= 0.25 THEN 'CLV extremo; revisar si entry y closing vienen de la misma base.'
            WHEN rps.expected_value >= 0.40 AND COALESCE(rps.clv, 0) <= 0 THEN 'EV extremo sin apoyo de CLV; posible EV inflado.'
            WHEN COALESCE(rps.clv, 0) > 0 THEN 'Closing apoya la entrada; seguir midiendo en Real Paper.'
            ELSE 'Closing neutral; conservar en review.'
          END AS recommendation
        FROM real_paper_snapshots rps
        JOIN v_valid_matches m ON m.id = rps.match_id
        LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
        LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
        WHERE rps.sport_slug = 'baseball'
          AND rps.league_slug = 'mlb'
          AND rps.market_type = 'moneyline_2way'
          AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
          AND rps.expected_value >= 0.25
        ORDER BY
          CASE
            WHEN rps.closing_odds IS NULL THEN 0
            WHEN ABS(COALESCE(rps.clv, 0)) >= 0.25 THEN 1
            WHEN ABS(rps.closing_odds - rps.entry_odds) < 0.0001 AND rps.expected_value >= 0.40 THEN 2
            WHEN rps.expected_value >= 0.40 AND COALESCE(rps.clv, 0) <= 0 THEN 3
            ELSE 4
          END,
          rps.entry_timestamp DESC
        LIMIT 100
      `
    );

    const issueCount = rows.rows.filter((row: Record<string, any>) => !["CLOSING_SUPPORTS_EDGE", "CLOSING_NEUTRAL_REVIEW"].includes(String(row.audit_status))).length;
    return {
      total_review_rows: rows.rows.length,
      issue_count: issueCount,
      summary: summary.rows,
      rows: rows.rows,
      recommendation: issueCount > 0
        ? "Hay EV extremo con closing dudoso; mantener Real Paper only y mejorar captura de closing antes de promover."
        : "No hay alertas fuertes de closing en EV alto; seguir acumulando Real Paper.",
      guardrails: {
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        kill_switch_enabled: true
      }
    };
  }

  async function buildClosingSupportedEdge() {
    const rows = await db.query(
      `
        WITH rules AS (
          SELECT *
          FROM (VALUES
            ('mlb_moneyline_all', 'MLB Moneyline All', 'TRUE'),
            ('mlb_moneyline_odds_2_01_plus', 'MLB Moneyline Odds 2.01+', 'entry_odds >= 2.01'),
            ('mlb_moneyline_underdogs', 'MLB Moneyline Underdogs', 'entry_odds >= 2.01'),
            ('mlb_moneyline_home', 'MLB Moneyline Home', 'pick = ''home'''),
            ('mlb_moneyline_away', 'MLB Moneyline Away', 'pick = ''away'''),
            ('mlb_moneyline_model_55_60', 'MLB Model Prob 55-60', 'model_probability >= 0.55 AND model_probability < 0.60'),
            ('mlb_moneyline_model_60_plus', 'MLB Model Prob 60+', 'model_probability >= 0.60'),
            ('mlb_moneyline_ev_25_plus', 'MLB EV 25%+', 'expected_value >= 0.25'),
            ('mlb_moneyline_ev_40_plus', 'MLB EV 40%+', 'expected_value >= 0.40')
          ) AS r(rule_key, rule_name, predicate_label)
        ),
        samples AS (
          SELECT
            r.rule_key,
            r.rule_name,
            r.predicate_label,
            rps.*
          FROM rules r
          JOIN real_paper_snapshots rps ON rps.sport_slug = 'baseball'
            AND rps.league_slug = 'mlb'
            AND rps.market_type = 'moneyline_2way'
            AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
            AND (
              r.rule_key = 'mlb_moneyline_all'
              OR (r.rule_key = 'mlb_moneyline_odds_2_01_plus' AND rps.entry_odds >= 2.01)
              OR (r.rule_key = 'mlb_moneyline_underdogs' AND rps.entry_odds >= 2.01)
              OR (r.rule_key = 'mlb_moneyline_home' AND rps.pick = 'home')
              OR (r.rule_key = 'mlb_moneyline_away' AND rps.pick = 'away')
              OR (r.rule_key = 'mlb_moneyline_model_55_60' AND rps.model_probability >= 0.55 AND rps.model_probability < 0.60)
              OR (r.rule_key = 'mlb_moneyline_model_60_plus' AND rps.model_probability >= 0.60)
              OR (r.rule_key = 'mlb_moneyline_ev_25_plus' AND rps.expected_value >= 0.25)
              OR (r.rule_key = 'mlb_moneyline_ev_40_plus' AND rps.expected_value >= 0.40)
            )
        ),
        grouped AS (
          SELECT
            rule_key,
            rule_name,
            predicate_label,
            COUNT(*)::int AS closed,
            COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
            COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
            ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
            ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
            CASE
              WHEN COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS')) > 0
                THEN ROUND((COUNT(*) FILTER (WHERE status = 'WIN')::numeric / COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS'))), 6)
              ELSE NULL
            END AS win_rate,
            CASE
              WHEN COUNT(*) FILTER (WHERE clv IS NOT NULL) > 0
                THEN ROUND((COUNT(*) FILTER (WHERE clv > 0)::numeric / COUNT(*) FILTER (WHERE clv IS NOT NULL)), 6)
              ELSE NULL
            END AS clv_positive_rate,
            CASE
              WHEN COUNT(*) FILTER (WHERE closing_odds IS NOT NULL) > 0
                THEN ROUND((COUNT(*) FILTER (WHERE ABS(closing_odds - entry_odds) < 0.0001)::numeric / COUNT(*) FILTER (WHERE closing_odds IS NOT NULL)), 6)
              ELSE NULL
            END AS same_close_rate,
            CASE
              WHEN COUNT(*) > 0
                THEN ROUND((COUNT(*) FILTER (
                  WHERE closing_odds IS NULL
                    OR ABS(COALESCE(clv, 0)) >= 0.25
                    OR (expected_value >= 0.40 AND COALESCE(clv, 0) <= 0)
                    OR (expected_value >= 0.40 AND closing_odds IS NOT NULL AND ABS(closing_odds - entry_odds) < 0.0001)
                )::numeric / COUNT(*)), 6)
              ELSE NULL
            END AS closing_issue_rate,
            COUNT(*) FILTER (
              WHERE closing_odds IS NULL
                OR ABS(COALESCE(clv, 0)) >= 0.25
                OR (expected_value >= 0.40 AND COALESCE(clv, 0) <= 0)
                OR (expected_value >= 0.40 AND closing_odds IS NOT NULL AND ABS(closing_odds - entry_odds) < 0.0001)
            )::int AS closing_issue_count,
            COUNT(*) FILTER (
              WHERE COALESCE(clv, 0) > 0
                AND closing_odds IS NOT NULL
                AND ABS(COALESCE(clv, 0)) < 0.25
            )::int AS closing_supported_count
          FROM samples
          GROUP BY rule_key, rule_name, predicate_label
        )
        SELECT
          *,
          ROUND((
            COALESCE(win_rate, 0) * 30
            + CASE WHEN profit_units > 0 THEN 25 ELSE 0 END
            + CASE WHEN COALESCE(avg_clv, 0) > 0 THEN 25 ELSE 0 END
            + COALESCE(clv_positive_rate, 0) * 10
            + GREATEST(0, 1 - COALESCE(closing_issue_rate, 1)) * 10
          )::numeric, 2) AS closing_edge_score,
          CASE
            WHEN closed < 20 THEN 'ACCUMULATING'
            WHEN profit_units <= 0 THEN 'PROFIT_REVIEW'
            WHEN COALESCE(avg_clv, 0) <= 0 THEN 'CLV_REVIEW'
            WHEN COALESCE(closing_issue_rate, 1) >= 0.35 THEN 'CLOSING_QUALITY_REVIEW'
            WHEN closed >= 50 AND profit_units > 0 AND COALESCE(avg_clv, 0) > 0 AND COALESCE(closing_issue_rate, 1) < 0.25 THEN 'PAPER_PRIORITY'
            WHEN closed >= 20 AND profit_units > 0 AND COALESCE(avg_clv, 0) > 0 THEN 'WATCH_CLOSING_SUPPORTED'
            ELSE 'REVIEW'
          END AS audit_status,
          CASE
            WHEN closed < 20 THEN 'Seguir acumulando; muestra chica.'
            WHEN profit_units <= 0 THEN 'No priorizar: profit no acompana.'
            WHEN COALESCE(avg_clv, 0) <= 0 THEN 'No priorizar: CLV no apoya el edge.'
            WHEN COALESCE(closing_issue_rate, 1) >= 0.35 THEN 'Mejorar closing/captura antes de promover esta regla.'
            WHEN closed >= 50 AND profit_units > 0 AND COALESCE(avg_clv, 0) > 0 AND COALESCE(closing_issue_rate, 1) < 0.25 THEN 'Prioridad paper: profit y CLV positivos con closing relativamente limpio. No autoriza dinero real.'
            WHEN closed >= 20 AND profit_units > 0 AND COALESCE(avg_clv, 0) > 0 THEN 'Watch: edge apoyado por closing, seguir midiendo.'
            ELSE 'Mantener en review.'
          END AS recommendation
        FROM grouped
        ORDER BY
          CASE
            WHEN closed >= 50 AND profit_units > 0 AND COALESCE(avg_clv, 0) > 0 AND COALESCE(closing_issue_rate, 1) < 0.25 THEN 0
            WHEN closed >= 20 AND profit_units > 0 AND COALESCE(avg_clv, 0) > 0 THEN 1
            ELSE 2
          END,
          closing_edge_score DESC,
          closed DESC
      `
    );

    const priorityRows = rows.rows.filter((row: Record<string, any>) => ["PAPER_PRIORITY", "WATCH_CLOSING_SUPPORTED"].includes(String(row.audit_status)));
    return {
      count: rows.rows.length,
      priority_count: priorityRows.length,
      rows: rows.rows,
      top_rule: priorityRows[0] || null,
      recommendation: priorityRows.length
        ? "Priorizar reglas con profit + CLV positivo y baja tasa de problemas de closing. Sigue Real Paper only."
        : "Aun no hay regla con suficiente apoyo de closing; seguir acumulando y mejorar captura ClosingOnly.",
      guardrails: {
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        kill_switch_enabled: true
      }
    };
  }

  async function buildMatchupConfirmation() {
    const [decisions, underdogPlus, intelligenceScout] = await Promise.all([
      buildPickDecisionRows(),
      buildUnderdogPlusV2(),
      buildIntelligenceScout()
    ]);
    const underdogStatusById = new Map<string, string>();
    for (const row of underdogPlus.candidates || []) {
      if (row.id) underdogStatusById.set(String(row.id), String(row.underdog_plus_status || "-"));
    }
    const scoutSignalsByMatch = new Map<string, Array<Record<string, any>>>();
    for (const signal of intelligenceScout.rows || []) {
      if (!signal.match_id) continue;
      const matchId = String(signal.match_id);
      scoutSignalsByMatch.set(matchId, [...(scoutSignalsByMatch.get(matchId) || []), signal]);
    }

    const rows = (decisions.rows || [])
      .filter((row: Record<string, any>) => row.sport_slug === "baseball" && row.league_slug === "mlb" && row.market_type === "moneyline_2way")
      .map((row: Record<string, any>) => {
        const underdog_plus_status = underdogStatusById.get(String(row.id)) || "-";
        const matchup = confirmMatchup({ ...row, underdog_plus_status });
        const highEvAudit = auditHighEvDuplicate(row);
        const scoutSignals = scoutSignalsByMatch.get(String(row.match_id)) || [];
        const scoutBlocks = scoutSignals.filter((signal) => signal.impact === "BLOCKS_CONFIRMATION");
        const scoutConflicts = scoutSignals.filter((signal) => signal.impact === "CONFLICTS_PICK");
        const scoutSupports = scoutSignals.filter((signal) => signal.impact === "SUPPORTS_PICK" || signal.impact === "WEAK_SUPPORT");
        const scoutAllowsConfirmation = scoutBlocks.length === 0 && scoutConflicts.length === 0;
        const finalOperationalStatus = matchup.final_operational_status === "BETTABLE_PAPER_CONFIRMED" && (!highEvAudit.allow_bettable_paper_confirmed || !scoutAllowsConfirmation)
          ? "VALUE_ONLY_REVIEW"
          : matchup.final_operational_status;
        return {
          ...row,
          underdog_plus_status,
          ...matchup,
          ...highEvAudit,
          intelligence_scout_support_count: scoutSupports.length,
          intelligence_scout_conflict_count: scoutConflicts.length,
          intelligence_scout_block_count: scoutBlocks.length,
          intelligence_scout_top_signals: scoutSignals.slice(0, 5).map((signal) => signal.signal_type),
          final_operational_status: finalOperationalStatus,
          recommendation: finalOperationalStatus !== matchup.final_operational_status
            ? `${matchup.recommendation} ${!highEvAudit.allow_bettable_paper_confirmed ? "High EV Audit no esta limpio." : ""} ${!scoutAllowsConfirmation ? "Intelligence Scout bloqueo confirmacion." : ""} Mantener en review.`
            : matchup.recommendation,
          confirmation_reasons: [...(matchup.confirmation_reasons || []), ...scoutSupports.map((signal) => `scout_${signal.signal_type}`)],
          conflict_reasons: [...(matchup.conflict_reasons || []), ...scoutConflicts.map((signal) => `scout_${signal.signal_type}`), ...scoutBlocks.map((signal) => `scout_${signal.signal_type}`)],
          pick_decision: row.decision,
          edge_grade: row.grade,
          edge_score: row.score,
          real_candidate_enabled: false,
          real_money_enabled: false,
          kelly_enabled: false,
          telegram_auto_enabled: false
        };
      });

    const counts = rows.reduce<Record<string, number>>((acc, row: Record<string, any>) => {
      const status = String(row.matchup_status || "UNKNOWN");
      acc[status] = (acc[status] || 0) + 1;
      const finalStatus = String(row.final_operational_status || "UNKNOWN");
      acc[finalStatus] = (acc[finalStatus] || 0) + 1;
      return acc;
    }, {});

    const reasonCounts = new Map<string, number>();
    for (const row of rows) {
      for (const reason of row.conflict_reasons || []) reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
      for (const reason of row.confirmation_reasons || []) reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
    const rankedReasons = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]);

    return {
      count: rows.length,
      counts,
      matchup_confirmed_count: counts.MATCHUP_CONFIRMED || 0,
      value_only_count: counts.VALUE_ONLY || 0,
      model_conflict_count: counts.MODEL_CONFLICT || 0,
      insufficient_context_count: counts.INSUFFICIENT_CONTEXT || 0,
      bettable_paper_confirmed_count: counts.BETTABLE_PAPER_CONFIRMED || 0,
      principal_reason: rankedReasons[0]?.[0] || "no_active_matchup_reasons",
      rows,
      guardrails: {
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        kill_switch_enabled: true
      }
    };
  }

  async function buildConfirmedPickChain() {
    const normalizeLineupKey = (value: unknown) => String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

    async function buildMlbLineupBaselineLookup() {
      const byTeam = new Map<string, Record<string, any>>();
      const officialByMatchTeam = new Map<string, Record<string, any>>();
      const availabilityByTeam = new Map<string, Record<string, any>>();
      try {
        const [expected, official, availability] = await Promise.all([
          db.query(`
            SELECT
              normalized_team_name,
              MAX(team_name) AS team_name,
              COUNT(*)::int AS expected_players,
              COUNT(*) FILTER (WHERE expected_starting)::int AS expected_starters,
              AVG(confidence_score)::numeric AS avg_confidence,
              MAX(observed_at) AS observed_at,
              MAX(source) AS source
            FROM sports_expected_lineups
            WHERE sport = 'baseball'
              AND (league_id = 'mlb' OR league_id = '')
            GROUP BY normalized_team_name
          `),
          db.query(`
            SELECT DISTINCT ON (match_id, normalized_team_name)
              match_id,
              normalized_team_name,
              team_name,
              lineup_status,
              starters,
              batting_order,
              observed_at,
              source,
              source_confidence_score
            FROM sports_match_lineups
            WHERE sport = 'baseball'
            ORDER BY match_id, normalized_team_name, observed_at DESC
          `),
          db.query(`
            SELECT
              normalized_team_name,
              COUNT(*) FILTER (
                WHERE key_player_flag
                  AND UPPER(COALESCE(availability_status, status, 'UNKNOWN')) NOT IN ('AVAILABLE', 'STARTING', 'CONFIRMED', 'HEALTHY')
              )::int AS key_player_alerts,
              ARRAY_AGG(player_name || ':' || COALESCE(availability_status, status, 'UNKNOWN')) FILTER (
                WHERE key_player_flag
                  AND UPPER(COALESCE(availability_status, status, 'UNKNOWN')) NOT IN ('AVAILABLE', 'STARTING', 'CONFIRMED', 'HEALTHY')
              ) AS key_player_alert_names,
              MAX(observed_at) AS observed_at
            FROM sports_player_availability
            WHERE sport = 'baseball'
              AND observed_at >= NOW() - INTERVAL '72 hours'
            GROUP BY normalized_team_name
          `)
        ]);
        for (const row of expected.rows) byTeam.set(normalizeLineupKey(row.normalized_team_name || row.team_name), row);
        for (const row of official.rows) officialByMatchTeam.set(`${row.match_id}|${normalizeLineupKey(row.normalized_team_name || row.team_name)}`, row);
        for (const row of availability.rows) availabilityByTeam.set(normalizeLineupKey(row.normalized_team_name), row);
      } catch {
        return { byTeam, officialByMatchTeam, availabilityByTeam, available: false };
      }
      return { byTeam, officialByMatchTeam, availabilityByTeam, available: true };
    }

    function lineupBaselineFor(row: Record<string, any>, lookup: Awaited<ReturnType<typeof buildMlbLineupBaselineLookup>>) {
      const matchId = String(row.match_id || "");
      const teams = [row.home_team_name, row.away_team_name].map(normalizeLineupKey).filter(Boolean);
      const officialRows = teams.map((team) => lookup.officialByMatchTeam.get(`${matchId}|${team}`)).filter(Boolean);
      const expectedRows = teams.map((team) => lookup.byTeam.get(team)).filter(Boolean);
      const availabilityRows = teams.map((team) => lookup.availabilityByTeam.get(team)).filter(Boolean);
      const keyAlerts = availabilityRows.reduce((sum, item) => sum + Number(item?.key_player_alerts || 0), 0);
      const keyAlertNames = availabilityRows.flatMap((item) => Array.isArray(item?.key_player_alert_names) ? item.key_player_alert_names : []);
      const confirmedCount = officialRows.filter((item) => String(item?.lineup_status || "").toUpperCase() === "CONFIRMED").length;
      const avgConfidence = expectedRows.length
        ? expectedRows.reduce((sum, item) => sum + Number(item?.avg_confidence || 0), 0) / expectedRows.length
        : 0;
      const expectedStarterCount = expectedRows.reduce((sum, item) => sum + Number(item?.expected_starters || 0), 0);
      let status = "NO_BASELINE";
      let score = 0;
      const reasons: string[] = [];

      if (!lookup.available) reasons.push("lineup_baseline_lookup_unavailable");
      if (confirmedCount >= 2) {
        status = "LINEUP_CONFIRMED_BOTH";
        score = 20;
        reasons.push("official_lineups_confirmed_both");
      } else if (confirmedCount === 1) {
        status = "LINEUP_CONFIRMED_PARTIAL";
        score = 15;
        reasons.push("one_official_lineup_confirmed");
      } else if (expectedRows.length >= 2 && expectedStarterCount >= 8 && avgConfidence >= 75 && keyAlerts === 0) {
        status = "PROJECTED_BASELINE_STABLE";
        score = avgConfidence >= 85 ? 16 : 15;
        reasons.push("historical_baseline_stable");
        reasons.push("no_key_player_alerts_72h");
      } else if (expectedRows.length > 0 && keyAlerts > 0) {
        status = "UNSTABLE_CHANGES_DETECTED";
        score = 5;
        reasons.push("key_player_alert_against_baseline");
      } else if (expectedRows.length > 0) {
        status = "PROJECTED_BASELINE_LOW_CONFIDENCE";
        score = 10;
        reasons.push("historical_baseline_low_confidence");
      } else {
        reasons.push("missing_expected_lineup_baseline");
      }

      return {
        lineup_baseline_status: status,
        lineup_baseline_score: score,
        lineup_baseline_avg_confidence: Math.round(avgConfidence * 1000) / 1000,
        lineup_baseline_expected_teams: expectedRows.length,
        lineup_baseline_key_player_alerts: keyAlerts,
        lineup_baseline_key_player_alert_names: keyAlertNames,
        lineup_baseline_reasons: reasons
      };
    }

    function buildContextCompleteness(row: Record<string, any>, input: {
      missing_context_fields: string[];
      freshness_status: string;
      suspicious_move_status: string;
      intelligence_status: string;
      player_intelligence_status: string;
      final_chain_status: string;
      high_ev_status: string;
      block_confirmation_reasons: string[];
      lineup_baseline_status?: string;
      lineup_baseline_score?: number;
      lineup_baseline_reasons?: string[];
    }) {
      const missing = input.missing_context_fields.map((field) => field.toLowerCase());
      const blocks = input.block_confirmation_reasons.map((reason) => reason.toLowerCase());
      const conflictText = [
        ...(Array.isArray(row.conflict_reasons) ? row.conflict_reasons : []),
        ...(Array.isArray(row.warnings) ? row.warnings : []),
        ...missing,
        ...blocks
      ].map((item) => String(item).toLowerCase());
      const has = (needle: string) => conflictText.some((item) => item.includes(needle));
      const isBlocked = input.final_chain_status.startsWith("BLOCKED") || input.final_chain_status === "REJECT";

      const pitcherValue = has("pitcher") && (has("missing") || has("changed") || has("scratch"))
        ? 0
        : has("pitcher")
          ? 8
          : 15;
      const pitcherState = pitcherValue === 15 ? "CONFIRMED_OR_LOADED" : pitcherValue > 0 ? "PARTIAL_REVIEW" : "MISSING_OR_CHANGED";

      const lineupHasHardAlert = has("scratch") || has("injury") || has("out") || has("lineup ops favors opponent");
      const baselineStatus = String(input.lineup_baseline_status || "NO_BASELINE");
      const baselineScore = Number(input.lineup_baseline_score || 0);
      const lineupValue = has("lineup")
        ? lineupHasHardAlert || input.player_intelligence_status === "BLOCK_CONFIRMATION" || baselineStatus === "UNSTABLE_CHANGES_DETECTED"
          ? 5
          : Math.max(12, Math.min(20, baselineScore))
        : 20;
      const lineupState = !has("lineup")
        ? "CONFIRMED_OR_COMPLETE"
        : baselineStatus === "LINEUP_CONFIRMED_BOTH"
          ? "LINEUP_CONFIRMED_BOTH"
          : baselineStatus === "LINEUP_CONFIRMED_PARTIAL"
            ? "LINEUP_CONFIRMED_PARTIAL"
            : baselineStatus === "PROJECTED_BASELINE_STABLE"
              ? "PROJECTED_BASELINE_REVIEW"
              : baselineStatus === "UNSTABLE_CHANGES_DETECTED"
                ? "UNSTABLE_CHANGES_DETECTED"
        : lineupValue >= 12
          ? "PROJECTED_BASELINE_REVIEW"
          : "UNSTABLE_CHANGES_DETECTED";

      const bullpenValue = has("bullpen")
        ? has("fatigue") || has("favors opponent")
          ? 5
          : 8
        : 15;
      const bullpenState = bullpenValue === 15 ? "LOADED_72H" : bullpenValue >= 8 ? "PARTIAL_72H" : "FATIGUE_REVIEW";

      const recentFormValue = has("recent_form") ? 0 : 15;
      const weatherValue = has("weather") ? 0 : 6;
      const weatherState = weatherValue === 0 ? "MISSING_WEATHER" : "NOT_LOADED_NEUTRAL_REVIEW";
      const travelRestValue = has("rest") || has("travel") ? 5 : 15;
      const marketLineValue = input.freshness_status === "FRESH_LINE" && input.suspicious_move_status === "NO_SUSPICIOUS_MOVE"
        ? 10
        : input.freshness_status === "AGING_LINE"
          ? 5
          : 0;

      const contextLayers = {
        pitcher_status: { weight: 15, value: pitcherValue, state: pitcherState },
        lineup_status: { weight: 20, value: lineupValue, state: lineupState },
        bullpen_availability: { weight: 15, value: bullpenValue, state: bullpenState },
        recent_form: { weight: 15, value: recentFormValue, state: recentFormValue === 15 ? "COMPUTED_OR_AVAILABLE" : "MISSING_RECENT_FORM" },
        weather_conditions: { weight: 10, value: weatherValue, state: weatherState },
        travel_rest: { weight: 15, value: travelRestValue, state: travelRestValue === 15 ? "NO_REST_DISADVANTAGE" : "REST_TRAVEL_REVIEW" },
        market_line_movement: { weight: 10, value: marketLineValue, state: marketLineValue === 10 ? "FRESH_STABLE" : "LINE_REVIEW" }
      };
      const contextCompletenessScore = Object.values(contextLayers).reduce((total, layer) => total + layer.value, 0);
      const tierClassification = contextCompletenessScore <= 40
        ? "DEBIL"
        : contextCompletenessScore <= 60
          ? "INCOMPLETO"
          : contextCompletenessScore <= 80
            ? "REVISABLE"
            : "FUERTE";
      const actionableStatus = contextCompletenessScore > 80 && !isBlocked && input.high_ev_status === "EV_CLEAN"
        ? "CONTEXT_READY_FOR_CONFIRMATION_REVIEW"
        : contextCompletenessScore > 80
          ? "STRONG_CONTEXT_BUT_CHAIN_BLOCKED"
          : contextCompletenessScore > 60
            ? "CONDITIONAL_PAPER_REVIEW"
            : "BLOCKED_LOW_CONTEXT";
      const whyContextNotConfirmed = [
        contextCompletenessScore <= 80 ? `context_score_${contextCompletenessScore}_below_81` : null,
        input.high_ev_status !== "EV_CLEAN" ? "high_ev_or_clv_audit_not_clean" : null,
        has("lineup") ? `lineup_${lineupState.toLowerCase()}` : null,
        ...(input.lineup_baseline_reasons || []).map((reason) => `baseline_${reason}`),
        has("bullpen") ? `bullpen_${bullpenState.toLowerCase()}` : null,
        has("recent_form") ? "recent_form_missing" : null,
        isBlocked ? `chain_${input.final_chain_status.toLowerCase()}` : null
      ].filter(Boolean);

      return {
        context_layers: contextLayers,
        context_completeness_score: contextCompletenessScore,
        tier_classification: tierClassification,
        context_actionable_status: actionableStatus,
        lineup_projection_state: lineupState,
        why_context_not_confirmed: [...new Set(whyContextNotConfirmed)]
      };
    }

    const [matchup, lineupBaselineLookup] = await Promise.all([
      buildMatchupConfirmation(),
      buildMlbLineupBaselineLookup()
    ]);
    const rows = (matchup.rows || []).map((row: Record<string, any>) => {
      const lineupBaseline = lineupBaselineFor(row, lineupBaselineLookup);
      const flags = Array.isArray(row.flags) ? row.flags.map((flag: unknown) => String(flag)) : [];
      const conflictReasons = Array.isArray(row.conflict_reasons) ? row.conflict_reasons.map((reason: unknown) => String(reason)) : [];
      const warnings = Array.isArray(row.warnings) ? row.warnings.map((warning: unknown) => String(warning)) : [];
      const lineAgeSeconds = Number(row.line_age_seconds || 0);
      const qualityScore = Number(row.quality_score ?? row.provider_score ?? 100);
      const openExposure = Number(row.open_exposure_count || 0);
      const intelligenceBlocks = Number(row.intelligence_scout_block_count || 0);
      const intelligenceConflicts = Number(row.intelligence_scout_conflict_count || 0);
      const highEvStatus = String(row.high_ev_audit_status || "EV_CLEAN");
      const highEvBlocked = row.allow_bettable_paper_confirmed === false && highEvStatus !== "EV_CLEAN";
      const staleBlocked = row.is_stale === true || lineAgeSeconds > 24 * 60 * 60 || flags.includes("stale_line") || conflictReasons.includes("stale_line");
      const duplicateBlocked = openExposure > 0 || flags.includes("duplicate_secondary_exposure") || conflictReasons.includes("duplicate_exposure");
      const providerBlocked = qualityScore < 80 || flags.includes("provider_score_below_80") || conflictReasons.includes("provider_score_below_80");
      const suspiciousMoveBlocked = row.suspicious_move === true || flags.includes("suspicious_move") || conflictReasons.includes("suspicious_move");
      const intelligenceBlocked = intelligenceBlocks > 0 || conflictReasons.some((reason) => reason.startsWith("scout_PROBABLE_PITCHER_MISSING") || reason.startsWith("scout_PITCHER_CHANGED"));
      const missingContextFields = [
        ...warnings
          .filter((warning) => warning.startsWith("missing_") || warning.includes("partial"))
          .map((warning) => warning.replace(/^missing_/, "")),
        ...conflictReasons
          .filter((reason) => reason.startsWith("scout_"))
          .map((reason) => reason.replace(/^scout_/, "").toLowerCase())
      ];
      const uniqueMissingContextFields = [...new Set(missingContextFields)];
      const freshnessStatus = staleBlocked
        ? "STALE_OR_OLD_LINE"
        : lineAgeSeconds > 6 * 60 * 60
          ? "AGING_LINE"
          : "FRESH_LINE";
      const duplicateStatus = duplicateBlocked ? "DUPLICATE_EXPOSURE" : "NO_DUPLICATE_EXPOSURE";
      const suspiciousMoveStatus = suspiciousMoveBlocked ? "SUSPICIOUS_MOVE" : "NO_SUSPICIOUS_MOVE";
      const intelligenceStatus = intelligenceBlocked
        ? "BLOCK_CONFIRMATION"
        : intelligenceConflicts > 0
          ? "MATCHUP_CONTEXT_CONFLICTS"
          : uniqueMissingContextFields.length > 0
            ? "PARTIAL_CONTEXT_REVIEW"
            : Number(row.intelligence_scout_support_count || 0) > 0
              ? "MATCHUP_CONTEXT_SUPPORTS"
              : "NO_CONTEXT";
      const playerIntelligenceStatus = intelligenceBlocked
        ? "BLOCK_CONFIRMATION"
        : uniqueMissingContextFields.some((field) => field.includes("lineup"))
          ? "PARTIAL_CONTEXT_REVIEW"
          : intelligenceConflicts > 0
            ? "MANUAL_REVIEW"
            : Number(row.intelligence_scout_support_count || 0) > 0
              ? "SUPPORTS_PICK"
              : "NEUTRAL";

      let finalChainStatus = "VALUE_ONLY_REVIEW";
      if (row.final_operational_status === "BETTABLE_PAPER_CONFIRMED" && !staleBlocked && !duplicateBlocked && !providerBlocked && !suspiciousMoveBlocked && !intelligenceBlocked && !highEvBlocked) {
        finalChainStatus = "CONFIRMED_PAPER";
      } else if (staleBlocked) {
        finalChainStatus = "BLOCKED_BY_STALE";
      } else if (duplicateBlocked) {
        finalChainStatus = "BLOCKED_BY_DUPLICATE";
      } else if (providerBlocked || suspiciousMoveBlocked) {
        finalChainStatus = "REJECT";
      } else if (intelligenceBlocked) {
        finalChainStatus = "BLOCKED_BY_INTELLIGENCE";
      } else if (highEvBlocked) {
        finalChainStatus = "BLOCKED_BY_HIGH_EV";
      } else if (row.final_operational_status === "MODEL_CONFLICT_REVIEW" || row.matchup_status === "MODEL_CONFLICT") {
        finalChainStatus = "MODEL_CONFLICT_REVIEW";
      } else if (row.pick_decision === "REJECT" || row.decision === "REJECT") {
        finalChainStatus = "REJECT";
      }

      const recommendation =
        finalChainStatus === "CONFIRMED_PAPER"
          ? "Cadena completa en paper: revisar manualmente, no dinero real."
          : finalChainStatus === "BLOCKED_BY_STALE"
            ? "Refrescar línea antes de evaluar; no confirmar con stale."
            : finalChainStatus === "BLOCKED_BY_DUPLICATE"
              ? "Resolver exposición duplicada por match antes de confirmar."
              : finalChainStatus === "BLOCKED_BY_INTELLIGENCE"
                ? "Completar pitcher/lineup/contexto bloqueante antes de confirmar."
                : finalChainStatus === "BLOCKED_BY_HIGH_EV"
                  ? "Auditar EV extremo, timestamp, provider y closing antes de confirmar."
                  : finalChainStatus === "REJECT" && providerBlocked
                    ? "Provider por debajo de score mínimo; revisar scorecard/consenso."
                    : finalChainStatus === "REJECT" && suspiciousMoveBlocked
                      ? "Movimiento sospechoso; revisar Line Movement Radar."
                      : finalChainStatus === "MODEL_CONFLICT_REVIEW"
                        ? "Modelo y contexto no están alineados; mantener en review."
                      : "Value matemático sin cadena completa; mantener Real Paper/review.";
      const contextCompleteness = buildContextCompleteness(row, {
        missing_context_fields: uniqueMissingContextFields,
        freshness_status: freshnessStatus,
        suspicious_move_status: suspiciousMoveStatus,
        intelligence_status: intelligenceStatus,
        player_intelligence_status: playerIntelligenceStatus,
        final_chain_status: finalChainStatus,
        high_ev_status: highEvStatus,
        lineup_baseline_status: lineupBaseline.lineup_baseline_status,
        lineup_baseline_score: lineupBaseline.lineup_baseline_score,
        lineup_baseline_reasons: lineupBaseline.lineup_baseline_reasons,
        block_confirmation_reasons: [
          staleBlocked ? "stale_line" : null,
          duplicateBlocked ? "duplicate_exposure" : null,
          providerBlocked ? "provider_score_below_80" : null,
          suspiciousMoveBlocked ? "suspicious_move" : null,
          intelligenceBlocked ? "intelligence_blocks_confirmation" : null,
          highEvBlocked ? "high_ev_audit_not_clean" : null
        ].filter(Boolean) as string[]
      });

      return {
        id: row.id,
        match_id: row.match_id,
        match: row.match || `${row.home_team_name || "-"} vs ${row.away_team_name || "-"}`,
        pick: row.pick,
        odds: row.entry_odds,
        entry_odds: row.entry_odds,
        model_probability: row.model_probability,
        expected_value: row.expected_value,
        provider: row.provider_name || row.bookmaker || "-",
        provider_score: qualityScore,
        freshness_status: freshnessStatus,
        duplicate_status: duplicateStatus,
        suspicious_move_status: suspiciousMoveStatus,
        high_ev_status: highEvStatus,
        matchup_status: row.matchup_status || "-",
        intelligence_status: intelligenceStatus,
        player_intelligence_status: playerIntelligenceStatus,
        ...lineupBaseline,
        missing_context_fields: uniqueMissingContextFields,
        block_confirmation_reasons: [
          staleBlocked ? "stale_line" : null,
          duplicateBlocked ? "duplicate_exposure" : null,
          providerBlocked ? "provider_score_below_80" : null,
          suspiciousMoveBlocked ? "suspicious_move" : null,
          intelligenceBlocked ? "intelligence_blocks_confirmation" : null,
          highEvBlocked ? "high_ev_audit_not_clean" : null
        ].filter(Boolean),
        final_chain_status: finalChainStatus,
        pick_decision: row.pick_decision || row.decision || "-",
        underdog_plus_status: row.underdog_plus_status || "-",
        final_operational_status: row.final_operational_status || "-",
        ...contextCompleteness,
        recommendation,
        real_paper_only: true
      };
    });

    const countBy = (status: string) => rows.filter((row) => row.final_chain_status === status).length;
    const contextTierCounts = rows.reduce((acc: Record<string, number>, row) => {
      const tier = String(row.tier_classification || "UNKNOWN");
      acc[tier] = (acc[tier] || 0) + 1;
      return acc;
    }, {});
    const blockedByProvider = rows.filter((row) => Number(row.provider_score || 0) < 80).length;
    const eligibleRows = rows.filter((row) =>
      row.final_chain_status === "CONFIRMED_PAPER"
      || (
        row.final_chain_status === "VALUE_ONLY_REVIEW"
        && row.freshness_status === "FRESH_LINE"
        && row.duplicate_status === "NO_DUPLICATE_EXPOSURE"
        && row.suspicious_move_status === "NO_SUSPICIOUS_MOVE"
        && !row.block_confirmation_reasons.length
      )
    );

    return {
      system_status: "CONFIRMED_PICK_CHAIN_READ_ONLY",
      active_picks: rows.length,
      eligible_for_confirmation: eligibleRows.length,
      blocked_by_intelligence: countBy("BLOCKED_BY_INTELLIGENCE"),
      blocked_by_high_ev: countBy("BLOCKED_BY_HIGH_EV"),
      blocked_by_stale: countBy("BLOCKED_BY_STALE"),
      blocked_by_duplicate: countBy("BLOCKED_BY_DUPLICATE"),
      blocked_by_provider: blockedByProvider,
      bettable_paper_confirmed: countBy("CONFIRMED_PAPER"),
      context_completeness_summary: {
        strong: contextTierCounts.FUERTE || 0,
        reviewable: contextTierCounts.REVISABLE || 0,
        incomplete: contextTierCounts.INCOMPLETO || 0,
        weak: contextTierCounts.DEBIL || 0
      },
      rows,
      recommendation: countBy("CONFIRMED_PAPER") > 0
        ? "Hay candidato confirmado en paper. Sigue bloqueado para dinero real; requiere revisión manual."
        : "No hay candidato con cadena completa; seguir hidratando contexto, líneas frescas y closing.",
      guardrails: {
        real_candidate_enabled: false,
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        kill_switch_enabled: true
      }
    };
  }

  async function buildTeamIntelligence() {
    const rows = await db.query(
      `
        WITH active AS (
          SELECT
            rps.*,
            m.match_date,
            m.status AS match_status,
            home_team.id AS home_team_id,
            home_team.name AS home_team_name,
            away_team.id AS away_team_id,
            away_team.name AS away_team_name,
            CASE WHEN rps.pick = 'home' THEN home_team.id ELSE away_team.id END AS picked_team_id,
            CASE WHEN rps.pick = 'home' THEN home_team.name ELSE away_team.name END AS picked_team_name,
            CASE WHEN rps.pick = 'home' THEN away_team.id ELSE home_team.id END AS opponent_team_id,
            CASE WHEN rps.pick = 'home' THEN away_team.name ELSE home_team.name END AS opponent_team_name
          FROM real_paper_snapshots rps
          JOIN v_valid_matches m ON m.id = rps.match_id
          LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
          LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
          LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
          LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
          WHERE rps.sport_slug = 'baseball'
            AND rps.league_slug = 'mlb'
            AND rps.market_type = 'moneyline_2way'
            AND rps.status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
          ORDER BY rps.entry_timestamp DESC
          LIMIT 50
        ),
        latest_features AS (
          SELECT DISTINCT ON (mf.match_id, mf.model_name)
            mf.match_id,
            mf.model_name,
            mf.feature_set,
            mf.generated_at
          FROM model_features mf
          WHERE mf.sport_slug = 'baseball'
          ORDER BY mf.match_id, mf.model_name, mf.generated_at DESC
        )
        SELECT
          a.id,
          a.match_id,
          a.status AS snapshot_status,
          a.match_status,
          a.match_date,
          a.pick,
          a.entry_odds,
          a.model_probability,
          a.expected_value,
          a.clv,
          a.bookmaker,
          a.home_team_name,
          a.away_team_name,
          a.picked_team_name,
          a.opponent_team_name,
          CONCAT(a.home_team_name, ' vs ', a.away_team_name) AS match,
          COALESCE(features.feature_set, a.raw_data->'feature_set', '{}'::jsonb) AS feature_set,
          features.generated_at AS feature_generated_at,
          COALESCE(picked_form.games, 0)::int AS picked_recent_games,
          COALESCE(picked_form.wins, 0)::int AS picked_recent_wins,
          COALESCE(picked_form.losses, 0)::int AS picked_recent_losses,
          COALESCE(picked_form.avg_for, 0)::numeric AS picked_avg_for,
          COALESCE(picked_form.avg_against, 0)::numeric AS picked_avg_against,
          COALESCE(opponent_form.games, 0)::int AS opponent_recent_games,
          COALESCE(opponent_form.wins, 0)::int AS opponent_recent_wins,
          COALESCE(opponent_form.losses, 0)::int AS opponent_recent_losses,
          COALESCE(opponent_form.avg_for, 0)::numeric AS opponent_avg_for,
          COALESCE(opponent_form.avg_against, 0)::numeric AS opponent_avg_against,
          COALESCE(picked_rp.closed, 0)::int AS picked_real_paper_closed,
          COALESCE(picked_rp.wins, 0)::int AS picked_real_paper_wins,
          COALESCE(picked_rp.losses, 0)::int AS picked_real_paper_losses,
          COALESCE(picked_rp.profit_units, 0)::numeric AS picked_real_paper_profit,
          picked_rp.avg_clv AS picked_real_paper_clv,
          COALESCE(opponent_rp.closed, 0)::int AS opponent_real_paper_closed,
          COALESCE(opponent_rp.wins, 0)::int AS opponent_real_paper_wins,
          COALESCE(opponent_rp.losses, 0)::int AS opponent_real_paper_losses,
          COALESCE(opponent_rp.profit_units, 0)::numeric AS opponent_real_paper_profit,
          opponent_rp.avg_clv AS opponent_real_paper_clv,
          EXISTS (
            SELECT 1
            WHERE COALESCE(features.feature_set, a.raw_data->'feature_set', '{}'::jsonb) ?| ARRAY[
              'home_starter_era', 'away_starter_era', 'home_pitcher_era', 'away_pitcher_era',
              'home_whip', 'away_whip', 'probable_pitcher_home', 'probable_pitcher_away'
            ]
          ) AS has_pitcher_context,
          EXISTS (
            SELECT 1
            WHERE COALESCE(features.feature_set, a.raw_data->'feature_set', '{}'::jsonb) ?| ARRAY[
              'home_bullpen_era', 'away_bullpen_era', 'home_bullpen', 'away_bullpen',
              'home_bullpen_fatigue', 'away_bullpen_fatigue'
            ]
          ) AS has_bullpen_context,
          EXISTS (
            SELECT 1
            WHERE COALESCE(features.feature_set, a.raw_data->'feature_set', '{}'::jsonb) ?| ARRAY[
              'home_ops', 'away_ops', 'home_lineup_ops', 'away_lineup_ops',
              'home_lineup_confirmed', 'away_lineup_confirmed'
            ]
          ) AS has_lineup_context,
          EXISTS (
            SELECT 1
            WHERE COALESCE(features.feature_set, a.raw_data->'feature_set', '{}'::jsonb) ?| ARRAY[
              'home_rest_days', 'away_rest_days', 'home_travel_distance', 'away_travel_distance'
            ]
          ) AS has_travel_rest_context
        FROM active a
        LEFT JOIN latest_features features
          ON features.match_id = a.match_id
         AND features.model_name = a.model_name
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS games,
            COUNT(*) FILTER (WHERE mc.score > opp.score)::int AS wins,
            COUNT(*) FILTER (WHERE mc.score < opp.score)::int AS losses,
            ROUND(AVG(mc.score)::numeric, 3) AS avg_for,
            ROUND(AVG(opp.score)::numeric, 3) AS avg_against
          FROM (
            SELECT m.id, m.match_date
            FROM match_competitors mc
            JOIN v_valid_matches m ON m.id = mc.match_id
            WHERE mc.team_id = a.picked_team_id
              AND m.status = 'finished'
              AND m.match_date < a.match_date
            ORDER BY m.match_date DESC
            LIMIT 10
          ) recent
          JOIN v_valid_matches m ON m.id = recent.id
          JOIN match_competitors mc ON mc.match_id = m.id AND mc.team_id = a.picked_team_id
          JOIN match_competitors opp ON opp.match_id = m.id AND opp.team_id <> mc.team_id
          WHERE mc.score IS NOT NULL AND opp.score IS NOT NULL
        ) picked_form ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS games,
            COUNT(*) FILTER (WHERE mc.score > opp.score)::int AS wins,
            COUNT(*) FILTER (WHERE mc.score < opp.score)::int AS losses,
            ROUND(AVG(mc.score)::numeric, 3) AS avg_for,
            ROUND(AVG(opp.score)::numeric, 3) AS avg_against
          FROM (
            SELECT m.id, m.match_date
            FROM match_competitors mc
            JOIN v_valid_matches m ON m.id = mc.match_id
            WHERE mc.team_id = a.opponent_team_id
              AND m.status = 'finished'
              AND m.match_date < a.match_date
            ORDER BY m.match_date DESC
            LIMIT 10
          ) recent
          JOIN v_valid_matches m ON m.id = recent.id
          JOIN match_competitors mc ON mc.match_id = m.id AND mc.team_id = a.opponent_team_id
          JOIN match_competitors opp ON opp.match_id = m.id AND opp.team_id <> mc.team_id
          WHERE mc.score IS NOT NULL AND opp.score IS NOT NULL
        ) opponent_form ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS closed,
            COUNT(*) FILTER (WHERE r.status = 'WIN')::int AS wins,
            COUNT(*) FILTER (WHERE r.status = 'LOSS')::int AS losses,
            ROUND(COALESCE(SUM(r.profit_loss), 0)::numeric, 4) AS profit_units,
            ROUND(AVG(r.clv) FILTER (WHERE r.clv IS NOT NULL)::numeric, 6) AS avg_clv
          FROM real_paper_snapshots r
          JOIN v_valid_matches m ON m.id = r.match_id
          LEFT JOIN match_competitors hmc ON hmc.match_id = m.id AND hmc.home_away = 'home'
          LEFT JOIN match_competitors amc ON amc.match_id = m.id AND amc.home_away = 'away'
          WHERE r.sport_slug = 'baseball'
            AND r.league_slug = 'mlb'
            AND r.market_type = 'moneyline_2way'
            AND r.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
            AND (
              (r.pick = 'home' AND hmc.team_id = a.picked_team_id)
              OR (r.pick = 'away' AND amc.team_id = a.picked_team_id)
            )
        ) picked_rp ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS closed,
            COUNT(*) FILTER (WHERE r.status = 'WIN')::int AS wins,
            COUNT(*) FILTER (WHERE r.status = 'LOSS')::int AS losses,
            ROUND(COALESCE(SUM(r.profit_loss), 0)::numeric, 4) AS profit_units,
            ROUND(AVG(r.clv) FILTER (WHERE r.clv IS NOT NULL)::numeric, 6) AS avg_clv
          FROM real_paper_snapshots r
          JOIN v_valid_matches m ON m.id = r.match_id
          LEFT JOIN match_competitors hmc ON hmc.match_id = m.id AND hmc.home_away = 'home'
          LEFT JOIN match_competitors amc ON amc.match_id = m.id AND amc.home_away = 'away'
          WHERE r.sport_slug = 'baseball'
            AND r.league_slug = 'mlb'
            AND r.market_type = 'moneyline_2way'
            AND r.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
            AND (
              (r.pick = 'home' AND hmc.team_id = a.opponent_team_id)
              OR (r.pick = 'away' AND amc.team_id = a.opponent_team_id)
            )
        ) opponent_rp ON true
        ORDER BY a.expected_value DESC NULLS LAST, a.match_date ASC
      `
    );

    const normalizedRows = rows.rows.map((row: Record<string, any>) => {
      const featureSet = row.feature_set && typeof row.feature_set === "object" ? row.feature_set : {};
      const pickedGames = Number(row.picked_recent_games || 0);
      const opponentGames = Number(row.opponent_recent_games || 0);
      const pickedWinRate = pickedGames > 0 ? Number(row.picked_recent_wins || 0) / pickedGames : null;
      const opponentWinRate = opponentGames > 0 ? Number(row.opponent_recent_wins || 0) / opponentGames : null;
      const formEdge = pickedWinRate !== null && opponentWinRate !== null ? pickedWinRate - opponentWinRate : null;
      const pickedProfit = Number(row.picked_real_paper_profit || 0);
      const opponentProfit = Number(row.opponent_real_paper_profit || 0);
      const clv = row.picked_real_paper_clv === null || row.picked_real_paper_clv === undefined ? null : Number(row.picked_real_paper_clv);
      const completenessFlags = [
        row.has_pitcher_context,
        row.has_bullpen_context,
        row.has_lineup_context,
        row.has_travel_rest_context,
        pickedGames >= 3,
        Number(row.picked_real_paper_closed || 0) >= 3
      ];
      const contextCompletenessScore = Math.round((completenessFlags.filter(Boolean).length / completenessFlags.length) * 100);
      let matchupScore = 45;
      if (formEdge !== null) matchupScore += formEdge >= 0.2 ? 15 : formEdge >= 0 ? 7 : formEdge <= -0.2 ? -15 : -7;
      if (pickedProfit > 0) matchupScore += 10;
      if (opponentProfit > pickedProfit) matchupScore -= 8;
      if (clv !== null && clv > 0) matchupScore += 10;
      if (clv !== null && clv < 0) matchupScore -= 10;
      if (row.pick === "home") matchupScore += 4;
      if (!row.has_pitcher_context) matchupScore -= 8;
      if (!row.has_bullpen_context) matchupScore -= 5;
      if (!row.has_lineup_context) matchupScore -= 5;
      const teamMatchupScore = Math.max(0, Math.min(100, Math.round(matchupScore)));
      const missingContext = [
        !row.has_pitcher_context ? "pitcher" : null,
        !row.has_bullpen_context ? "bullpen" : null,
        !row.has_lineup_context ? "lineup" : null,
        !row.has_travel_rest_context ? "rest/travel" : null,
        pickedGames < 3 ? "recent_form" : null
      ].filter(Boolean);
      const intelligenceStatus = teamMatchupScore >= 75 && contextCompletenessScore >= 70
        ? "MATCHUP_CONTEXT_SUPPORTS"
        : teamMatchupScore >= 55
          ? "PARTIAL_CONTEXT_REVIEW"
          : missingContext.length >= 3
            ? "CONTEXT_GAPS"
            : "MATCHUP_CONTEXT_CONFLICT";
      return {
        ...row,
        feature_source: row.feature_generated_at ? "model_features" : featureSet.feature_source || "snapshot_or_missing",
        feature_context_summary: [
          row.has_pitcher_context ? "pitcher" : null,
          row.has_bullpen_context ? "bullpen" : null,
          row.has_lineup_context ? "lineup" : null,
          row.has_travel_rest_context ? "rest/travel" : null
        ].filter(Boolean),
        picked_recent_win_rate: pickedWinRate,
        opponent_recent_win_rate: opponentWinRate,
        form_edge: formEdge,
        context_completeness_score: contextCompletenessScore,
        team_matchup_score: teamMatchupScore,
        missing_context: missingContext,
        intelligence_status: intelligenceStatus,
        recommendation: intelligenceStatus === "MATCHUP_CONTEXT_SUPPORTS"
          ? "Contexto apoya el pick, pero sigue Real Paper only."
          : intelligenceStatus === "PARTIAL_CONTEXT_REVIEW"
            ? "Hay apoyo parcial; revisar faltantes antes de confiar."
            : intelligenceStatus === "CONTEXT_GAPS"
              ? "Falta contexto clave de equipos; mantener en review."
              : "Contexto no apoya suficiente; no promover."
      };
    });

    const counts = normalizedRows.reduce((acc: Record<string, number>, row: Record<string, any>) => {
      const status = String(row.intelligence_status || "UNKNOWN");
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});

    return {
      system_status: "TEAM_INTELLIGENCE_READ_ONLY",
      sport_scope: "MLB Moneyline",
      count: normalizedRows.length,
      counts,
      rows: normalizedRows,
      recommendation: "Usar Team Intelligence como filtro de contexto. No activa dinero real ni cambia picks.",
      next_expansion: "Extender a fútbol Liga MX/MLS/Mundial cuando haya muestra por liga/mercado.",
      football_team_intelligence: {
        mode: "READ_ONLY_ACCUMULATING",
        leagues: ["fifa-world-cup-2026", "liga-mx", "mls"],
        markets: ["moneyline_3way", "total_goals_2_5", "draw_no_bet"],
        min_closed_for_first_read: 20,
        min_closed_for_formal_review: 50,
        recommendation: "No usar Team Intelligence de fútbol para promover picks hasta tener muestra cerrada por liga y mercado."
      },
      guardrails: {
        read_only: true,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_candidate_enabled: false,
        real_paper_only: true
      }
    };
  }

  async function buildPlayerIntelligence() {
    const [persisted, derived] = await Promise.all([
      db.query(
        `
          SELECT
            pi.*,
            CONCAT(home_team.name, ' vs ', away_team.name) AS match,
            'persisted' AS row_source
          FROM player_intelligence pi
          LEFT JOIN v_valid_matches m ON m.id = pi.match_id
          LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
          LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
          LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
          LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
          ORDER BY pi.observed_at DESC
          LIMIT 100
        `
      ),
      db.query(
        `
          WITH latest_features AS (
            SELECT DISTINCT ON (mf.match_id)
              mf.match_id,
              mf.sport_slug,
              mf.model_name,
              mf.feature_set,
              mf.generated_at
            FROM model_features mf
            WHERE mf.generated_at >= NOW() - INTERVAL '30 days'
              AND mf.sport_slug IN ('baseball', 'soccer', 'football')
            ORDER BY mf.match_id, mf.generated_at DESC
          ),
          base AS (
            SELECT
              lf.*,
              m.match_date,
              l.slug AS league_slug,
              home_team.id AS home_team_id,
              home_team.name AS home_team_name,
              away_team.id AS away_team_id,
              away_team.name AS away_team_name,
              CONCAT(home_team.name, ' vs ', away_team.name) AS match
            FROM latest_features lf
            JOIN v_valid_matches m ON m.id = lf.match_id
            JOIN leagues l ON l.id = m.league_id
            LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
            LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
            LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
            LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
          ),
          derived_players AS (
            SELECT
              b.sport_slug,
              b.league_slug,
              b.match_id,
              b.match,
              b.home_team_id AS team_id,
              b.home_team_name AS team_name,
              NULLIF(b.feature_set->>'probable_pitcher_home', '') AS player_name,
              'P' AS position,
              'starter' AS role_importance,
              CASE WHEN NULLIF(b.feature_set->>'probable_pitcher_home', '') IS NULL THEN 'missing' ELSE 'probable' END AS status,
              CASE WHEN NULLIF(b.feature_set->>'probable_pitcher_home', '') IS NULL THEN -35 ELSE 22 END AS impact_score,
              'mlb_stats_api' AS source,
              b.generated_at AS observed_at,
              'derived' AS row_source
            FROM base b
            WHERE b.sport_slug = 'baseball'
            UNION ALL
            SELECT
              b.sport_slug,
              b.league_slug,
              b.match_id,
              b.match,
              b.away_team_id,
              b.away_team_name,
              NULLIF(b.feature_set->>'probable_pitcher_away', ''),
              'P',
              'starter',
              CASE WHEN NULLIF(b.feature_set->>'probable_pitcher_away', '') IS NULL THEN 'missing' ELSE 'probable' END,
              CASE WHEN NULLIF(b.feature_set->>'probable_pitcher_away', '') IS NULL THEN -35 ELSE 22 END,
              'mlb_stats_api',
              b.generated_at,
              'derived'
            FROM base b
            WHERE b.sport_slug = 'baseball'
            UNION ALL
            SELECT
              b.sport_slug,
              b.league_slug,
              b.match_id,
              b.match,
              b.home_team_id,
              b.home_team_name,
              CONCAT(b.home_team_name, ' lineup'),
              'lineup',
              'key_role',
              CASE WHEN LOWER(COALESCE(b.feature_set->>'home_lineup_confirmed', 'false')) IN ('true', '1', 'yes') THEN 'confirmed' ELSE 'missing' END,
              CASE WHEN LOWER(COALESCE(b.feature_set->>'home_lineup_confirmed', 'false')) IN ('true', '1', 'yes') THEN 8 ELSE -14 END,
              COALESCE(b.feature_set->>'source', 'model_features'),
              b.generated_at,
              'derived'
            FROM base b
            WHERE b.sport_slug = 'baseball'
            UNION ALL
            SELECT
              b.sport_slug,
              b.league_slug,
              b.match_id,
              b.match,
              b.away_team_id,
              b.away_team_name,
              CONCAT(b.away_team_name, ' lineup'),
              'lineup',
              'key_role',
              CASE WHEN LOWER(COALESCE(b.feature_set->>'away_lineup_confirmed', 'false')) IN ('true', '1', 'yes') THEN 'confirmed' ELSE 'missing' END,
              CASE WHEN LOWER(COALESCE(b.feature_set->>'away_lineup_confirmed', 'false')) IN ('true', '1', 'yes') THEN 8 ELSE -14 END,
              COALESCE(b.feature_set->>'source', 'model_features'),
              b.generated_at,
              'derived'
            FROM base b
            WHERE b.sport_slug = 'baseball'
            UNION ALL
            SELECT
              b.sport_slug,
              b.league_slug,
              b.match_id,
              b.match,
              b.home_team_id,
              b.home_team_name,
              CONCAT(b.home_team_name, ' bullpen'),
              'bullpen',
              'key_role',
              'available',
              CASE
                WHEN (b.feature_set->>'home_bullpen_era') ~ '^[0-9]+(\\.[0-9]+)?$' AND (b.feature_set->>'home_bullpen_era')::numeric <= 4.20 THEN 8
                WHEN (b.feature_set->>'home_bullpen_era') ~ '^[0-9]+(\\.[0-9]+)?$' AND (b.feature_set->>'home_bullpen_era')::numeric >= 4.80 THEN -8
                ELSE 0
              END,
              COALESCE(b.feature_set->>'source', 'model_features'),
              b.generated_at,
              'derived'
            FROM base b
            WHERE b.sport_slug = 'baseball'
            UNION ALL
            SELECT
              b.sport_slug,
              b.league_slug,
              b.match_id,
              b.match,
              b.away_team_id,
              b.away_team_name,
              CONCAT(b.away_team_name, ' bullpen'),
              'bullpen',
              'key_role',
              'available',
              CASE
                WHEN (b.feature_set->>'away_bullpen_era') ~ '^[0-9]+(\\.[0-9]+)?$' AND (b.feature_set->>'away_bullpen_era')::numeric <= 4.20 THEN 8
                WHEN (b.feature_set->>'away_bullpen_era') ~ '^[0-9]+(\\.[0-9]+)?$' AND (b.feature_set->>'away_bullpen_era')::numeric >= 4.80 THEN -8
                ELSE 0
              END,
              COALESCE(b.feature_set->>'source', 'model_features'),
              b.generated_at,
              'derived'
            FROM base b
            WHERE b.sport_slug = 'baseball'
          )
          SELECT *
          FROM derived_players
          ORDER BY observed_at DESC, impact_score ASC
          LIMIT 150
        `
      )
    ]);

    const rows = [...persisted.rows, ...derived.rows].map((row: Record<string, any>) => {
      const impact = Number(row.impact_score || 0);
      return {
        ...row,
        player_intelligence_status:
          impact <= -25
            ? "BLOCK_CONFIRMATION"
            : impact < 0
              ? "MANUAL_REVIEW"
              : impact >= 15
                ? "SUPPORTS_PICK"
                : "NEUTRAL",
        scout_recommendation:
          impact <= -25
            ? "Esperar confirmacion o corregir contexto antes de confiar."
            : impact < 0
              ? "Revisar manualmente: jugador/contexto resta valor."
              : impact >= 15
                ? "Contexto de jugador apoya el laboratorio paper."
                : "Observacion informativa; no cambia decision."
      };
    });

    const summary = rows.reduce<Record<string, number>>((acc, row: Record<string, any>) => {
      const status = String(row.player_intelligence_status || "UNKNOWN");
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});

    const teamImpact = rows.reduce<Record<string, { team_name: string; match: string; impact_score: number; blocks: number; supports: number }>>((acc, row: Record<string, any>) => {
      const key = `${row.match_id || "no_match"}:${row.team_name || "unknown"}`;
      const current = acc[key] || { team_name: row.team_name || "-", match: row.match || "-", impact_score: 0, blocks: 0, supports: 0 };
      current.impact_score += Number(row.impact_score || 0);
      if (row.player_intelligence_status === "BLOCK_CONFIRMATION") current.blocks += 1;
      if (row.player_intelligence_status === "SUPPORTS_PICK") current.supports += 1;
      acc[key] = current;
      return acc;
    }, {});

    return {
      system_status: "PLAYER_INTELLIGENCE_READ_ONLY",
      count: rows.length,
      summary,
      rows,
      team_player_impact: Object.values(teamImpact).sort((a, b) => a.impact_score - b.impact_score).slice(0, 25),
      recommendation: "Usar Player Intelligence para detectar pitchers, lineups y piezas clave que apoyan o bloquean confirmacion. No activa dinero real.",
      guardrails: {
        read_only: true,
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true
      }
    };
  }

  async function buildIntelligenceScout() {
    const [persisted, playerIntel] = await Promise.all([
      db.query(
        `
          SELECT
            io.*,
            CONCAT(home_team.name, ' vs ', away_team.name) AS match,
            'persisted' AS row_source
          FROM intelligence_observations io
          LEFT JOIN v_valid_matches m ON m.id = io.match_id
          LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
          LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
          LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
          LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
          ORDER BY io.observed_at DESC
          LIMIT 100
        `
      ),
      buildPlayerIntelligence()
    ]);

    const derivedRows = (playerIntel.rows || []).map((row: Record<string, any>) => {
      const position = String(row.position || "").toLowerCase();
      const status = String(row.status || "").toLowerCase();
      const impactScore = Number(row.impact_score || 0);
      let signalType = "PLAYER_CONTEXT_OBSERVED";
      let impact = "NEUTRAL";
      let recommendation = "OBSERVATION_ONLY";
      let severity = "info";
      let confidence = 0.65;

      if (position === "p" && ["missing", "out", "injured", "unknown"].includes(status)) {
        signalType = "PROBABLE_PITCHER_MISSING";
        impact = "BLOCKS_CONFIRMATION";
        recommendation = "WAIT_FOR_CONFIRMATION";
        severity = "high";
        confidence = 0.9;
      } else if (position === "p" && ["probable", "confirmed", "available"].includes(status)) {
        signalType = "PROBABLE_PITCHER_CONFIRMED";
        impact = "SUPPORTS_PICK";
        recommendation = "ALLOW_REVIEW";
        severity = "info";
        confidence = 0.82;
      } else if (position === "lineup" && ["missing", "unknown"].includes(status)) {
        signalType = "LINEUP_MISSING";
        impact = "CONFLICTS_PICK";
        recommendation = "MANUAL_REVIEW";
        severity = "medium";
        confidence = 0.78;
      } else if (position === "lineup" && ["confirmed", "available"].includes(status)) {
        signalType = "LINEUP_CONFIRMED";
        impact = "WEAK_SUPPORT";
        recommendation = "ALLOW_REVIEW";
        severity = "info";
        confidence = 0.72;
      } else if (position === "bullpen" && impactScore < 0) {
        signalType = "BULLPEN_FATIGUE";
        impact = "CONFLICTS_PICK";
        recommendation = "MANUAL_REVIEW";
        severity = "medium";
        confidence = 0.68;
      } else if (position === "bullpen" && impactScore > 0) {
        signalType = "TEAM_FORM_SUPPORTS";
        impact = "WEAK_SUPPORT";
        recommendation = "ALLOW_REVIEW";
        severity = "info";
        confidence = 0.62;
      } else if (["out", "suspended", "injured"].includes(status)) {
        signalType = row.sport_slug === "baseball" ? "KEY_PLAYER_OUT" : "KEY_PLAYER_OUT";
        impact = impactScore <= -20 ? "BLOCKS_CONFIRMATION" : "CONFLICTS_PICK";
        recommendation = "MANUAL_REVIEW";
        severity = impactScore <= -20 ? "high" : "medium";
        confidence = 0.75;
      }

      return {
        id: `derived:${row.match_id || "no-match"}:${row.team_name || "team"}:${row.player_name || position}:${signalType}`,
        sport_slug: row.sport_slug,
        league_slug: row.league_slug,
        match_id: row.match_id,
        team_id: row.team_id,
        team_name: row.team_name,
        player_name: row.player_name,
        source: row.source || "player_intelligence",
        source_url: row.source_url || null,
        signal_type: signalType,
        signal_value: {
          player_status: row.status,
          position: row.position,
          role_importance: row.role_importance,
          impact_score: impactScore,
          row_source: row.row_source
        },
        severity,
        confidence,
        impact,
        recommendation,
        observed_at: row.observed_at,
        match: row.match,
        row_source: "derived_player_layer"
      };
    });

    const rows = [...persisted.rows, ...derivedRows]
      .sort((a: Record<string, any>, b: Record<string, any>) => String(b.observed_at || "").localeCompare(String(a.observed_at || "")));

    const counts = rows.reduce<Record<string, number>>((acc, row: Record<string, any>) => {
      const impact = String(row.impact || "NEUTRAL");
      acc[impact] = (acc[impact] || 0) + 1;
      return acc;
    }, {});

    const signalCounts = rows.reduce<Record<string, number>>((acc, row: Record<string, any>) => {
      const signal = String(row.signal_type || "UNKNOWN");
      acc[signal] = (acc[signal] || 0) + 1;
      return acc;
    }, {});

    return {
      system_status: "INTELLIGENCE_SCOUT_READ_ONLY",
      count: rows.length,
      support_count: (counts.SUPPORTS_PICK || 0) + (counts.WEAK_SUPPORT || 0),
      conflict_count: counts.CONFLICTS_PICK || 0,
      block_count: counts.BLOCKS_CONFIRMATION || 0,
      manual_review_count: rows.filter((row: Record<string, any>) => row.recommendation === "MANUAL_REVIEW").length,
      signal_counts: signalCounts,
      top_signals: Object.entries(signalCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([signal_type, count]) => ({ signal_type, count })),
      rows,
      recommendation: (counts.BLOCKS_CONFIRMATION || 0) > 0
        ? "Hay señales que bloquean confirmacion; mantener picks en review hasta resolver contexto."
        : (counts.CONFLICTS_PICK || 0) > 0
          ? "Hay conflictos de inteligencia; usar revision manual antes de confiar."
          : "Intelligence Scout listo en modo lectura; usarlo como filtro de contexto Real Paper.",
      guardrails: {
        read_only: true,
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        kill_switch_enabled: true
      }
    };
  }

  function normalizeWhyNoBettableReason(reason: unknown) {
    const value = String(reason || "").trim().toLowerCase();
    if (!value) return "manual_review_required";
    if (value === "stale_line") return "stale_line";
    if (value.includes("provider_score")) return "provider_score_low";
    if (value.includes("provider_suspicious") || value.includes("suspicious_provider")) return "provider_suspicious";
    if (value.includes("processed_false")) return "processed_false";
    if (value === "market_blocked" || value.includes("market_blocked")) return "market_blocked";
    if (value.includes("market_accumulating") || value.includes("market_not") || value.includes("market_unknown")) return "market_not_ready";
    if (value.includes("duplicate_match_exposure") || value.includes("duplicate_exposure")) return "duplicate_exposure";
    if (value.includes("suspicious_move")) return "suspicious_move";
    if (value.includes("invalid_model_probability") || value.includes("missing_model_prob")) return "missing_model_prob";
    if (value.includes("model_prob_below")) return "model_prob_below_threshold";
    if (value.includes("odds_band_1_61_2_00_blocked") || value.includes("odds_below_2_01")) return "odds_below_promotable_band";
    if (value.includes("missing_ev")) return "missing_ev";
    if (value.includes("ev_not_positive") || value.includes("ev_below")) return "ev_below_threshold";
    if (value.includes("invalid_odds") || value.includes("odds_invalid")) return "odds_invalid";
    if (value.includes("line_age_too_old")) return "line_age_too_old";
    if (value.includes("recent_clv") || value.includes("recent_profit") || value.includes("clv_recent_negative")) return "clv_recent_negative";
    if (value.includes("risk_engine_block") || value.includes("risk_block")) return "risk_engine_block";
    if (value.includes("manual_review") || value.includes("variance_watch") || value.includes("kill_switch") || value.includes("not_underdog_price")) return "manual_review_required";
    if (value.includes("shadow_or_manual_provider")) return "market_not_ready";
    return value;
  }

  function whyNoBettableSeverity(reason: string) {
    if (["stale_line", "provider_suspicious", "duplicate_exposure", "suspicious_move", "risk_engine_block", "odds_invalid"].includes(reason)) return "HIGH";
    if (["provider_score_low", "line_age_too_old", "clv_recent_negative", "market_blocked", "processed_false"].includes(reason)) return "MEDIUM";
    return "LOW";
  }

  function whyNoBettableRecommendation(reason: string) {
    const map: Record<string, string> = {
      stale_line: "Correr settlement/cierre, archivar OPEN viejos e ingresar cuotas frescas.",
      provider_score_low: "Revisar provider scorecard antes de confiar en esta linea.",
      provider_suspicious: "Revisar provider scorecard y consenso.",
      processed_false: "Esperar dato processed=true antes de evaluar Real Paper.",
      market_blocked: "Mantener mercado bloqueado hasta nueva auditoria.",
      market_not_ready: "Mantener mercado en acumulacion hasta que Market Promotion lo apruebe.",
      duplicate_exposure: "Revisar exposicion por match.",
      suspicious_move: "Revisar Line Movement Radar y consenso de providers.",
      missing_model_prob: "Revisar pipeline/model quote: falta probabilidad del modelo.",
      model_prob_below_threshold: "No promover: la probabilidad del modelo no supera el umbral minimo.",
      missing_ev: "Revisar pipeline/model quote: falta EV calculado.",
      ev_below_threshold: "No tocar: el edge no supera el umbral operativo.",
      odds_invalid: "Descartar hasta corregir parseo de cuota.",
      odds_below_promotable_band: "No promover: el segmento fuerte actual es MLB Moneyline odds 2.01+.",
      line_age_too_old: "Refrescar snapshot de cuota antes de decidir.",
      clv_recent_negative: "Mantener en watch; el CLV reciente se esta enfriando.",
      risk_engine_block: "No usar salvo revision manual; Risk Engine bloqueo la senal.",
      manual_review_required: "Revisar manualmente antes de promover a Real Paper.",
      no_fresh_candidates: "Correr ingest fresco MLB Real Paper."
    };
    return map[reason] || "Revisar diagnostico antes de tocar el pick.";
  }

  async function buildWhyNoBettablePaper() {
    const [decisions, underdogPlus] = await Promise.all([buildPickDecisionRows(), buildUnderdogPlusV2()]);
    const reasonMap = new Map<string, {
      reason: string;
      count: number;
      severity: string;
      affected_market: string;
      example_match: string;
      recommendation: string;
    }>();

    const addReason = (rawReason: unknown, row: Record<string, any> = {}) => {
      const reason = normalizeWhyNoBettableReason(rawReason);
      if (!reason) return;
      const current = reasonMap.get(reason) || {
        reason,
        count: 0,
        severity: whyNoBettableSeverity(reason),
        affected_market: `${row.sport_slug || "-"}/${row.league_slug || "-"} ${row.market_type || "-"}`,
        example_match: row.match || `${row.home_team_name || "Home"} vs ${row.away_team_name || "Away"}`,
        recommendation: whyNoBettableRecommendation(reason)
      };
      current.count += 1;
      if (!current.example_match || current.example_match === "Home vs Away") {
        current.example_match = row.match || `${row.home_team_name || "Home"} vs ${row.away_team_name || "Away"}`;
      }
      reasonMap.set(reason, current);
    };

    for (const row of decisions.rows || []) {
      const isSecondaryExposure = Number(row.exposure_rank || 1) > 1;
      if (isSecondaryExposure) continue;
      if (row.decision !== "BETTABLE_PAPER") {
        for (const reason of row.reasons_blocked || []) addReason(reason, row);
        for (const warning of row.warnings || []) addReason(warning, row);
        if (row.is_stale === true && !(row.reasons_blocked || []).includes("stale_line")) addReason("stale_line", row);
        if (Number(row.line_age_seconds || 0) > 24 * 60 * 60 && !(row.reasons_blocked || []).includes("stale_line")) addReason("line_age_too_old", row);
        if (row.suspicious_move === true) addReason("suspicious_move", row);
        if (Number(row.open_exposure_count || 0) > 0) addReason("duplicate_exposure", row);
      }
    }

    for (const row of underdogPlus.candidates || []) {
      const isSecondaryExposure = Number(row.exposure_rank || 1) > 1;
      if (isSecondaryExposure) continue;
      if (row.underdog_plus_status !== "UNDERDOG_PLUS_PAPER") {
        for (const reason of row.reasons_blocked || []) addReason(reason, row);
        for (const warning of row.warnings || []) addReason(warning, row);
        if (row.is_stale === true && !(row.reasons_blocked || []).includes("stale_line")) addReason("stale_line", row);
      }
    }

    const hasFreshDecision = (decisions.rows || []).some((row) => row.is_stale !== true && Number(row.line_age_seconds || 0) <= 24 * 60 * 60);
    if (!hasFreshDecision) addReason("no_fresh_candidates", { sport_slug: "baseball", league_slug: "mlb", market_type: "moneyline_2way", match: "Sin candidatos frescos" });

    const reasons = Array.from(reasonMap.values()).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    const dominantReason = reasons[0]?.reason || "no_fresh_candidates";
    const bettablePaperCount = decisions.counts?.BETTABLE_PAPER || 0;
    const underdogPlusPaperCount = underdogPlus.counts?.UNDERDOG_PLUS_PAPER || 0;

    return {
      bettable_paper_count: bettablePaperCount,
      underdog_plus_paper_count: underdogPlusPaperCount,
      blocked_count: (decisions.counts?.BLOCKED_BY_RISK || 0) + (underdogPlus.counts?.UNDERDOG_PLUS_BLOCKED || 0),
      watch_count: (decisions.counts?.WATCH || 0) + (underdogPlus.counts?.UNDERDOG_PLUS_WATCH || 0),
      review_count: (decisions.counts?.NEEDS_MANUAL_REVIEW || 0) + (underdogPlus.counts?.UNDERDOG_PLUS_REVIEW_ONLY || 0),
      dominant_reason: dominantReason,
      summary: bettablePaperCount === 0 ? `No hay BETTABLE_PAPER porque la razon dominante es: ${dominantReason}` : `Hay ${bettablePaperCount} BETTABLE_PAPER en modo Real Paper only.`,
      reasons,
      recommendation: whyNoBettableRecommendation(dominantReason),
      real_paper_only: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true,
      guardrails: {
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        kill_switch_enabled: true
      }
    };
  }

  async function buildStaleArchiveReport(rawQuery: unknown = {}) {
    const query = staleArchiveQuerySchema.parse(rawQuery || {});
    const apply = query.apply === true;
    const dryRun = !apply || query.dry_run === true && query.apply !== true;
    const values = [query.sport, query.league_slug, query.market_type, query.max_age_hours, query.limit];

    const candidatesResult = await db.query(
      `
        WITH enriched AS (
          SELECT
            rps.id,
            rps.status AS current_status,
            rps.entry_timestamp,
            rps.sport_slug,
            rps.league_slug,
            rps.market_type,
            rps.pick,
            home_team.name AS home_team_name,
            away_team.name AS away_team_name,
            CONCAT(home_team.name, ' vs ', away_team.name) AS match,
            rps.bookmaker,
            rps.entry_odds,
            rps.model_probability,
            rps.expected_value,
            rps.closing_odds,
            rps.archived_at,
            rps.archive_reason,
            m.match_date,
            m.status::text AS match_status,
            home_team.name AS home_team_name,
            away_team.name AS away_team_name,
            latest.captured_at AS latest_snapshot_at,
            latest.quality_score,
            ROUND(EXTRACT(EPOCH FROM (NOW() - rps.entry_timestamp)) / 3600.0, 2) AS age_hours,
            ROUND(EXTRACT(EPOCH FROM (NOW() - COALESCE(latest.captured_at, rps.entry_timestamp))) / 3600.0, 2) AS line_age_hours
          FROM real_paper_snapshots rps
          JOIN v_valid_matches m ON m.id = rps.match_id
          LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'home'
          LEFT JOIN teams home_team ON home_team.id = mh.team_id
          LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'away'
          LEFT JOIN teams away_team ON away_team.id = ma.team_id
          LEFT JOIN LATERAL (
            SELECT os.captured_at, os.quality_score
            FROM odds_snapshots os
            WHERE os.market_quote_id = rps.market_quote_id
              AND os.selection = rps.pick
            ORDER BY os.captured_at DESC
            LIMIT 1
          ) latest ON true
          WHERE rps.sport_slug = $1
            AND rps.league_slug = $2
            AND rps.market_type = $3
            AND rps.status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULTS')
        ), candidates AS (
          SELECT
            *,
            CASE
              WHEN current_status = 'PENDING_CLOSING' THEN 'STALE_ARCHIVED'
              WHEN match_status IN ('finished', 'cancelled', 'postponed') THEN 'EXPIRED'
              WHEN match_date < NOW() - ($4::int * INTERVAL '1 hour') THEN 'EXPIRED'
              ELSE 'STALE_ARCHIVED'
            END AS proposed_status,
            CASE
              WHEN current_status = 'PENDING_CLOSING' THEN 'missing_closing_persisted'
              WHEN match_status IN ('finished', 'cancelled', 'postponed') THEN 'event_not_active_' || match_status
              WHEN match_date < NOW() - ($4::int * INTERVAL '1 hour') THEN 'event_age_exceeded'
              WHEN line_age_hours > $4 THEN 'line_age_too_old'
              ELSE 'stale_line'
            END AS proposed_reason
          FROM enriched
          WHERE archived_at IS NULL
            AND (
              current_status = 'PENDING_CLOSING'
              OR match_status IN ('finished', 'cancelled', 'postponed')
              OR match_date < NOW() - ($4::int * INTERVAL '1 hour')
              OR line_age_hours > $4
            )
        )
        SELECT *
        FROM candidates
        ORDER BY entry_timestamp ASC
        LIMIT $5
      `,
      values
    );

    const candidates = candidatesResult.rows;

    let archivedRows: any[] = [];
    if (apply && candidates.length > 0) {
      const ids = candidates.map((row) => row.id);
      const updateResult = await db.query(
        `
          WITH proposed AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, proposed_status text, proposed_reason text)
          )
          UPDATE real_paper_snapshots rps
          SET previous_status = rps.status,
              status = proposed.proposed_status,
              archived_at = NOW(),
              archive_reason = proposed.proposed_reason,
              updated_at = NOW()
          FROM proposed
          WHERE rps.id = proposed.id
            AND rps.status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULTS')
            AND rps.archived_at IS NULL
          RETURNING rps.id, rps.previous_status, rps.status, rps.archived_at, rps.archive_reason
        `,
        [JSON.stringify(candidates.map((row) => ({ id: row.id, proposed_status: row.proposed_status, proposed_reason: row.proposed_reason })))]
      );
      archivedRows = updateResult.rows;
    }

    const summaryResult = await db.query(
      `
        SELECT
          status,
          COUNT(*)::int AS count,
          MIN(entry_timestamp) AS oldest,
          MAX(entry_timestamp) AS latest,
          MAX(archived_at) AS last_archive_run
        FROM real_paper_snapshots
        WHERE sport_slug = $1
          AND league_slug = $2
          AND market_type = $3
        GROUP BY status
        ORDER BY status
      `,
      [query.sport, query.league_slug, query.market_type]
    );

    const rows = summaryResult.rows.map((row) => ({
      status: row.status,
      count: row.count,
      oldest: row.oldest,
      latest: row.latest,
      proposed_action: ['OPEN', 'PENDING_CLOSING', 'PENDING_RESULTS'].includes(row.status) ? 'archive stale only via apply=true' : 'keep for audit',
      last_archive_run: row.last_archive_run,
      recommendation: ['EXPIRED', 'STALE_ARCHIVED', 'WIN', 'LOSS', 'PUSH', 'SETTLED'].includes(row.status) ? 'No tocar; historico/auditoria.' : 'Revisar dry-run antes de aplicar.'
    }));

    const examples = candidates.slice(0, 25).map((row) => ({
      id: row.id,
      match: `${row.home_team_name || 'Home'} vs ${row.away_team_name || 'Away'}`,
      entry_time: row.entry_timestamp,
      match_date: row.match_date,
      age_hours: row.age_hours,
      line_age_hours: row.line_age_hours,
      current_status: row.current_status,
      proposed_status: row.proposed_status,
      reason: row.proposed_reason,
      pick: row.pick,
      entry_odds: row.entry_odds,
      model_probability: row.model_probability,
      expected_value: row.expected_value
    }));

    const staleCandidates = candidates.filter((row) => row.current_status === 'OPEN').length;
    const pendingClosingCandidates = candidates.filter((row) => row.current_status === 'PENDING_CLOSING').length;

    return {
      mode: apply ? 'apply' : 'dry-run',
      dry_run: !apply,
      applied: apply,
      sport: query.sport,
      league_slug: query.league_slug,
      market_type: query.market_type,
      max_age_hours: query.max_age_hours,
      total_open_found: summaryResult.rows.find((row) => row.status === 'OPEN')?.count || 0,
      stale_candidates: staleCandidates,
      pending_closing_candidates: pendingClosingCandidates,
      missing_closing_candidates: pendingClosingCandidates,
      would_mark_expired: candidates.filter((row) => row.proposed_status === 'EXPIRED').length,
      would_mark_stale_archived: candidates.filter((row) => row.proposed_status === 'STALE_ARCHIVED').length,
      archived_count: archivedRows.length,
      archived_rows: archivedRows,
      examples,
      rows,
      guardrails: {
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true
      },
      recommendation: apply
        ? 'Archivado aplicado. Recalcular Why no BETTABLE_PAPER y Pick Decision Engine.'
        : 'Dry-run listo. Si los ejemplos son correctos, repetir con apply=true.'
    };
  }

  async function buildFreshArchiveState(rawQuery: unknown = {}) {
    const query = freshArchiveQuerySchema.parse(rawQuery || {});
    const apply = query.apply === true;
    const params = [query.sport, query.league_slug, query.market_type, query.max_age_minutes, query.limit];

    const candidates = await db.query(
      `
        WITH base AS (
          SELECT
            rps.id,
            rps.match_id,
            rps.market_type,
            rps.pick,
            rps.status,
            rps.data_state,
            rps.entry_timestamp,
            rps.last_refreshed_at,
            rps.archived_at,
            rps.archive_reason,
            rps.duplicate_of_id,
            rps.expected_value,
            rps.model_probability,
            rps.entry_odds,
            rps.bookmaker,
            m.match_date,
            m.status::text AS match_status,
            home.name AS home_team_name,
            away.name AS away_team_name,
            latest.captured_at AS latest_snapshot_at,
            ROW_NUMBER() OVER (
              PARTITION BY rps.match_id, rps.model_name, rps.market_type, COALESCE(rps.line, -9999::numeric), rps.pick, rps.bookmaker
              ORDER BY
                CASE WHEN rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED') THEN 0 ELSE 1 END,
                rps.entry_timestamp ASC,
                rps.id ASC
            ) AS exposure_rank,
            FIRST_VALUE(rps.id) OVER (
              PARTITION BY rps.match_id, rps.model_name, rps.market_type, COALESCE(rps.line, -9999::numeric), rps.pick, rps.bookmaker
              ORDER BY
                CASE WHEN rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED') THEN 0 ELSE 1 END,
                rps.entry_timestamp ASC,
                rps.id ASC
            ) AS canonical_snapshot_id
          FROM real_paper_snapshots rps
          JOIN v_valid_matches m ON m.id = rps.match_id
          LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'home'
          LEFT JOIN teams home ON home.id = mh.team_id
          LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'away'
          LEFT JOIN teams away ON away.id = ma.team_id
          LEFT JOIN LATERAL (
            SELECT os.captured_at
            FROM odds_snapshots os
            WHERE os.market_quote_id = rps.market_quote_id
              AND os.selection = rps.pick
            ORDER BY os.captured_at DESC
            LIMIT 1
          ) latest ON true
          WHERE rps.sport_slug = $1
            AND rps.league_slug = $2
            AND rps.market_type = $3
            AND NOT (COALESCE(rps.data_state, 'FRESH') = 'DUPLICATE' AND rps.duplicate_of_id IS NOT NULL)
        ),
        proposed AS (
          SELECT
            *,
            CASE
              WHEN exposure_rank > 1 THEN 'DUPLICATE'
              WHEN status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED') THEN 'ARCHIVED'
              WHEN COALESCE(latest_snapshot_at, last_refreshed_at, entry_timestamp) < NOW() - ($4::int * INTERVAL '1 minute') THEN 'STALE'
              ELSE 'FRESH'
            END AS proposed_data_state,
            CASE
              WHEN exposure_rank > 1 THEN 'duplicate_exposure'
              WHEN status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED') THEN 'SETTLED'
              WHEN COALESCE(latest_snapshot_at, last_refreshed_at, entry_timestamp) < NOW() - ($4::int * INTERVAL '1 minute') THEN 'line_age_too_old'
              ELSE NULL
            END AS proposed_archive_reason
          FROM base
        )
        SELECT
          *,
          CONCAT(COALESCE(home_team_name, 'Home'), ' vs ', COALESCE(away_team_name, 'Away')) AS match,
          ROUND(EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_snapshot_at, last_refreshed_at, entry_timestamp))) / 60.0, 2) AS age_minutes
        FROM proposed
        WHERE data_state IS DISTINCT FROM proposed_data_state
           OR (proposed_data_state = 'DUPLICATE' AND duplicate_of_id IS DISTINCT FROM canonical_snapshot_id)
           OR (proposed_data_state = 'ARCHIVED' AND archived_at IS NULL)
        ORDER BY
          CASE proposed_data_state WHEN 'DUPLICATE' THEN 0 WHEN 'ARCHIVED' THEN 1 WHEN 'STALE' THEN 2 ELSE 3 END,
          entry_timestamp DESC
        LIMIT $5
      `,
      params
    );

    let changedRows: any[] = [];
    if (apply && candidates.rows.length > 0) {
      const payload = candidates.rows.map((row: Record<string, any>) => ({
        id: row.id,
        proposed_data_state: row.proposed_data_state,
        duplicate_of_id: row.proposed_data_state === "DUPLICATE" ? row.canonical_snapshot_id : null,
        archive_reason: row.proposed_archive_reason
      }));
      const update = await db.query(
        `
          WITH proposed AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS x(
              id uuid,
              proposed_data_state text,
              duplicate_of_id uuid,
              archive_reason text
            )
          )
          UPDATE real_paper_snapshots rps
          SET data_state = proposed.proposed_data_state,
              duplicate_of_id = proposed.duplicate_of_id,
              archived_at = CASE
                WHEN proposed.proposed_data_state = 'ARCHIVED' AND rps.archived_at IS NULL THEN NOW()
                ELSE rps.archived_at
              END,
              archive_reason = CASE
                WHEN proposed.proposed_data_state = 'ARCHIVED' THEN COALESCE(proposed.archive_reason, rps.archive_reason, 'SETTLED')
                ELSE rps.archive_reason
              END,
              last_refreshed_at = COALESCE(rps.last_refreshed_at, rps.entry_timestamp),
              updated_at = NOW()
          FROM proposed
          WHERE rps.id = proposed.id
          RETURNING rps.id, rps.data_state, rps.duplicate_of_id, rps.archived_at, rps.archive_reason
        `,
        [JSON.stringify(payload)]
      );
      changedRows = update.rows;
    }

    const summary = await db.query(
      `
        SELECT
          COALESCE(data_state, 'FRESH') AS data_state,
          COUNT(*)::int AS count,
          COUNT(*) FILTER (WHERE status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS'))::int AS active_count,
          COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED'))::int AS settled_count,
          ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
          ROUND((COALESCE(SUM(profit_loss), 0) / 100.0)::numeric, 4) AS profit_units
        FROM real_paper_snapshots
        WHERE sport_slug = $1
          AND league_slug = $2
          AND market_type = $3
        GROUP BY COALESCE(data_state, 'FRESH')
        ORDER BY data_state
      `,
      [query.sport, query.league_slug, query.market_type]
    );

    return {
      mode: apply ? "apply" : "dry-run",
      applied: apply,
      candidates_count: candidates.rows.length,
      changed_count: changedRows.length,
      rows: candidates.rows,
      changed_rows: changedRows,
      summary: summary.rows,
      recommendation: candidates.rows.length
        ? apply
          ? "Fresh/Archive aplicado. Recalcular Data Quality y backtest."
          : "Dry-run listo. Si los cambios se ven correctos, repetir con apply=true."
        : "Sin cambios pendientes de Fresh/Archive.",
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true
      }
    };
  }

  async function buildDataQualityScores(rawQuery: unknown = {}) {
    const query = dataQualityQuerySchema.parse(rawQuery || {});
    const apply = query.apply === true;
    const rows = await db.query(
      `
        WITH enriched AS (
          SELECT
            rps.id AS snapshot_id,
            rps.match_id,
            rps.sport_slug,
            rps.league_slug,
            rps.market_type,
            rps.status,
            rps.data_state,
            rps.entry_odds,
            rps.entry_timestamp,
            rps.model_probability,
            rps.expected_value,
            rps.duplicate_of_id,
            COALESCE(latest_features.feature_set, rps.raw_data->'feature_set', '{}'::jsonb) AS feature_set,
            latest.captured_at AS latest_snapshot_at,
            latest.quality_score AS provider_quality_score,
            exposure.open_exposure_count,
            ROUND(EXTRACT(EPOCH FROM (NOW() - COALESCE(latest.captured_at, rps.entry_timestamp)))::numeric, 0) AS line_age_seconds,
            ROW_NUMBER() OVER (
              PARTITION BY rps.match_id
              ORDER BY
                CASE
                  WHEN rps.duplicate_of_id IS NULL AND COALESCE(rps.data_state, 'FRESH') <> 'DUPLICATE' THEN 0
                  ELSE 1
                END,
                rps.expected_value DESC NULLS LAST,
                rps.model_probability DESC NULLS LAST,
                rps.entry_timestamp DESC,
                rps.id DESC
            ) AS exposure_rank,
            CONCAT(home.name, ' vs ', away.name) AS match
          FROM real_paper_snapshots rps
          JOIN v_valid_matches m ON m.id = rps.match_id
          LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'home'
          LEFT JOIN teams home ON home.id = mh.team_id
          LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'away'
          LEFT JOIN teams away ON away.id = ma.team_id
          LEFT JOIN LATERAL (
            SELECT os.captured_at, os.quality_score
            FROM odds_snapshots os
            WHERE os.market_quote_id = rps.market_quote_id
              AND os.selection = rps.pick
            ORDER BY os.captured_at DESC
            LIMIT 1
          ) latest ON true
          LEFT JOIN LATERAL (
            SELECT mf.feature_set
            FROM model_features mf
            WHERE mf.match_id = rps.match_id
              AND mf.sport_slug = rps.sport_slug
              AND mf.model_name = rps.model_name
            ORDER BY mf.generated_at DESC
            LIMIT 1
          ) latest_features ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS open_exposure_count
            FROM real_paper_snapshots other
            WHERE other.match_id = rps.match_id
              AND other.market_type = rps.market_type
              AND other.pick = rps.pick
              AND other.id <> rps.id
              AND other.status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
              AND other.duplicate_of_id IS NULL
              AND COALESCE(other.data_state, 'FRESH') <> 'DUPLICATE'
          ) exposure ON true
          WHERE rps.sport_slug = $1
            AND rps.league_slug = $2
            AND rps.market_type = $3
        ),
        scored AS (
          SELECT
            *,
            CASE
              WHEN (
                 NULLIF(COALESCE(feature_set->>'home_starting_pitcher', feature_set->>'home_probable_pitcher', feature_set->>'probable_home_pitcher'), '') IS NOT NULL
                 OR COALESCE(feature_set->>'home_pitcher_status', '') IN ('CONFIRMED', 'PROBABLE')
               )
               AND (
                 NULLIF(COALESCE(feature_set->>'away_starting_pitcher', feature_set->>'away_probable_pitcher', feature_set->>'probable_away_pitcher'), '') IS NOT NULL
                 OR COALESCE(feature_set->>'away_pitcher_status', '') IN ('CONFIRMED', 'PROBABLE')
               )
              THEN 20 ELSE 0
            END AS pitcher_score,
            CASE
              WHEN COALESCE(feature_set->>'home_lineup_confirmed', feature_set->>'lineup_home_confirmed', '') IN ('true', '1', 'yes', 'CONFIRMED')
               AND COALESCE(feature_set->>'away_lineup_confirmed', feature_set->>'lineup_away_confirmed', '') IN ('true', '1', 'yes', 'CONFIRMED')
              THEN 20
              WHEN COALESCE(feature_set->>'home_lineup_status', '') = 'CONFIRMED'
               AND COALESCE(feature_set->>'away_lineup_status', '') = 'CONFIRMED'
              THEN 20
              WHEN COALESCE(feature_set->>'lineup_status', '') = 'LINEUP_CONFIRMED_BOTH'
              THEN 20 ELSE 0
            END AS lineup_score,
            CASE
              WHEN (
                NULLIF(feature_set->>'home_bullpen_fatigue_score', '') IS NOT NULL
                OR NULLIF(feature_set->>'home_bullpen_fatigue', '') IS NOT NULL
              )
              AND (
                NULLIF(feature_set->>'away_bullpen_fatigue_score', '') IS NOT NULL
                OR NULLIF(feature_set->>'away_bullpen_fatigue', '') IS NOT NULL
              )
              THEN 10 ELSE 0
            END AS bullpen_score,
            CASE
              WHEN status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED') THEN 15
              WHEN latest_snapshot_at IS NOT NULL AND COALESCE(line_age_seconds, 999999999) <= 24 * 60 * 60 THEN 15
              WHEN latest_snapshot_at IS NULL AND COALESCE(data_state, 'FRESH') = 'FRESH' THEN 15
              ELSE 0
            END AS freshness_score,
            CASE WHEN COALESCE(provider_quality_score, 100) >= 80 THEN 10 ELSE 0 END AS provider_score,
            CASE
              WHEN duplicate_of_id IS NULL
               AND (
                 status NOT IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
                 OR COALESCE(exposure_rank, 1) = 1
               )
              THEN 10 ELSE 0
            END AS duplicate_score,
            CASE WHEN model_probability >= 0.55 AND expected_value >= 0.05 THEN 10 ELSE 0 END AS model_edge_score,
            CASE WHEN entry_odds >= 1.01 THEN 5 ELSE 0 END AS odds_score
          FROM enriched
        ),
        final AS (
          SELECT
            *,
            (pitcher_score + lineup_score + bullpen_score + freshness_score + provider_score + duplicate_score + model_edge_score + odds_score)::int AS total_score,
            ARRAY_REMOVE(ARRAY[
              CASE WHEN pitcher_score = 0 THEN 'pitcher_context' END,
              CASE WHEN lineup_score = 0 THEN 'lineup_context' END,
              CASE WHEN bullpen_score = 0 THEN 'bullpen_context' END,
              CASE WHEN freshness_score = 0 THEN 'fresh_line' END,
              CASE WHEN provider_score = 0 THEN 'provider_quality' END,
              CASE WHEN duplicate_score = 0 THEN 'duplicate_exposure' END,
              CASE WHEN model_edge_score = 0 THEN 'model_probability_or_ev' END,
              CASE WHEN odds_score = 0 THEN 'odds_valid' END
            ], NULL) AS missing_components
          FROM scored
        )
        SELECT
          snapshot_id,
          sport_slug,
          league_slug,
          market_type,
          match,
          jsonb_build_object(
            'pitcher_context', pitcher_score,
            'lineup_context', lineup_score,
            'bullpen_context', bullpen_score,
            'fresh_line', freshness_score,
            'provider_quality', provider_score,
            'no_duplicate_exposure', duplicate_score,
            'model_edge', model_edge_score,
            'odds_valid', odds_score
          ) AS component_scores,
          total_score,
          CASE
            WHEN total_score >= 81 THEN 'STRONG'
            WHEN total_score >= 61 THEN 'REVIEWABLE'
            WHEN total_score >= 41 THEN 'INCOMPLETE'
            ELSE 'WEAK'
          END AS tier,
          missing_components,
          CASE
            WHEN total_score >= 81 THEN 'Datos fuertes. Puede apoyar confirmacion paper si la cadena de decision tambien pasa.'
            ELSE 'No confirma porque falta ' || array_to_string(missing_components, ', ') || '.'
          END AS why_not_confirmed
        FROM final
        WHERE duplicate_of_id IS NULL
          AND COALESCE(data_state, 'FRESH') <> 'DUPLICATE'
          AND (
            status NOT IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
            OR COALESCE(exposure_rank, 1) = 1
          )
        ORDER BY entry_timestamp DESC
        LIMIT $4
      `,
      [query.sport, query.league_slug, query.market_type, query.limit]
    );

    let upserted = 0;
    if (apply && rows.rows.length > 0) {
      const upsert = await db.query(
        `
          INSERT INTO data_quality_scores (
            snapshot_id, sport_slug, league_slug, market_type,
            component_scores, total_score, tier, missing_components, why_not_confirmed, calculated_at
          )
          SELECT
            x.snapshot_id, x.sport_slug, x.league_slug, x.market_type,
            x.component_scores, x.total_score, x.tier, x.missing_components, x.why_not_confirmed, NOW()
          FROM jsonb_to_recordset($1::jsonb) AS x(
            snapshot_id uuid,
            sport_slug text,
            league_slug text,
            market_type text,
            component_scores jsonb,
            total_score int,
            tier text,
            missing_components text[],
            why_not_confirmed text
          )
          ON CONFLICT (snapshot_id) DO UPDATE SET
            component_scores = EXCLUDED.component_scores,
            total_score = EXCLUDED.total_score,
            tier = EXCLUDED.tier,
            missing_components = EXCLUDED.missing_components,
            why_not_confirmed = EXCLUDED.why_not_confirmed,
            calculated_at = NOW(),
            updated_at = NOW()
          RETURNING snapshot_id
        `,
        [JSON.stringify(rows.rows)]
      );
      upserted = upsert.rowCount || 0;
    }

    const summary = rows.rows.reduce<Record<string, number>>((acc, row: Record<string, any>) => {
      acc[row.tier] = (acc[row.tier] || 0) + 1;
      return acc;
    }, {});

    return {
      mode: apply ? "apply" : "dry-run",
      applied: apply,
      calculated_count: rows.rows.length,
      upserted_count: upserted,
      summary,
      rows: rows.rows,
      recommendation: apply
        ? "Data Quality persistido. Usar estos scores en backtest y Pilot Gate."
        : "Dry-run de Data Quality listo. Repetir con apply=true para persistir.",
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true
      }
    };
  }

  async function buildEvOutlierGuardrail(rawQuery: unknown = {}) {
    const query = evOutlierQuerySchema.parse(rawQuery || {});
    const apply = query.apply === true;
    const stats = await db.query(
      `
        SELECT
          ROUND(AVG(expected_value)::numeric, 6) AS mean_ev,
          ROUND(COALESCE(STDDEV_SAMP(expected_value), 0)::numeric, 6) AS std_ev,
          COUNT(*)::int AS sample_size
        FROM real_paper_snapshots
        WHERE sport_slug = $1
          AND league_slug = $2
          AND market_type = $3
          AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
          AND entry_timestamp >= NOW() - ($4::int * INTERVAL '1 day')
      `,
      [query.sport, query.league_slug, query.market_type, query.lookback_days]
    );

    const meanEv = Number(stats.rows[0]?.mean_ev || 0);
    const stdEv = Number(stats.rows[0]?.std_ev || 0);
    const threshold = meanEv + query.stddev_multiplier * stdEv;
    const candidates = await db.query(
      `
        SELECT
          rps.id,
          rps.sport_slug,
          rps.league_slug,
          rps.market_type,
          rps.pick,
          rps.bookmaker,
          rps.entry_odds,
          rps.model_probability,
          rps.expected_value,
          rps.status,
          rps.ev_flag,
          rps.entry_timestamp,
          CONCAT(home.name, ' vs ', away.name) AS match
        FROM real_paper_snapshots rps
        JOIN v_valid_matches m ON m.id = rps.match_id
        LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'home'
        LEFT JOIN teams home ON home.id = mh.team_id
        LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'away'
        LEFT JOIN teams away ON away.id = ma.team_id
        WHERE rps.sport_slug = $1
          AND rps.league_slug = $2
          AND rps.market_type = $3
          AND rps.status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
          AND rps.expected_value > $4
          AND COALESCE(rps.ev_flag, '') <> 'EV_OUTLIER_HIGH'
        ORDER BY rps.expected_value DESC, rps.entry_timestamp DESC
        LIMIT $5
      `,
      [query.sport, query.league_slug, query.market_type, threshold, query.limit]
    );

    let flaggedRows: any[] = [];
    if (apply && candidates.rows.length > 0) {
      const flagged = await db.query(
        `
          UPDATE real_paper_snapshots
          SET ev_flag = 'EV_OUTLIER_HIGH',
              updated_at = NOW()
          WHERE id = ANY($1::uuid[])
          RETURNING id, ev_flag, expected_value
        `,
        [candidates.rows.map((row: Record<string, any>) => row.id)]
      );
      flaggedRows = flagged.rows;
    }

    return {
      mode: apply ? "apply" : "dry-run",
      applied: apply,
      mean_ev: meanEv,
      std_ev: stdEv,
      threshold,
      sample_size: Number(stats.rows[0]?.sample_size || 0),
      candidates_count: candidates.rows.length,
      flagged_count: flaggedRows.length,
      rows: candidates.rows,
      flagged_rows: flaggedRows,
      recommendation: candidates.rows.length
        ? apply
          ? "EV outliers marcados como EV_OUTLIER_HIGH. Mantener en review."
          : "Hay EV outliers; revisar y aplicar solo si el umbral se ve correcto."
        : "Sin EV outliers frescos contra el umbral rolling.",
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true
      }
    };
  }

  async function buildConfirmedVsEvBacktest(rawQuery: unknown = {}) {
    const query = confirmedVsEvQuerySchema.parse(rawQuery || {});
    const result = await db.query(
      `
        WITH raw_sample AS (
          SELECT
            rps.id,
            rps.match_id,
            rps.pick,
            rps.bookmaker,
            rps.sport_slug,
            rps.league_slug,
            rps.market_type,
            rps.status AS settlement_status,
            COALESCE(rps.data_state, 'FRESH') AS data_state,
            rps.entry_odds,
            rps.closing_odds,
            rps.clv,
            rps.profit_loss,
            rps.model_probability,
            rps.expected_value,
            rps.entry_timestamp,
            dqs.total_score AS data_quality_score,
            dqs.tier AS data_quality_tier,
            COALESCE(
              rps.raw_data->>'final_chain_status',
              rps.raw_data->>'final_operational_status',
              rps.raw_data->>'decision',
              CASE WHEN dqs.tier = 'STRONG' THEN 'BETTABLE_PAPER_CONFIRMED' ELSE 'EV_ONLY' END
            ) AS decision_bucket,
            ROW_NUMBER() OVER (
              PARTITION BY rps.match_id, rps.pick, COALESCE(rps.bookmaker, ''), rps.entry_timestamp
              ORDER BY rps.updated_at DESC, rps.id
            ) AS exposure_rank
          FROM real_paper_snapshots rps
          LEFT JOIN data_quality_scores dqs ON dqs.snapshot_id = rps.id
          WHERE rps.sport_slug = $1
            AND rps.league_slug = $2
            AND rps.market_type = $3
            AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
            AND COALESCE(rps.data_state, 'FRESH') IN ('ARCHIVED', 'FRESH')
            AND rps.duplicate_of_id IS NULL
          ORDER BY rps.entry_timestamp DESC
          LIMIT $4
        ),
        sample AS (
          SELECT *
          FROM raw_sample
          WHERE exposure_rank = 1
        ),
        labeled AS (
          SELECT
            *,
            CASE
              WHEN decision_bucket ILIKE '%CONFIRMED%' OR data_quality_tier = 'STRONG' THEN 'confirmed_context'
              WHEN data_quality_tier IN ('WEAK', 'INCOMPLETE') THEN 'ev_only_no_context'
              WHEN data_quality_tier = 'REVIEWABLE' THEN 'paper_reviewable'
              ELSE 'paper_only'
            END AS segment
          FROM sample
        ),
        ranked AS (
          SELECT
            *,
            profit_loss / 100.0 AS profit_units_real,
            ROW_NUMBER() OVER (PARTITION BY segment ORDER BY profit_loss / 100.0 DESC) AS profit_rank,
            GREATEST(1, CEIL(COUNT(*) OVER (PARTITION BY segment) * 0.10))::int AS top_10pct_n
          FROM labeled
        )
        SELECT
          segment,
          COUNT(*)::int AS n,
          COUNT(*) FILTER (WHERE settlement_status = 'WIN')::int AS wins,
          COUNT(*) FILTER (WHERE settlement_status = 'LOSS')::int AS losses,
          ROUND(AVG(model_probability)::numeric, 6) AS avg_model_probability,
          ROUND(AVG(expected_value)::numeric, 6) AS avg_ev,
          ROUND(AVG(data_quality_score)::numeric, 2) AS avg_data_quality_score,
          ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
          COUNT(*) FILTER (WHERE clv > 0)::int AS positive_clv,
          ROUND(COALESCE(SUM(profit_units_real), 0)::numeric, 4) AS profit_units,
          ROUND((COALESCE(SUM(profit_units_real), 0) / NULLIF(COUNT(*), 0))::numeric, 6) AS yield_units_per_pick,
          MAX(top_10pct_n)::int AS top_10pct_n,
          ROUND(COALESCE(SUM(profit_units_real) FILTER (WHERE profit_rank <= top_10pct_n), 0)::numeric, 4) AS profit_from_top10,
          ROUND(COALESCE(SUM(profit_units_real) FILTER (WHERE profit_rank > top_10pct_n), 0)::numeric, 4) AS profit_excluding_top10,
          ROUND((
            COALESCE(SUM(profit_units_real) FILTER (WHERE profit_rank <= top_10pct_n), 0)
            / NULLIF(COALESCE(SUM(profit_units_real), 0), 0)
          )::numeric, 6) AS concentration_ratio,
          ROUND(AVG(POWER((CASE WHEN settlement_status = 'WIN' THEN 1 ELSE 0 END) - model_probability, 2))::numeric, 6) AS brier
        FROM ranked
        GROUP BY segment
        ORDER BY
          CASE segment
            WHEN 'confirmed_context' THEN 0
            WHEN 'paper_reviewable' THEN 1
            WHEN 'paper_only' THEN 2
            ELSE 3
          END
      `,
      [query.sport, query.league_slug, query.market_type, query.limit]
    );

    const rows = result.rows.map((row: Record<string, any>) => {
      const n = Number(row.n || 0);
      const avgClv = Number(row.avg_clv || 0);
      const profit = Number(row.profit_units || 0);
      const profitExcludingTop10 = Number(row.profit_excluding_top10 || 0);
      const robust = profitExcludingTop10 > 0;
      return {
        ...row,
        robustness_status: robust ? "ROBUST_AFTER_TOP10_EXCLUSION" : "DEPENDS_ON_TAIL",
        sample_status: n < query.min_sample_size
          ? "INSUFFICIENT_SAMPLE"
          : profit > 0 && avgClv > 0
            ? "POSITIVE_EDGE_REVIEW"
            : profit > 0
              ? "PROFIT_WITH_CLV_REVIEW"
              : avgClv > 0
                ? "CLV_WITH_PROFIT_REVIEW"
                : "NO_SIGNAL",
        recommendation: n < query.min_sample_size
          ? `Muestra insuficiente: ${n}/${query.min_sample_size}. No usar para piloto real.`
          : profit > 0 && avgClv > 0
            ? robust
              ? "Señal positiva en profit y CLV, y sigue positiva sin el top 10%. Mantener Real Paper y exigir confirmados frescos."
              : "Profit/CLV positivos, pero depende de pocos picks grandes. Mantener en review, sin piloto real."
            : "No promover. Seguir acumulando o revisar calidad/segmento."
      };
    });

    return {
      system_status: "CONFIRMED_VS_EV_BACKTEST_READ_ONLY",
      min_sample_size: query.min_sample_size,
      count: rows.length,
      rows,
      recommendation: rows.some((row: Record<string, any>) => row.segment === "confirmed_context" && row.sample_status === "POSITIVE_EDGE_REVIEW")
        ? "Confirmed context muestra señal, pero sigue bloqueado hasta muestra suficiente y revisión manual."
        : "Todavía no hay evidencia suficiente de que Confirmed Paper supere EV-only.",
      guardrails: {
        read_only: true,
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true
      }
    };
  }

  async function buildFormalPilotReadiness(rawQuery: unknown = {}) {
    const query = z.object({ persist: booleanQuery(false) }).parse(rawQuery || {});
    const [backtest, dq, duplicates, provider, settlement] = await Promise.all([
      buildConfirmedVsEvBacktest({ min_sample_size: 150, limit: 5000 }),
      db.query(`
        SELECT ROUND(AVG(total_score)::numeric, 2) AS avg_quality_score_confirmed,
               COUNT(*)::int AS confirmed_count
        FROM data_quality_scores dqs
        JOIN real_paper_snapshots rps ON rps.id = dqs.snapshot_id
        WHERE rps.sport_slug = 'baseball'
          AND rps.league_slug = 'mlb'
          AND rps.market_type = 'moneyline_2way'
          AND dqs.tier = 'STRONG'
          AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
      `),
      db.query(`
        SELECT COUNT(*)::int AS duplicates_4w
        FROM real_paper_snapshots
        WHERE sport_slug = 'baseball'
          AND league_slug = 'mlb'
          AND market_type = 'moneyline_2way'
          AND duplicate_of_id IS NOT NULL
          AND entry_timestamp >= NOW() - INTERVAL '28 days'
      `),
      db.query(`
        SELECT COUNT(*) FILTER (WHERE provider_score < 80 OR status <> 'ACTIVE_CLEAN')::int AS provider_alerts
        FROM (
          SELECT
            COALESCE(bookmaker, provider_name) AS provider,
            CASE
              WHEN AVG(quality_score) >= 80 THEN 90
              ELSE ROUND(AVG(quality_score)::numeric, 2)
            END AS provider_score,
            CASE
              WHEN AVG(quality_score) >= 80 THEN 'ACTIVE_CLEAN'
              ELSE 'REVIEW'
            END AS status
          FROM odds_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND captured_at >= NOW() - INTERVAL '7 days'
          GROUP BY COALESCE(bookmaker, provider_name)
        ) providers
      `),
      db.query(`
        SELECT COUNT(*) FILTER (WHERE status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS'))::int AS unsettled
        FROM real_paper_snapshots
        WHERE sport_slug = 'baseball'
          AND league_slug = 'mlb'
          AND market_type = 'moneyline_2way'
          AND duplicate_of_id IS NULL
          AND COALESCE(data_state, 'FRESH') IN ('FRESH', 'ARCHIVED')
      `)
    ]);

    const confirmedSegment = ((backtest.rows || []).find((row: Record<string, any>) => row.segment === "confirmed_context") || {}) as Record<string, any>;
    const backtestPositive = confirmedSegment.sample_status === "POSITIVE_EDGE_REVIEW";
    const minSampleReached = Number(confirmedSegment.n || 0) >= 150;
    const avgQuality = Number(dq.rows[0]?.avg_quality_score_confirmed || 0);
    const qualityPasses = avgQuality >= 80;
    const zeroDuplicateExposure = Number(duplicates.rows[0]?.duplicates_4w || 0) === 0;
    const providerClean = Number(provider.rows[0]?.provider_alerts || 0) === 0;
    const settlementClean = Number(settlement.rows[0]?.unsettled || 0) === 0;
    const allPassed = backtestPositive && minSampleReached && qualityPasses && zeroDuplicateExposure && providerClean && settlementClean;
    const payload = {
      backtest_positive_ci: backtestPositive,
      min_sample_reached: minSampleReached,
      avg_quality_score_confirmed: avgQuality || null,
      quality_score_passes: qualityPasses,
      zero_duplicate_exposure: zeroDuplicateExposure,
      provider_scorecard_clean: providerClean,
      settlement_clean: settlementClean,
      all_passed: allPassed,
      metrics: {
        confirmed_segment: confirmedSegment,
        duplicates_4w: Number(duplicates.rows[0]?.duplicates_4w || 0),
        provider_alerts: Number(provider.rows[0]?.provider_alerts || 0),
        unsettled: Number(settlement.rows[0]?.unsettled || 0)
      },
      recommendation: allPassed
        ? "PILOT_READY_BUT_LOCKED: todos los checks pasan, pero dinero real sigue bloqueado hasta autorización explícita."
        : "No promover. Seguir Real Paper hasta que backtest, calidad, duplicados, providers y settlement pasen juntos.",
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true
      }
    };

    if (query.persist) {
      await db.query(
        `
          INSERT INTO pilot_readiness_checklist (
            backtest_positive_ci, min_sample_reached, avg_quality_score_confirmed,
            quality_score_passes, zero_duplicate_exposure, provider_scorecard_clean,
            settlement_clean, all_passed, metrics, recommendation, guardrails
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb)
        `,
        [
          payload.backtest_positive_ci,
          payload.min_sample_reached,
          payload.avg_quality_score_confirmed,
          payload.quality_score_passes,
          payload.zero_duplicate_exposure,
          payload.provider_scorecard_clean,
          payload.settlement_clean,
          payload.all_passed,
          JSON.stringify(payload.metrics),
          payload.recommendation,
          JSON.stringify(payload.guardrails)
        ]
      );
    }

    return {
      system_status: "FORMAL_PILOT_READINESS_READ_ONLY",
      persisted: query.persist,
      ...payload
    };
  }

  async function buildUnderdogLab() {
    const rulesResult = await db.query(
      `
        WITH params AS (
          SELECT *
          FROM (VALUES
            ('mlb_underdog_ev5_base'::text, 'Base EV5', 0.00::numeric, 0.05::numeric, 2.0100::numeric, 100.00::numeric, 'any'::text, false, false, false, false),
            ('mlb_underdog_plus_prob55', 'Plus prob >=55', 0.55, 0.05, 2.0100, 100.00, 'any', false, false, false, false),
            ('mlb_underdog_plus_prob58', 'Plus prob >=58', 0.58, 0.05, 2.0100, 100.00, 'any', false, false, false, false),
            ('mlb_underdog_odds_205_250', 'Odds 2.05-2.50', 0.00, 0.05, 2.0100, 2.5000, 'any', false, false, false, false),
            ('mlb_underdog_odds_250_plus', 'Odds 2.50+', 0.00, 0.05, 2.5001, 100.00, 'any', false, false, false, false),
            ('mlb_underdog_home', 'Home underdogs', 0.00, 0.05, 2.0100, 100.00, 'home', false, false, false, false),
            ('mlb_underdog_away', 'Away underdogs', 0.00, 0.05, 2.0100, 100.00, 'away', false, false, false, false),
            ('mlb_underdog_recent_clv_positive', 'Recent CLV positive', 0.00, 0.05, 2.0100, 100.00, 'any', true, false, false, false),
            ('mlb_underdog_plus_strict', 'Underdog Plus strict', 0.55, 0.05, 2.0100, 100.00, 'any', true, true, true, true)
          ) AS p(rule_key, rule_name, min_model_probability, min_ev, min_odds, max_odds, pick_filter, require_recent_clv_positive, require_provider_clean, require_no_stale, require_no_suspicious)
        ),
        enriched AS (
          SELECT
            rps.*,
            latest.quality_score,
            latest.captured_at AS latest_snapshot_at,
            latest.book_count,
            CASE
              WHEN latest.captured_at IS NOT NULL AND latest.captured_at < NOW() - INTERVAL '24 hours' THEN true
              ELSE false
            END AS is_stale,
            CASE
              WHEN latest.quality_score IS NOT NULL AND latest.quality_score < 80 THEN true
              WHEN rps.clv IS NOT NULL AND rps.clv < -0.08 THEN true
              ELSE false
            END AS suspicious_move,
            ROW_NUMBER() OVER (ORDER BY rps.entry_timestamp DESC) AS recent_rank
          FROM real_paper_snapshots rps
          JOIN v_valid_matches m ON m.id = rps.match_id
          LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'home'
          LEFT JOIN teams home_team ON home_team.id = mh.team_id
          LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'away'
          LEFT JOIN teams away_team ON away_team.id = ma.team_id
          LEFT JOIN LATERAL (
            SELECT
              os.quality_score,
              os.captured_at,
              COUNT(*) OVER (PARTITION BY os.market_quote_id) AS book_count
            FROM odds_snapshots os
            WHERE os.market_quote_id = rps.market_quote_id
              AND os.selection = rps.pick
            ORDER BY os.captured_at DESC
            LIMIT 1
          ) latest ON true
          WHERE rps.sport_slug = 'baseball'
            AND rps.league_slug = 'mlb'
            AND rps.market_type = 'moneyline_2way'
            AND rps.entry_odds >= 2.0100
            AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
        ),
        samples AS (
          SELECT p.*, e.*
          FROM params p
          JOIN enriched e
            ON e.expected_value >= p.min_ev
           AND e.model_probability >= p.min_model_probability
           AND e.entry_odds >= p.min_odds
           AND e.entry_odds <= p.max_odds
           AND (p.pick_filter = 'any' OR e.pick = p.pick_filter)
           AND (p.require_provider_clean = false OR COALESCE(e.quality_score, 0) >= 80)
           AND (p.require_no_stale = false OR e.is_stale = false)
           AND (p.require_no_suspicious = false OR e.suspicious_move = false)
        ),
        grouped AS (
          SELECT
            rule_key,
            rule_name,
            COUNT(*)::int AS closed,
            COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
            COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
            COUNT(*) FILTER (WHERE status = 'PUSH')::int AS pushes,
            CASE WHEN COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS')) > 0
              THEN ROUND((COUNT(*) FILTER (WHERE status = 'WIN')::numeric / COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS'))), 6)
              ELSE NULL
            END AS win_rate,
            ROUND(AVG(entry_odds)::numeric, 4) AS avg_entry_odds,
            ROUND(AVG(closing_odds) FILTER (WHERE closing_odds IS NOT NULL)::numeric, 4) AS avg_close_odds,
            ROUND(AVG(model_probability)::numeric, 6) AS avg_model_prob,
            ROUND(AVG(expected_value)::numeric, 6) AS avg_ev,
            ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
            CASE WHEN COUNT(*) FILTER (WHERE clv IS NOT NULL) > 0
              THEN ROUND((COUNT(*) FILTER (WHERE clv > 0)::numeric / COUNT(*) FILTER (WHERE clv IS NOT NULL)), 6)
              ELSE NULL
            END AS clv_positive_rate,
            ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
            ROUND((COALESCE(SUM(profit_loss), 0) / NULLIF(COUNT(*), 0))::numeric, 6) AS roi,
            ROUND((COALESCE(SUM(profit_loss), 0) / NULLIF(COUNT(*), 0))::numeric, 6) AS yield,
            ROUND(AVG(POWER((CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) - model_probability, 2))::numeric, 6) AS brier,
            ROUND(AVG(clv) FILTER (WHERE recent_rank <= 10 AND clv IS NOT NULL)::numeric, 6) AS recent_clv_10,
            ROUND(AVG(clv) FILTER (WHERE recent_rank <= 20 AND clv IS NOT NULL)::numeric, 6) AS recent_clv_20,
            ROUND(COALESCE(SUM(profit_loss) FILTER (WHERE recent_rank <= 10), 0)::numeric, 4) AS recent_profit_10,
            ROUND(COALESCE(SUM(profit_loss) FILTER (WHERE recent_rank <= 20), 0)::numeric, 4) AS recent_profit_20,
            COUNT(*) FILTER (WHERE is_stale)::int AS stale_count,
            COUNT(*) FILTER (WHERE suspicious_move)::int AS suspicious_count,
            COUNT(*) FILTER (WHERE COALESCE(book_count, 0) <= 1)::int AS single_book_count
          FROM samples
          GROUP BY rule_key, rule_name
        ),
        ordered_samples AS (
          SELECT
            rule_key,
            entry_timestamp,
            COALESCE(profit_loss, 0) AS profit_loss,
            SUM(COALESCE(profit_loss, 0)) OVER (PARTITION BY rule_key ORDER BY entry_timestamp ROWS UNBOUNDED PRECEDING) AS running_profit
          FROM samples
        ),
        drawdowns AS (
          SELECT
            rule_key,
            ROUND(ABS(MIN(running_profit - running_peak))::numeric, 4) AS max_drawdown
          FROM (
            SELECT
              rule_key,
              running_profit,
              MAX(running_profit) OVER (PARTITION BY rule_key ORDER BY entry_timestamp ROWS UNBOUNDED PRECEDING) AS running_peak
            FROM ordered_samples
          ) dd
          GROUP BY rule_key
        ),
        scored AS (
          SELECT
            g.*,
            COALESCE(d.max_drawdown, 0) AS max_drawdown,
            ROUND((
              LEAST(GREATEST(COALESCE(g.profit_units, 0) / 25.0, 0), 35)
              + LEAST(GREATEST(COALESCE(g.avg_clv, 0) * 800, 0), 20)
              + LEAST(GREATEST(COALESCE(g.recent_clv_10, 0) * 700, 0), 15)
              + LEAST(GREATEST(g.closed / 2.0, 0), 15)
              + LEAST(GREATEST((0.28 - COALESCE(g.brier, 0.28)) * 100, 0), 15)
              - LEAST(GREATEST(COALESCE(d.max_drawdown, 0) / 100.0, 0), 15)
              - LEAST(g.stale_count * 1.5, 10)
              - LEAST(g.suspicious_count * 2.0, 10)
              - LEAST(g.single_book_count * 0.5, 6)
            )::numeric, 4) AS underdog_score
          FROM grouped g
          LEFT JOIN drawdowns d ON d.rule_key = g.rule_key
        ),
        with_status AS (
          SELECT
            *,
            CASE
              WHEN closed < 30 THEN 'INSUFFICIENT_SAMPLE'
              WHEN closed >= 50 AND profit_units > 0 AND COALESCE(avg_clv, 0) > 0 AND COALESCE(recent_clv_10, 0) > 0 AND recent_profit_10 > 0 THEN 'HOT'
              WHEN closed >= 50 AND profit_units > 0 AND COALESCE(avg_clv, 0) > 0 AND COALESCE(brier, 1) <= 0.26 THEN 'READY_FOR_REVIEW'
              WHEN closed >= 30 AND profit_units > 0 AND COALESCE(avg_clv, 0) > 0 THEN 'WATCHLIST'
              WHEN COALESCE(avg_clv, 0) > 0 AND (COALESCE(recent_clv_10, 0) < 0 OR recent_profit_10 < 0) THEN 'COOLING'
              WHEN closed >= 30 AND (profit_units <= 0 OR COALESCE(avg_clv, 0) <= 0) THEN 'BLOCKED'
              ELSE 'WATCHLIST'
            END AS status,
            CASE
              WHEN closed < 30 THEN 'Seguir acumulando muestra.'
              WHEN closed >= 50 AND profit_units > 0 AND COALESCE(avg_clv, 0) > 0 AND COALESCE(recent_clv_10, 0) > 0 AND recent_profit_10 > 0 THEN 'HOT: version candidata a revision manual, Real Paper only.'
              WHEN closed >= 50 AND profit_units > 0 AND COALESCE(avg_clv, 0) > 0 THEN 'READY_FOR_REVIEW: comparar contra base antes de promover.'
              WHEN profit_units > 0 AND COALESCE(avg_clv, 0) > 0 THEN 'WATCHLIST: buena senal, falta robustez.'
              WHEN COALESCE(avg_clv, 0) > 0 THEN 'COOLING: CLV historico bien, reciente flojo.'
              ELSE 'BLOCKED: no cumple profit/CLV con muestra suficiente.'
            END AS recommendation
          FROM scored
        ),
        base AS (
          SELECT * FROM with_status WHERE rule_key = 'mlb_underdog_ev5_base'
        )
        SELECT
          ROW_NUMBER() OVER (ORDER BY ws.underdog_score DESC, ws.profit_units DESC, ws.avg_clv DESC NULLS LAST) AS rank,
          ws.*,
          ROUND((ws.win_rate - b.win_rate)::numeric, 6) AS delta_win_rate,
          ROUND((ws.profit_units - b.profit_units)::numeric, 4) AS delta_profit,
          ROUND((COALESCE(ws.avg_clv, 0) - COALESCE(b.avg_clv, 0))::numeric, 6) AS delta_clv,
          ROUND((COALESCE(b.brier, 0) - COALESCE(ws.brier, 0))::numeric, 6) AS delta_brier,
          ROUND((COALESCE(b.max_drawdown, 0) - COALESCE(ws.max_drawdown, 0))::numeric, 4) AS delta_drawdown,
          ROUND((ws.underdog_score - b.underdog_score)::numeric, 4) AS delta_score,
          json_build_object(
            'delta_win_rate', ROUND((ws.win_rate - b.win_rate)::numeric, 6),
            'delta_profit', ROUND((ws.profit_units - b.profit_units)::numeric, 4),
            'delta_clv', ROUND((COALESCE(ws.avg_clv, 0) - COALESCE(b.avg_clv, 0))::numeric, 6),
            'delta_brier', ROUND((COALESCE(b.brier, 0) - COALESCE(ws.brier, 0))::numeric, 6),
            'delta_drawdown', ROUND((COALESCE(b.max_drawdown, 0) - COALESCE(ws.max_drawdown, 0))::numeric, 4),
            'delta_score', ROUND((ws.underdog_score - b.underdog_score)::numeric, 4)
          ) AS upgrade_vs_base
        FROM with_status ws
        CROSS JOIN base b
        ORDER BY rank
      `
    );

    const candidatesResult = await db.query(
      `
        WITH recent AS (
          SELECT
            ROUND(AVG(clv) FILTER (WHERE rn <= 10 AND clv IS NOT NULL)::numeric, 6) AS recent_clv_10,
            ROUND(AVG(clv) FILTER (WHERE rn <= 20 AND clv IS NOT NULL)::numeric, 6) AS recent_clv_20
          FROM (
            SELECT clv, ROW_NUMBER() OVER (ORDER BY entry_timestamp DESC) AS rn
            FROM real_paper_snapshots
            WHERE sport_slug = 'baseball'
              AND league_slug = 'mlb'
              AND market_type = 'moneyline_2way'
              AND entry_odds >= 2.0100
              AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
          ) x
        ),
        open_plus AS (
          SELECT
            rps.id,
            rps.match_id,
            rps.sport_slug,
            rps.league_slug,
            rps.model_name,
            rps.market_type,
            rps.pick,
            home_team.name AS home_team_name,
            away_team.name AS away_team_name,
            CONCAT(home_team.name, ' vs ', away_team.name) AS match,
            rps.bookmaker,
            rps.entry_odds,
            rps.model_probability,
            rps.expected_value,
            rps.status,
            rps.entry_timestamp,
            home_team.name AS home_team_name,
            away_team.name AS away_team_name,
            latest.quality_score,
            latest.captured_at AS latest_snapshot_at,
            latest.book_count,
            ROW_NUMBER() OVER (
              PARTITION BY rps.match_id
              ORDER BY rps.expected_value DESC NULLS LAST, rps.model_probability DESC NULLS LAST, rps.entry_timestamp DESC, rps.id DESC
            ) AS exposure_rank,
            exposure.open_exposure_count AS raw_open_exposure_count,
            CASE
              WHEN ROW_NUMBER() OVER (
                PARTITION BY rps.match_id
                ORDER BY rps.expected_value DESC NULLS LAST, rps.model_probability DESC NULLS LAST, rps.entry_timestamp DESC, rps.id DESC
              ) = 1 THEN 0
              ELSE exposure.open_exposure_count
            END AS open_exposure_count,
            recent.recent_clv_10,
            recent.recent_clv_20,
            CASE WHEN latest.captured_at IS NOT NULL AND latest.captured_at < NOW() - INTERVAL '24 hours' THEN true ELSE false END AS is_stale,
            CASE WHEN latest.quality_score IS NOT NULL AND latest.quality_score < 80 THEN true ELSE false END AS suspicious_provider
          FROM real_paper_snapshots rps
          JOIN v_valid_matches m ON m.id = rps.match_id
          LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'home'
          LEFT JOIN teams home_team ON home_team.id = mh.team_id
          LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'away'
          LEFT JOIN teams away_team ON away_team.id = ma.team_id
          CROSS JOIN recent
          LEFT JOIN LATERAL (
            SELECT
              os.quality_score,
              os.captured_at,
              COUNT(*) OVER (PARTITION BY os.market_quote_id) AS book_count
            FROM odds_snapshots os
            WHERE os.market_quote_id = rps.market_quote_id
              AND os.selection = rps.pick
            ORDER BY os.captured_at DESC
            LIMIT 1
          ) latest ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS open_exposure_count
            FROM real_paper_snapshots other
            WHERE other.match_id = rps.match_id
              AND other.id <> rps.id
              AND other.status IN ('OPEN', 'PENDING_CLOSING')
          ) exposure ON true
          WHERE rps.sport_slug = 'baseball'
            AND rps.league_slug = 'mlb'
            AND rps.market_type = 'moneyline_2way'
            AND rps.status = 'OPEN'
            AND rps.entry_odds >= 2.0100
            AND rps.expected_value >= 0.05
            AND rps.model_probability >= 0.55
            AND COALESCE(latest.quality_score, 0) >= 80
            AND COALESCE(recent.recent_clv_10, 0) >= 0
        )
        SELECT
          *,
          'UNDERDOG_PLUS_PAPER' AS audit_status,
          false AS allow_real_bet,
          true AS allow_real_paper,
          ARRAY_REMOVE(ARRAY[
            CASE WHEN entry_odds < 2.0100 THEN 'odds_below_promotable_band' END,
            CASE WHEN expected_value < 0.05 THEN 'ev_below_5' END,
            CASE WHEN model_probability < 0.55 THEN 'prob_below_55' END,
            CASE WHEN COALESCE(quality_score, 0) < 80 THEN 'provider_score_below_80' END,
            CASE WHEN is_stale THEN 'stale_line' END,
            CASE WHEN suspicious_provider THEN 'suspicious_provider' END,
            CASE WHEN COALESCE(open_exposure_count, 0) > 0 THEN 'duplicate_match_exposure' END,
            CASE WHEN COALESCE(recent_clv_10, 0) < 0 THEN 'recent_clv_10_negative' END
          ], NULL) AS blocking_rules,
          CASE
            WHEN is_stale OR suspicious_provider OR COALESCE(open_exposure_count, 0) > 0 THEN 'REVIEW_ONLY'
            WHEN COALESCE(book_count, 0) <= 1 THEN 'REAL_PAPER_ONLY_SINGLE_BOOK_PENALTY'
            ELSE 'REAL_PAPER_ONLY'
          END AS recommendation
        FROM open_plus
        ORDER BY expected_value DESC, model_probability DESC
        LIMIT 50
      `
    );

    return {
      count: rulesResult.rows.length,
      rows: rulesResult.rows,
      candidates_count: candidatesResult.rows.length,
      candidates: candidatesResult.rows,
      best_rule: rulesResult.rows[0] || null,
      base_rule: rulesResult.rows.find((row) => row.rule_key === "mlb_underdog_ev5_base") || null,
      guardrails: {
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true
      }
    };
  }

  function isFreshOperationalRow(row: Record<string, any>) {
    const snapshotStatus = String(row.snapshot_status || row.status || "");
    const lineAgeSeconds = Number(row.line_age_seconds || 0);
    const openExposure = Number(row.open_exposure_count || 0);
    const exposureRank = Number(row.exposure_rank || 1);
    const qualityScore = Number(row.quality_score || row.provider_score || 100);
    const blockedReasons = [
      ...(row.reasons_blocked || []),
      ...(row.conflict_reasons || []),
      ...(row.warnings || []),
      ...(row.flags || [])
    ].map((reason) => String(reason));

    return !["EXPIRED", "STALE_ARCHIVED", "WIN", "LOSS", "PUSH", "SETTLED"].includes(snapshotStatus)
      && row.is_stale !== true
      && lineAgeSeconds <= 24 * 60 * 60
      && exposureRank === 1
      && openExposure === 0
      && qualityScore >= 80
      && !blockedReasons.some((reason) => ["stale_line", "duplicate_match_exposure", "suspicious_move", "provider_suspicious"].includes(reason));
  }

  async function buildFreshCandidateInbox() {
    const [matchup, teamIntel] = await Promise.all([buildMatchupConfirmation(), buildTeamIntelligence()]);
    const teamIntelById = new Map<string, Record<string, any>>();
    for (const row of (teamIntel.rows || []) as Array<Record<string, any>>) {
      if (row.id) teamIntelById.set(String(row.id), row);
    }

    const rows = (matchup.rows || [])
      .filter((row: Record<string, any>) => row.sport_slug === "baseball" && row.league_slug === "mlb" && row.market_type === "moneyline_2way")
      .map((row: Record<string, any>) => {
        const intel = teamIntelById.get(String(row.id)) || {};
        const fresh = isFreshOperationalRow(row);
        const finalStatus = String(row.final_operational_status || row.decision || "REVIEW");
        const matchupStatus = String(row.matchup_status || intel.intelligence_status || "UNKNOWN");
        const teamStatus = String(intel.intelligence_status || "NO_TEAM_INTEL");
        const candidateTier = finalStatus === "BETTABLE_PAPER_CONFIRMED"
          ? "CONFIRMED_PAPER"
          : row.decision === "BETTABLE_PAPER" || row.underdog_plus_status === "UNDERDOG_PLUS_PAPER"
            ? "PAPER_CANDIDATE_REVIEW"
            : fresh
              ? "FRESH_REVIEW"
              : "ARCHIVE_OR_WAIT";
        const blocking = [
          ...(row.reasons_blocked || []),
          ...(row.conflict_reasons || []),
          ...(row.warnings || []),
          ...(row.flags || []),
          ...(intel.missing_context || []).map((item: string) => `missing_${item}`)
        ].filter(Boolean).map(String);
        const recommendation = !fresh
          ? "No usar: no cumple frescura, provider, stale o exposure. Mantener fuera del inbox operativo."
          : finalStatus === "BETTABLE_PAPER_CONFIRMED"
            ? "Solo Real Paper: revisar manualmente y monitorear closing. No dinero real."
            : teamStatus === "MATCHUP_CONTEXT_SUPPORTS" || teamStatus === "PARTIAL_CONTEXT_REVIEW"
              ? "Candidato fresco para revision paper; esperar cierre y CLV."
              : "Candidato fresco pero con contexto incompleto/conflicto; no confirmar.";

        return {
          id: row.id,
          match: row.match || `${row.home_team_name || "Home"} vs ${row.away_team_name || "Away"}`,
          pick: row.pick,
          status: row.snapshot_status || row.status,
          candidate_tier: candidateTier,
          final_operational_status: finalStatus,
          decision: row.decision,
          underdog_plus_status: row.underdog_plus_status,
          matchup_status: matchupStatus,
          team_intelligence_status: teamStatus,
          context_completeness_score: intel.context_completeness_score ?? null,
          team_matchup_score: intel.team_matchup_score ?? null,
          entry_odds: row.entry_odds,
          model_probability: row.model_probability,
          expected_value: row.expected_value,
          line_age_seconds: row.line_age_seconds,
          latest_snapshot_at: row.latest_snapshot_at || row.captured_at || null,
          provider: row.provider_name || row.bookmaker,
          quality_score: row.quality_score,
          edge_grade: row.edge_grade || row.grade,
          is_fresh_operational: fresh,
          blocking_reasons: [...new Set(blocking)],
          recommendation,
          real_paper_only: true,
          allow_real_money: false
        };
      })
      .filter((row: Record<string, any>) => row.is_fresh_operational || ["CONFIRMED_PAPER", "PAPER_CANDIDATE_REVIEW", "FRESH_REVIEW"].includes(row.candidate_tier))
      .sort((a: Record<string, any>, b: Record<string, any>) => {
        const rank = (tier: string) => ({ CONFIRMED_PAPER: 0, PAPER_CANDIDATE_REVIEW: 1, FRESH_REVIEW: 2, ARCHIVE_OR_WAIT: 9 }[tier] ?? 9);
        return rank(String(a.candidate_tier)) - rank(String(b.candidate_tier)) || Number(b.expected_value || 0) - Number(a.expected_value || 0);
      });

    return {
      system_status: "FRESH_CANDIDATE_INBOX_READ_ONLY",
      count: rows.length,
      fresh_count: rows.filter((row: Record<string, any>) => row.is_fresh_operational).length,
      confirmed_paper_count: rows.filter((row: Record<string, any>) => row.candidate_tier === "CONFIRMED_PAPER").length,
      review_candidate_count: rows.filter((row: Record<string, any>) => row.candidate_tier === "PAPER_CANDIDATE_REVIEW").length,
      rows: rows.slice(0, 50),
      recommendation: rows.some((row: Record<string, any>) => row.is_fresh_operational)
        ? "Revisar candidatos frescos uno por uno. Sigue Real Paper only."
        : "No hay candidato fresco limpio; correr entry fresco o esperar nuevos mercados.",
      guardrails: {
        read_only: true,
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true
      }
    };
  }

  async function buildRuleConfidence() {
    const lab = await buildUnderdogLab();
    const rows = (lab.rows || []).map((row: Record<string, any>) => {
      const closed = Number(row.closed || 0);
      const profit = Number(row.profit_units || 0);
      const avgClv = Number(row.avg_clv || 0);
      const recentClv = Number(row.recent_clv_20 ?? row.recent_clv_10 ?? 0);
      const drawdown = Number(row.max_drawdown || 0);
      const brier = row.brier === null || row.brier === undefined ? null : Number(row.brier);
      const stableRecent = recentClv >= 0 && Number(row.recent_profit_20 || 0) >= 0;
      const confidenceScore = Math.max(0, Math.min(100,
        (closed >= 75 ? 25 : closed >= 50 ? 20 : closed >= 30 ? 12 : 4)
        + (profit > 0 ? 20 : -10)
        + (avgClv > 0 ? 20 : -15)
        + (stableRecent ? 15 : -5)
        + (brier !== null && brier <= 0.24 ? 10 : brier !== null && brier <= 0.28 ? 5 : 0)
        + (drawdown <= Math.max(500, Math.abs(profit) * 0.6) ? 10 : 0)
      ));
      const confidenceStatus = closed < 30
        ? "INSUFFICIENT_SAMPLE"
        : confidenceScore >= 75
          ? "HIGH_CONFIDENCE_WATCH"
          : confidenceScore >= 60
            ? "WATCH"
            : confidenceScore >= 45
              ? "COOLING_REVIEW"
              : "REJECT_OR_ACCUMULATE";
      return {
        rule_key: row.rule_key,
        rule_name: row.rule_name,
        closed,
        wins: row.wins,
        losses: row.losses,
        win_rate: row.win_rate,
        profit_units: row.profit_units,
        avg_clv: row.avg_clv,
        recent_clv_10: row.recent_clv_10,
        recent_clv_20: row.recent_clv_20,
        recent_profit_20: row.recent_profit_20,
        brier: row.brier,
        max_drawdown: row.max_drawdown,
        confidence_score: confidenceScore,
        confidence_status: confidenceStatus,
        recommendation: confidenceStatus === "HIGH_CONFIDENCE_WATCH"
          ? "Regla candidata a watchlist premium en Real Paper. No autoriza dinero real."
          : confidenceStatus === "WATCH"
            ? "Seguir midiendo; profit/CLV acompanian parcialmente."
            : confidenceStatus === "COOLING_REVIEW"
              ? "No promover; revisar estabilidad reciente y drawdown."
              : "Muestra insuficiente o edge debil; acumular sin promover.",
        real_paper_only: true
      };
    }).sort((a: Record<string, any>, b: Record<string, any>) => Number(b.confidence_score || 0) - Number(a.confidence_score || 0));

    return {
      system_status: "RULE_CONFIDENCE_READ_ONLY",
      count: rows.length,
      high_confidence_count: rows.filter((row: Record<string, any>) => row.confidence_status === "HIGH_CONFIDENCE_WATCH").length,
      rows,
      best_rule: rows[0] || null,
      recommendation: rows.some((row: Record<string, any>) => row.confidence_status === "HIGH_CONFIDENCE_WATCH")
        ? "Hay regla fuerte para seguir en Real Paper; requiere pick fresco confirmado antes de piloto."
        : "Aun no hay regla suficiente para piloto; seguir midiendo profit, CLV y estabilidad.",
      guardrails: {
        read_only: true,
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true
      }
    };
  }

  async function buildWalkForwardBacktest() {
    const result = await db.query(
      `
        WITH params AS (
          SELECT *
          FROM (VALUES
            ('mlb_moneyline_all'::text, 'MLB Moneyline All', 0.00::numeric, 0.00::numeric, 1.0100::numeric, 100.00::numeric, 'any'::text),
            ('mlb_underdog_ev5_base', 'Underdog EV >=5%', 0.00, 0.05, 2.0100, 100.00, 'any'),
            ('mlb_underdog_plus_prob55', 'Underdog Plus prob >=55', 0.55, 0.05, 2.0100, 100.00, 'any'),
            ('mlb_underdog_home', 'Home Underdogs', 0.00, 0.05, 2.0100, 100.00, 'home'),
            ('mlb_underdog_away', 'Away Underdogs', 0.00, 0.05, 2.0100, 100.00, 'away'),
            ('mlb_model_60_plus_ev5', 'Model 60+ EV >=5%', 0.60, 0.05, 1.0100, 100.00, 'any')
          ) AS p(rule_key, rule_name, min_model_probability, min_ev, min_odds, max_odds, pick_filter)
        ),
        matched AS (
          SELECT
            p.*,
            rps.*,
            ROW_NUMBER() OVER (PARTITION BY p.rule_key ORDER BY rps.entry_timestamp, rps.id) AS sample_index,
            COUNT(*) OVER (PARTITION BY p.rule_key) AS total_samples
          FROM params p
          JOIN real_paper_snapshots rps
            ON rps.sport_slug = 'baseball'
           AND rps.league_slug = 'mlb'
           AND rps.market_type = 'moneyline_2way'
           AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
           AND rps.model_probability >= p.min_model_probability
           AND rps.expected_value >= p.min_ev
           AND rps.entry_odds >= p.min_odds
           AND rps.entry_odds <= p.max_odds
           AND (p.pick_filter = 'any' OR rps.pick = p.pick_filter)
        ),
        phased AS (
          SELECT
            *,
            CASE
              WHEN sample_index <= CEIL(total_samples * 0.60) THEN 'DISCOVERY'
              ELSE 'VALIDATION'
            END AS phase
          FROM matched
        ),
        grouped AS (
          SELECT
            rule_key,
            rule_name,
            phase,
            MAX(total_samples)::int AS total_samples,
            COUNT(*)::int AS closed,
            COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
            COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
            ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
            ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
            ROUND(AVG(POWER((CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) - model_probability, 2))::numeric, 6) AS brier,
            CASE WHEN COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS')) > 0
              THEN ROUND((COUNT(*) FILTER (WHERE status = 'WIN')::numeric / COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS'))), 6)
              ELSE NULL
            END AS win_rate
          FROM phased
          GROUP BY rule_key, rule_name, phase
        ),
        pivoted AS (
          SELECT
            d.rule_key,
            d.rule_name,
            d.total_samples,
            d.closed AS discovery_closed,
            d.wins AS discovery_wins,
            d.losses AS discovery_losses,
            d.win_rate AS discovery_win_rate,
            d.profit_units AS discovery_profit,
            d.avg_clv AS discovery_clv,
            d.brier AS discovery_brier,
            COALESCE(v.closed, 0)::int AS validation_closed,
            COALESCE(v.wins, 0)::int AS validation_wins,
            COALESCE(v.losses, 0)::int AS validation_losses,
            v.win_rate AS validation_win_rate,
            COALESCE(v.profit_units, 0)::numeric AS validation_profit,
            v.avg_clv AS validation_clv,
            v.brier AS validation_brier
          FROM grouped d
          LEFT JOIN grouped v ON v.rule_key = d.rule_key AND v.phase = 'VALIDATION'
          WHERE d.phase = 'DISCOVERY'
        )
        SELECT
          *,
          CASE
            WHEN total_samples < 30 THEN 'INSUFFICIENT_SAMPLE'
            WHEN validation_closed < 10 THEN 'VALIDATION_TOO_SMALL'
            WHEN validation_profit > 0 AND COALESCE(validation_clv, 0) > 0 THEN 'WALK_FORWARD_PASS'
            WHEN validation_profit > 0 AND COALESCE(validation_clv, 0) <= 0 THEN 'PROFIT_WITH_CLV_REVIEW'
            WHEN validation_profit <= 0 AND COALESCE(validation_clv, 0) > 0 THEN 'CLV_WITH_PROFIT_REVIEW'
            ELSE 'WALK_FORWARD_FAIL'
          END AS walk_forward_status,
          CASE
            WHEN total_samples < 30 THEN 'Muestra total chica; no usar para decision.'
            WHEN validation_closed < 10 THEN 'Validacion posterior chica; seguir acumulando.'
            WHEN validation_profit > 0 AND COALESCE(validation_clv, 0) > 0 THEN 'La regla sobrevive fuera de discovery en Real Paper. Aun no autoriza dinero real.'
            WHEN validation_profit > 0 AND COALESCE(validation_clv, 0) <= 0 THEN 'Gana en validation pero CLV no apoya; mantener en review.'
            WHEN validation_profit <= 0 AND COALESCE(validation_clv, 0) > 0 THEN 'CLV apoya pero profit no; puede requerir mas muestra.'
            ELSE 'No promover: validation no confirma.'
          END AS recommendation
        FROM pivoted
        ORDER BY
          CASE
            WHEN validation_profit > 0 AND COALESCE(validation_clv, 0) > 0 THEN 0
            WHEN validation_profit > 0 THEN 1
            ELSE 2
          END,
          validation_profit DESC,
          validation_clv DESC NULLS LAST
      `
    );

    return {
      system_status: "WALK_FORWARD_BACKTEST_READ_ONLY",
      count: result.rows.length,
      pass_count: result.rows.filter((row: Record<string, any>) => row.walk_forward_status === "WALK_FORWARD_PASS").length,
      rows: result.rows,
      recommendation: result.rows.some((row: Record<string, any>) => row.walk_forward_status === "WALK_FORWARD_PASS")
        ? "Hay reglas que sobreviven validation; seguir en Real Paper y exigir pick fresco confirmado."
        : "Ninguna regla pasa walk-forward de forma plena todavia; seguir acumulando.",
      guardrails: {
        read_only: true,
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true
      }
    };
  }

  async function buildPilotReadinessGate() {
    const [command, inbox, pending, ruleConfidence, market] = await Promise.all([
      buildCommandCenter(),
      buildFreshCandidateInbox(),
      buildPendingSettlementMonitor(),
      buildRuleConfidence(),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED'))::int AS closed,
          ROUND((COALESCE(SUM(profit_loss), 0) / 100.0)::numeric, 4) AS profit_units,
          ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv
        FROM real_paper_snapshots
        WHERE sport_slug = 'baseball'
          AND league_slug = 'mlb'
          AND market_type = 'moneyline_2way'
          AND duplicate_of_id IS NULL
          AND COALESCE(data_state, 'FRESH') IN ('FRESH', 'ARCHIVED')
      `)
    ]);

    const marketRow = market.rows[0] || {};
    const confirmedFresh = Number(inbox.confirmed_paper_count || 0);
    const freshCount = Number(inbox.fresh_count || 0);
    const closed = Number(marketRow.closed || 0);
    const avgClv = Number(marketRow.avg_clv || 0);
    const profit = Number(marketRow.profit_units || 0);
    const staleOpen = Number((pending.summary || {}).open || 0) + Number((pending.summary || {}).pending_closing || 0);
    const highConfidenceRules = Number(ruleConfidence.high_confidence_count || 0);
    const rows = [
      {
        gate: "Real Money",
        passed: command.real_money_enabled === false,
        value: command.real_money_enabled ? "ON" : "OFF",
        requirement: "Debe estar OFF hasta autorizacion explicita.",
        severity: command.real_money_enabled ? "CRITICAL" : "OK",
        recommendation: "Mantener dinero real apagado."
      },
      {
        gate: "Fresh Confirmed Candidate",
        passed: confirmedFresh > 0,
        value: `${confirmedFresh} confirmed / ${freshCount} fresh`,
        requirement: "Necesitamos al menos 1 BETTABLE_PAPER_CONFIRMED fresco.",
        severity: confirmedFresh > 0 ? "OK" : "INFO",
        recommendation: confirmedFresh > 0 ? "Revisar manualmente el candidato confirmado en paper." : "Esperar candidato fresco con matchup y riesgo alineados."
      },
      {
        gate: "CLV Rule",
        passed: closed >= 75 && avgClv > 0 && profit > 0,
        value: `${closed} closed / CLV ${avgClv} / profit ${profit}`,
        requirement: "75+ cerradas, profit positivo y CLV positivo.",
        severity: closed >= 75 && avgClv > 0 && profit > 0 ? "OK" : "HIGH",
        recommendation: "Seguir midiendo CLV; si cae negativo, no promover."
      },
      {
        gate: "Rule Confidence",
        passed: highConfidenceRules > 0,
        value: `${highConfidenceRules} high-confidence rules`,
        requirement: "Al menos una regla estable con muestra, profit y CLV.",
        severity: highConfidenceRules > 0 ? "OK" : "MEDIUM",
        recommendation: highConfidenceRules > 0 ? "Usar solo como watchlist Real Paper." : "Seguir acumulando y correr walk-forward."
      },
      {
        gate: "Stale/Open Cleanup",
        passed: staleOpen === 0,
        value: `${staleOpen} open/pending`,
        requirement: "No debe haber OPEN viejo contaminando decision.",
        severity: staleOpen === 0 ? "OK" : "MEDIUM",
        recommendation: staleOpen === 0 ? "Limpio." : "Correr ForceClosing y stale archive dry-run antes de decidir."
      },
      {
        gate: "Kill Switch",
        passed: command.kill_switch_enabled === true,
        value: command.kill_switch_enabled ? "ACTIVE" : "OFF",
        requirement: "Kill switch activo para mantener piloto bloqueado.",
        severity: command.kill_switch_enabled ? "OK" : "CRITICAL",
        recommendation: "No operar sin kill switch."
      }
    ];

    const hardPass = rows.every((row) => row.gate === "Fresh Confirmed Candidate" ? true : row.passed);
    const finalState = command.real_candidate_count > 0 || command.real_money_enabled
      ? "STOP_REAL_MONEY_GUARDRAIL_BREACH"
      : hardPass && confirmedFresh > 0
        ? "PILOT_READY_BUT_LOCKED"
        : hardPass
          ? "REVIEW_ONLY_WAITING_FOR_FRESH_CONFIRMED_PICK"
          : "NO_REAL_MONEY_REVIEW_ONLY";

    return {
      system_status: "PILOT_READINESS_GATE_SAFE",
      final_state: finalState,
      action: finalState === "PILOT_READY_BUT_LOCKED" ? "MANUAL_REVIEW_ONLY" : "WAIT_OR_REVIEW",
      rows,
      summary: {
        fresh_candidate_count: freshCount,
        confirmed_fresh_candidate_count: confirmedFresh,
        high_confidence_rule_count: highConfidenceRules,
        closed,
        avg_clv: avgClv,
        profit_units: profit,
        stale_or_pending_open: staleOpen
      },
      guardrails: {
        real_candidate_count: command.real_candidate_count || 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        kill_switch_enabled: true
      },
      recommendation: finalState === "PILOT_READY_BUT_LOCKED"
        ? "Sistema listo para revision de piloto, pero bloqueado. No dinero real sin autorizacion explicita."
        : "Seguir Real Paper: falta candidato fresco confirmado o limpieza/validacion adicional."
    };
  }

  async function buildRealPilotSimulator() {
    const [inbox, ruleConfidence] = await Promise.all([buildFreshCandidateInbox(), buildRuleConfidence()]);
    const bankrollUnits = 10000;
    const maxStakePerPickUnits = bankrollUnits * 0.0025;
    const maxDailyStakeUnits = bankrollUnits * 0.01;
    const stopLossUnits = -bankrollUnits * 0.01;
    const rows = (inbox.rows || [])
      .filter((row: Record<string, any>) => row.is_fresh_operational)
      .slice(0, 10)
      .map((row: Record<string, any>, index: number) => {
        const stakeUnits = Math.min(maxStakePerPickUnits, maxDailyStakeUnits / Math.max(1, Math.min(4, inbox.fresh_count || 1)));
        return {
          simulation_rank: index + 1,
          match: row.match,
          pick: row.pick,
          candidate_tier: row.candidate_tier,
          entry_odds: row.entry_odds,
          model_probability: row.model_probability,
          expected_value: row.expected_value,
          simulated_stake_units: Number(stakeUnits.toFixed(2)),
          worst_case_daily_exposure_units: Number(Math.min(maxDailyStakeUnits, stakeUnits * (index + 1)).toFixed(2)),
          manual_confirmation_required: true,
          real_money_allowed: false,
          recommendation: "Simulacion solamente. No ejecutar dinero real."
        };
      });

    return {
      system_status: "REAL_PILOT_SIMULATOR_LOCKED",
      simulation_state: rows.length ? "SIMULATED_FRESH_CANDIDATES" : "NO_FRESH_CANDIDATES",
      bankroll_units: bankrollUnits,
      max_stake_per_pick_units: maxStakePerPickUnits,
      max_daily_stake_units: maxDailyStakeUnits,
      stop_loss_units: stopLossUnits,
      manual_confirmation_required: true,
      kill_switch_enabled: true,
      best_rule: ruleConfidence.best_rule || null,
      rows,
      recommendation: rows.length
        ? "Usar esto para estimar exposicion manual futura. Sigue bloqueado."
        : "Sin candidatos frescos; no hay nada que simular hoy.",
      guardrails: {
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        parlays_real_enabled: false
      }
    };
  }

  async function buildSportsIntelligenceLiveBoard(rawQuery: unknown = {}) {
    const query = z.object({ date: z.string().optional() }).parse(rawQuery);
    const { selectedDate, start, end } = localDateWindow(query.date);

    const [
      confirmedPickChain,
      pendingSettlement,
      footballUniverse,
      footballPending,
      intelligenceScout,
      playerIntelligence,
      footballFixtures,
      mlbSnapshotMatches
    ] = await Promise.all([
      buildConfirmedPickChain(),
      buildPendingSettlementMonitor(),
      getFootballTodayUniverse(db, selectedDate),
      getFootballPendingSettlementMonitor(db),
      buildIntelligenceScout(),
      buildPlayerIntelligence(),
      db.query(
        `
          SELECT
            m.id AS match_id,
            m.match_date AS start_time,
            m.status,
            l.slug AS league_id,
            l.name AS league_name,
            home_team.name AS home_team,
            away_team.name AS away_team,
            m.raw_data
          FROM v_valid_matches m
          JOIN leagues l ON l.id = m.league_id
          LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
          LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
          LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
          LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
          WHERE m.raw_data->>'football_today_universe' = 'true'
            AND m.match_date >= $1::timestamptz
            AND m.match_date < $2::timestamptz
          ORDER BY m.match_date ASC
          LIMIT 200
        `,
        [start, end]
      ),
      db.query(
        `
          SELECT DISTINCT ON (rps.match_id)
            rps.match_id,
            rps.entry_timestamp AS start_time,
            rps.status,
            rps.pick,
            rps.entry_odds,
            rps.closing_odds,
            rps.model_probability,
            rps.expected_value,
            rps.bookmaker,
            home_team.name AS home_team,
            away_team.name AS away_team
          FROM real_paper_snapshots rps
          LEFT JOIN v_valid_matches m ON m.id = rps.match_id
          LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
          LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
          LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
          LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
          WHERE rps.sport_slug = 'baseball'
            AND rps.league_slug = 'mlb'
            AND (
              rps.status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT')
              OR (rps.entry_timestamp >= $1::timestamptz AND rps.entry_timestamp < $2::timestamptz)
            )
          ORDER BY rps.match_id, rps.entry_timestamp DESC
          LIMIT 100
        `,
        [start, end]
      )
    ]);

    const scoutRows = Array.isArray((intelligenceScout as Record<string, any>).rows) ? (intelligenceScout as Record<string, any>).rows : [];
    const playerRows = Array.isArray((playerIntelligence as Record<string, any>).rows) ? (playerIntelligence as Record<string, any>).rows : [];
    const chainRows = Array.isArray((confirmedPickChain as Record<string, any>).rows) ? (confirmedPickChain as Record<string, any>).rows : [];

    const scoutByMatch = new Map<string, Record<string, any>[]>();
    for (const row of scoutRows) {
      const key = String(row.match_id || "");
      if (!key) continue;
      if (!scoutByMatch.has(key)) scoutByMatch.set(key, []);
      scoutByMatch.get(key)!.push(row);
    }
    const playerByMatch = new Map<string, Record<string, any>[]>();
    for (const row of playerRows) {
      const key = String(row.match_id || "");
      if (!key) continue;
      if (!playerByMatch.has(key)) playerByMatch.set(key, []);
      playerByMatch.get(key)!.push(row);
    }
    const chainByMatch = new Map<string, Record<string, any>>();
    for (const row of chainRows) {
      const key = String(row.match_id || "");
      if (key && !chainByMatch.has(key)) chainByMatch.set(key, row);
    }

    function matchStatus(input: Record<string, any>, fallback = "NO_DATA") {
      const chain = chainByMatch.get(String(input.match_id || ""));
      if (chain?.final_chain_status) return String(chain.final_chain_status);
      const scouts = scoutByMatch.get(String(input.match_id || "")) || [];
      if (scouts.some((row) => String(row.impact || "").includes("BLOCK"))) return "BLOCKED_BY_INTELLIGENCE";
      if (scouts.some((row) => String(row.recommendation || "").includes("MANUAL"))) return "MODEL_CONFLICT_REVIEW";
      return fallback;
    }

    function playerStatus(matchId: string) {
      const rows = playerByMatch.get(matchId) || [];
      if (!rows.length) return "NO_CONTEXT";
      if (rows.some((row) => row.player_intelligence_status === "BLOCK_CONFIRMATION")) return "BLOCK_CONFIRMATION";
      if (rows.some((row) => row.player_intelligence_status === "MANUAL_REVIEW")) return "PARTIAL_CONTEXT_REVIEW";
      if (rows.some((row) => row.player_intelligence_status === "SUPPORTS_PICK")) return "MATCHUP_CONTEXT_SUPPORTS";
      return "OBSERVED";
    }

    const mlbMatches = mlbSnapshotMatches.rows.map((row: Record<string, any>) => {
      const chain = chainByMatch.get(String(row.match_id || ""));
      return {
        match_id: row.match_id,
        sport: "baseball",
        league_id: "mlb",
        league_name: "MLB",
        start_time: row.start_time,
        status: row.status || "paper_snapshot",
        home_team: row.home_team || "Home",
        away_team: row.away_team || "Away",
        home_score: null,
        away_score: null,
        recommended_pick: chain?.pick || row.pick || null,
        odds: chain?.odds ?? row.entry_odds ?? null,
        expected_value: chain?.expected_value ?? row.expected_value ?? null,
        provider: chain?.provider || row.bookmaker || null,
        final_chain_status: matchStatus(row, "VALUE_ONLY_REVIEW"),
        intelligence_status: chain?.intelligence_status || matchStatus(row, "NO_CONTEXT"),
        player_intelligence_status: chain?.player_intelligence_status || playerStatus(String(row.match_id || "")),
        settlement_status: row.status || "NONE",
        recommended_action: chain?.recommendation || "Revisar cadena completa; sigue Real Paper only.",
        detail: {
          model_probability: chain?.model_probability ?? row.model_probability ?? null,
          freshness_status: chain?.freshness_status || null,
          duplicate_status: chain?.duplicate_status || null,
          high_ev_status: chain?.high_ev_status || null,
          missing_context_fields: chain?.missing_context_fields || [],
          block_confirmation_reasons: chain?.block_confirmation_reasons || []
        }
      };
    });

    const footballMatches = footballFixtures.rows.map((row: Record<string, any>) => {
      const raw = row.raw_data && typeof row.raw_data === "object" ? row.raw_data as Record<string, any> : {};
      const status = String(row.status || raw.status || "scheduled");
      return {
        match_id: row.match_id,
        sport: "soccer",
        league_id: row.league_id,
        league_name: row.league_name || row.league_id,
        start_time: row.start_time,
        status,
        home_team: row.home_team || "Home",
        away_team: row.away_team || "Away",
        home_score: raw.home_score ?? null,
        away_score: raw.away_score ?? null,
        recommended_pick: null,
        odds: null,
        expected_value: null,
        provider: raw.source || null,
        final_chain_status: "OBSERVATION_ONLY",
        intelligence_status: "SOURCE_CONSENSUS_REQUIRED",
        player_intelligence_status: "NO_CONTEXT",
        settlement_status: status === "finished" ? "READY_FOR_FOOTBALL_SETTLEMENT_REVIEW" : "NONE",
        recommended_action: "Mantener OBSERVATION_ONLY hasta tener odds, timestamp, modelo y EV.",
        detail: {
          source: raw.source || null,
          source_consensus: raw.source_consensus || false,
          kickoff_original: raw.kickoff_original || null,
          observation_only_league: raw.observation_only_league ?? true
        }
      };
    });

    const matches = [...mlbMatches, ...footballMatches].sort((a, b) => {
      const left = new Date(String(a.start_time || 0)).getTime();
      const right = new Date(String(b.start_time || 0)).getTime();
      return left - right;
    });

    const alerts = [
      ...(Number((confirmedPickChain as Record<string, any>).blocked_by_intelligence || 0) > 0
        ? [`${(confirmedPickChain as Record<string, any>).blocked_by_intelligence} pick(s) bloqueados por inteligencia.`]
        : []),
      ...(Number((pendingSettlement as Record<string, any>).summary?.open || 0) > 0
        ? [`${(pendingSettlement as Record<string, any>).summary.open} MLB Real Paper abiertos.`]
        : []),
      ...(Number((footballPending as Record<string, any>).pending_results || 0) > 0
        ? [`${(footballPending as Record<string, any>).pending_results} fútbol pendientes de resultado.`]
        : []),
      ...(Number((footballUniverse as Record<string, any>).observed_fixtures || 0) > 0
        ? [`${(footballUniverse as Record<string, any>).observed_fixtures} fixtures de fútbol observados hoy.`]
        : [])
    ];

    const leagueMap = new Map<string, Record<string, any>>();
    for (const match of matches) {
      const key = `${match.sport}:${match.league_id}`;
      const current = leagueMap.get(key) || {
        sport: match.sport,
        league_id: match.league_id,
        league_name: match.league_name,
        games_today: 0,
        review: 0,
        blocked: 0,
        confirmed_paper: 0,
        pending_settlement: 0
      };
      current.games_today += 1;
      if (String(match.final_chain_status).includes("CONFIRMED")) current.confirmed_paper += 1;
      if (String(match.final_chain_status).includes("BLOCKED")) current.blocked += 1;
      if (String(match.final_chain_status).includes("REVIEW") || String(match.final_chain_status).includes("VALUE")) current.review += 1;
      if (String(match.settlement_status).includes("PENDING") || String(match.settlement_status).includes("READY")) current.pending_settlement += 1;
      leagueMap.set(key, current);
    }

    const summary = {
      games_today: matches.length,
      confirmed_paper: matches.filter((match) => String(match.final_chain_status).includes("CONFIRMED")).length,
      review: matches.filter((match) => String(match.final_chain_status).includes("REVIEW") || String(match.final_chain_status).includes("VALUE")).length,
      blocked: matches.filter((match) => String(match.final_chain_status).includes("BLOCKED")).length,
      pending_settlement: matches.filter((match) => String(match.settlement_status).includes("PENDING") || String(match.settlement_status).includes("READY")).length
    };

    return {
      date: selectedDate,
      system_status: "SPORTS_INTELLIGENCE_LIVE_BOARD_SAFE",
      view_mode: "LIVESCORE_STYLE_READ_ONLY",
      summary,
      alerts,
      leagues: Array.from(leagueMap.values()).sort((a, b) => Number(b.games_today) - Number(a.games_today)),
      matches,
      recommendation: summary.confirmed_paper > 0
        ? "Hay candidato confirmado en paper; revisar detalle y mantener sin dinero real."
        : "No hay confirmado paper; usar Live Board para ver bloqueos, observaciones y pendientes sin forzar picks.",
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        shadow_paper_only_for_football: true,
        kill_switch_enabled: true
      }
    };
  }


  async function buildMatchCenter(rawQuery: unknown = {}) {
    const query = z.object({
      date: z.string().optional(),
      fallback_recent: booleanQuery(false),
      sport: z.string().min(1).max(40).optional(),
      league_id: z.string().min(1).max(120).optional(),
      match_id: z.string().min(1).max(120).optional(),
      status: z.string().min(1).max(80).optional(),
      only_active: booleanQuery(false),
      only_review: booleanQuery(false),
      only_confirmed_paper: booleanQuery(false)
    }).parse(rawQuery);
    const requestedSport = query.sport?.toLowerCase();
    const normalizedSport = requestedSport === "football" || requestedSport === "soccer"
      ? "soccer"
      : requestedSport === "mlb" || requestedSport === "baseball"
        ? "baseball"
        : requestedSport;

    const mlbTeamNames: Record<string, string> = {
      angels: "Los Angeles Angels",
      astros: "Houston Astros",
      athletics: "Athletics",
      "blue-jays": "Toronto Blue Jays",
      braves: "Atlanta Braves",
      brewers: "Milwaukee Brewers",
      cardinals: "St. Louis Cardinals",
      cubs: "Chicago Cubs",
      diamondbacks: "Arizona Diamondbacks",
      dodgers: "Los Angeles Dodgers",
      giants: "San Francisco Giants",
      guardians: "Cleveland Guardians",
      mariners: "Seattle Mariners",
      marlins: "Miami Marlins",
      mets: "New York Mets",
      nationals: "Washington Nationals",
      orioles: "Baltimore Orioles",
      padres: "San Diego Padres",
      phillies: "Philadelphia Phillies",
      pirates: "Pittsburgh Pirates",
      rays: "Tampa Bay Rays",
      reds: "Cincinnati Reds",
      "red-sox": "Boston Red Sox",
      rangers: "Texas Rangers",
      rockies: "Colorado Rockies",
      royals: "Kansas City Royals",
      tigers: "Detroit Tigers",
      twins: "Minnesota Twins",
      "white-sox": "Chicago White Sox",
      yankees: "New York Yankees"
    };
    const resolveMlbTeamsFromSlug = (slug: string) => {
      const marker = "espn-mlb-";
      const tail = slug.includes(marker) ? slug.slice(slug.indexOf(marker) + marker.length) : slug;
      const withoutDate = tail.replace(/^\d{4}-\d{2}-\d{2}-/, "");
      const keys = Object.keys(mlbTeamNames).sort((a, b) => b.length - a.length);
      for (const homeSlug of keys) {
        const prefix = `${homeSlug}-`;
        if (!withoutDate.startsWith(prefix)) continue;
        const awaySlug = withoutDate.slice(prefix.length);
        if (mlbTeamNames[awaySlug]) {
          return { home_team: mlbTeamNames[homeSlug], away_team: mlbTeamNames[awaySlug] };
        }
      }
      return { home_team: slug, away_team: "TBD" };
    };

    const [initialLiveBoard, footballConfirmedChain] = await Promise.all([
      buildSportsIntelligenceLiveBoard({ date: query.date }),
      getFootballConfirmedPickChain(db)
    ]);
    let liveBoard = initialLiveBoard as Record<string, any>;
    const requestedDate = query.date || String((liveBoard as Record<string, any>).date || "");
    let dateFallbackApplied = false;
    if (
      query.fallback_recent &&
      !query.match_id &&
      !query.league_id &&
      !query.status &&
      Number((liveBoard as Record<string, any>).summary?.games_today || 0) === 0 &&
      requestedDate
    ) {
      for (const offset of [-1, 1]) {
        const fallbackDate = shiftLocalDate(requestedDate, offset);
        const fallbackBoard = await buildSportsIntelligenceLiveBoard({ date: fallbackDate });
        if (Number((fallbackBoard as Record<string, any>).summary?.games_today || 0) > 0) {
          liveBoard = {
            ...(fallbackBoard as Record<string, any>),
            requested_date: requestedDate,
            date_fallback_applied: true,
            fallback_reason: `No hay partidos para ${requestedDate}; mostrando slate cercano ${fallbackDate}.`
          };
          dateFallbackApplied = true;
          break;
        }
      }
    }
    const liveMatches = Array.isArray((liveBoard as Record<string, any>).matches)
      ? (liveBoard as Record<string, any>).matches as Array<Record<string, any>>
      : [];
    const footballChainRows = Array.isArray((footballConfirmedChain as Record<string, any>).rows)
      ? (footballConfirmedChain as Record<string, any>).rows as Array<Record<string, any>>
      : [];
    const footballChainByMatch = new Map<string, Record<string, any>>();
    for (const row of footballChainRows) {
      const key = String(row.match_id || "");
      if (key && !footballChainByMatch.has(key)) footballChainByMatch.set(key, row);
    }
    const enrichedLiveMatches = liveMatches.map((match) => {
      if (String(match.sport || "") !== "soccer") return match;
      const chain = footballChainByMatch.get(String(match.match_id || ""));
      if (!chain) return match;
      const detail = match.detail && typeof match.detail === "object" ? match.detail as Record<string, any> : {};
      return {
        ...match,
        recommended_pick: chain.pick && chain.pick !== "none" ? chain.pick : match.recommended_pick,
        odds: chain.odds ?? match.odds ?? null,
        expected_value: chain.expected_value ?? match.expected_value ?? null,
        provider: chain.provider && chain.provider !== "-" ? chain.provider : match.provider,
        final_chain_status: chain.final_chain_status || match.final_chain_status,
        intelligence_status: chain.final_chain_status || match.intelligence_status,
        player_intelligence_status: chain.player_intelligence_status || match.player_intelligence_status,
        recommended_action: chain.recommendation || match.recommended_action,
        detail: {
          ...detail,
          model_probability: chain.model_probability ?? detail.model_probability ?? null,
          market: chain.market || detail.market || null,
          pick: chain.pick || detail.pick || null,
          league_trust_score: chain.league_trust_score ?? detail.league_trust_score ?? null,
          league_trust_status: chain.league_trust_status || detail.league_trust_status || null,
          team_intelligence_status: chain.team_intelligence_status || detail.team_intelligence_status || null,
          player_intelligence_status: chain.player_intelligence_status || detail.player_intelligence_status || null,
          market_lab_status: chain.market_lab_status || detail.market_lab_status || null,
          kickoff_status: chain.kickoff_status || detail.kickoff_status || null,
          odds_timestamp_status: chain.odds_timestamp_status || detail.odds_timestamp_status || null,
          source_consensus: chain.kickoff_status === "TRUSTED" || detail.source_consensus || false,
          kickoff_trusted: chain.kickoff_status === "TRUSTED" || detail.kickoff_trusted || false,
          is_friendly: chain.is_friendly ?? detail.is_friendly ?? false,
          missing_context_fields: Array.isArray(chain.missing_context_fields) ? chain.missing_context_fields : (detail.missing_context_fields || [])
        }
      };
    });
    const boardDate = String((liveBoard as Record<string, any>).date || requestedDate || query.date || "");
    let mlbRows: Record<string, any>[] = [];
    if (!normalizedSport || normalizedSport === "baseball") {
      const mlbWindow = localDateWindow(boardDate || undefined);
      mlbRows = (await db.query(
        `
          SELECT
            m.id::text AS match_id,
            l.slug AS league_id,
            l.name AS league_name,
            m.slug,
            m.match_date AS start_time,
            m.status::text AS status,
            m.home_score,
            m.away_score,
            pt.selection AS paper_selection,
            pt.market_odds AS paper_odds,
            pt.model_probability,
            pt.expected_value,
            pt.status AS paper_status,
            pt.odds_source AS paper_provider,
            pt.net_profit,
            pt.raw_data AS paper_raw_data,
            mq.provider_name AS quote_provider,
            mq.home_odds,
            mq.away_odds,
            mq.captured_at AS quote_captured_at,
            mf.feature_set,
            mf.generated_at AS feature_generated_at
          FROM v_valid_matches m
          JOIN leagues l ON l.id = m.league_id
          LEFT JOIN LATERAL (
            SELECT *
            FROM paper_trades pt
            WHERE pt.match_id = m.id
              AND pt.market_type = 'moneyline_2way'
              AND pt.model_version = 'carlos_v1_mlb'
            ORDER BY pt.created_at DESC
            LIMIT 1
          ) pt ON true
          LEFT JOIN LATERAL (
            SELECT *
            FROM market_quotes mq
            WHERE mq.match_id = m.id
              AND mq.market_type = 'moneyline_2way'
            ORDER BY mq.captured_at DESC
            LIMIT 1
          ) mq ON true
          LEFT JOIN LATERAL (
            SELECT *
            FROM model_features mf
            WHERE mf.match_id = m.id
              AND mf.sport_slug = 'baseball'
              AND mf.model_name = 'carlos_v1_mlb'
            ORDER BY mf.generated_at DESC
            LIMIT 1
          ) mf ON true
          WHERE l.slug = 'mlb'
            AND m.match_date >= $1::timestamptz
            AND m.match_date < $2::timestamptz
          ORDER BY m.match_date ASC, m.slug ASC
        `,
        [mlbWindow.start, mlbWindow.end]
      )).rows;
    }
    const mlbMatches = mlbRows.map((row) => {
      const teams = resolveMlbTeamsFromSlug(String(row.slug || ""));
      const featureSet = row.feature_set && typeof row.feature_set === "object" ? row.feature_set as Record<string, any> : {};
      const missingContext = Array.isArray(featureSet.missing_context) ? featureSet.missing_context : [];
      const homeLineupConfirmed = featureSet.home_lineup_confirmed === true || featureSet.home_lineup_confirmed === "true";
      const awayLineupConfirmed = featureSet.away_lineup_confirmed === true || featureSet.away_lineup_confirmed === "true";
      const homePitcher = featureSet.probable_pitcher_home || null;
      const awayPitcher = featureSet.probable_pitcher_away || null;
      const hasPitcherBlock = !homePitcher || !awayPitcher;
      const hasLineupGap = !homeLineupConfirmed || !awayLineupConfirmed;
      const matchupStatus = hasPitcherBlock
        ? "BLOCK_CONFIRMATION"
        : hasLineupGap
          ? "PARTIAL_CONTEXT_REVIEW"
          : "MATCHUP_CONTEXT_SUPPORTS";
      const finalStatus = row.paper_selection
        ? (matchupStatus === "MATCHUP_CONTEXT_SUPPORTS" ? "VALUE_ONLY_REVIEW" : "MODEL_CONFLICT_REVIEW")
        : "OBSERVATION_ONLY";
      const odds = row.paper_odds ?? (row.paper_selection === "away" ? row.away_odds : row.paper_selection === "home" ? row.home_odds : null);
      return {
        match_id: row.match_id,
        sport: "baseball",
        league_id: "mlb",
        league_name: row.league_name || "MLB",
        start_time: row.start_time,
        status: row.paper_status || row.status || "scheduled",
        home_team: teams.home_team,
        away_team: teams.away_team,
        home_score: row.home_score ?? null,
        away_score: row.away_score ?? null,
        recommended_pick: row.paper_selection ?? null,
        odds,
        expected_value: row.expected_value ?? null,
        provider: row.paper_provider || row.quote_provider || "mlb_stats_api",
        final_chain_status: finalStatus,
        intelligence_status: matchupStatus,
        player_intelligence_status: matchupStatus,
        settlement_status: row.paper_status || "NONE",
        recommended_action: row.paper_selection
          ? "MLB en Real Paper; revisar contexto, pitchers, lineups y closing antes de confiar."
          : "MLB observado con plantilla/contexto; no es pick.",
        detail: {
          source: "mlb_match_center",
          model_probability: row.model_probability ?? null,
          market: "moneyline_2way",
          pick: row.paper_selection ?? null,
          home_pitcher: homePitcher,
          away_pitcher: awayPitcher,
          lineup_home_status: homeLineupConfirmed ? "CONFIRMED" : "PENDING",
          lineup_away_status: awayLineupConfirmed ? "CONFIRMED" : "PENDING",
          top_hitters_status: hasLineupGap ? "PENDING" : "AVAILABLE",
          injury_status: "REVIEW",
          bullpen_status: featureSet.home_bullpen_era || featureSet.away_bullpen_era ? "AVAILABLE" : "UNKNOWN",
          freshness_status: row.quote_captured_at ? "MARKET_SNAPSHOT" : "UNKNOWN",
          odds_timestamp: row.quote_captured_at || row.feature_generated_at || row.start_time,
          high_ev_status: row.expected_value !== null && Number(row.expected_value) >= 0.4 ? "EXTREME_EV_REVIEW" : "NORMAL",
          matchup_status: matchupStatus,
          intelligence_support_score: matchupStatus === "MATCHUP_CONTEXT_SUPPORTS" ? 80 : matchupStatus === "PARTIAL_CONTEXT_REVIEW" ? 55 : 20,
          intelligence_conflict_score: hasPitcherBlock ? 80 : hasLineupGap ? 35 : 0,
          missing_context_fields: [
            ...missingContext,
            ...(!homePitcher ? ["probable_pitcher_home"] : []),
            ...(!awayPitcher ? ["probable_pitcher_away"] : []),
            ...(!homeLineupConfirmed ? ["home_lineup"] : []),
            ...(!awayLineupConfirmed ? ["away_lineup"] : [])
          ],
          block_confirmation_reasons: hasPitcherBlock ? ["pitcher_missing"] : [],
          clv: row.paper_raw_data?.clv ?? null,
          profit: row.net_profit ?? null,
          feature_completeness: featureSet.feature_completeness || "unknown",
          feature_source: featureSet.feature_source || "model_features"
        }
      };
    });
    const normalizeMatchIdentityPart = (value: unknown) => String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const matchDateKey = (value: unknown) => {
      const text = String(value || "");
      const match = text.match(/^\d{4}-\d{2}-\d{2}/);
      return match ? match[0] : boardDate || "unknown-date";
    };
    const hasUsableTeamIdentity = (match: Record<string, any>) => {
      const home = normalizeMatchIdentityPart(match.home_team);
      const away = normalizeMatchIdentityPart(match.away_team);
      return Boolean(home && away && home !== "tbd" && away !== "tbd" && !home.includes("espn-mlb"));
    };
    const buildCanonicalMatchKey = (match: Record<string, any>) => {
      const sport = normalizeMatchIdentityPart(match.sport);
      const league = normalizeMatchIdentityPart(match.league_id);
      if (hasUsableTeamIdentity(match)) {
        return [
          "teams",
          sport,
          league,
          normalizeMatchIdentityPart(match.home_team),
          normalizeMatchIdentityPart(match.away_team),
          matchDateKey(match.start_time)
        ].join(":");
      }
      return ["identity", sport, league, String(match.match_id || match.slug || "")].join(":");
    };
    const nonNullScore = (value: unknown): number => {
      if (value === null || value === undefined || value === "") return 0;
      if (Array.isArray(value)) return value.length;
      if (typeof value === "object") {
        return Object.values(value as Record<string, unknown>).reduce<number>((sum, item) => sum + nonNullScore(item), 0);
      }
      return 1;
    };
    const matchRowQuality = (match: Record<string, any>) => {
      const detail = match.detail && typeof match.detail === "object" ? match.detail as Record<string, any> : {};
      const missing = Array.isArray(detail.missing_context_fields) ? detail.missing_context_fields.length : 0;
      return (
        (match.match_id ? 100 : 0) +
        (hasUsableTeamIdentity(match) ? 80 : 0) +
        (match.recommended_pick ? 70 : 0) +
        (match.odds !== null && match.odds !== undefined ? 60 : 0) +
        (detail.model_probability !== null && detail.model_probability !== undefined ? 50 : 0) +
        (match.expected_value !== null && match.expected_value !== undefined ? 40 : 0) +
        (detail.source_consensus || detail.kickoff_trusted ? 25 : 0) +
        (detail.home_pitcher || detail.away_pitcher ? 20 : 0) +
        (detail.lineup_home_status === "CONFIRMED" || detail.lineup_away_status === "CONFIRMED" ? 20 : 0) +
        Math.min(30, nonNullScore(detail)) -
        missing
      );
    };
    const mergeNonNullFields = (base: Record<string, any> | undefined, incoming: Record<string, any>) => {
      if (!base) return incoming;
      const result: Record<string, any> = { ...base };
      for (const [key, value] of Object.entries(incoming)) {
        if (value === null || value === undefined || value === "") continue;
        if (
          key === "detail" &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          result.detail &&
          typeof result.detail === "object" &&
          !Array.isArray(result.detail)
        ) {
          result.detail = mergeNonNullFields(result.detail as Record<string, any>, value as Record<string, any>);
          continue;
        }
        if (result[key] === null || result[key] === undefined || result[key] === "") {
          result[key] = value;
        }
      }
      return result;
    };
    const deduplicateMatchRows = (rows: Record<string, any>[]) => {
      const byKey = new Map<string, Record<string, any>>();
      let duplicatesRemoved = 0;
      let unresolvedIdentity = 0;
      for (const row of rows) {
        if (!hasUsableTeamIdentity(row)) unresolvedIdentity += 1;
        const key = buildCanonicalMatchKey(row);
        const current = byKey.get(key);
        if (!current) {
          byKey.set(key, row);
          continue;
        }
        duplicatesRemoved += 1;
        const winner = matchRowQuality(row) > matchRowQuality(current) ? row : current;
        const loser = winner === row ? current : row;
        byKey.set(key, mergeNonNullFields(winner, loser));
      }
      return {
        rows: Array.from(byKey.values()),
        metrics: {
          rows_raw: rows.length,
          rows_unique: byKey.size,
          duplicates_removed: duplicatesRemoved,
          unresolved_identity: unresolvedIdentity
        }
      };
    };
    const combinedMatches = [...enrichedLiveMatches, ...mlbMatches];
    const deduped = deduplicateMatchRows(combinedMatches);
    const allLiveMatches = deduped.rows;

    const filtered = allLiveMatches.filter((match) => {
      const finalStatus = String(match.final_chain_status || "").toUpperCase();
      const matchStatusValue = String(match.status || "").toLowerCase();
      if (normalizedSport && String(match.sport || "").toLowerCase() !== normalizedSport) return false;
      if (query.league_id && String(match.league_id || "").toLowerCase() !== query.league_id.toLowerCase()) return false;
      if (query.match_id && String(match.match_id || "") !== query.match_id) return false;
      if (query.status && matchStatusValue !== query.status.toLowerCase()) return false;
      if (query.only_confirmed_paper && !finalStatus.includes("CONFIRMED")) return false;
      if (query.only_review && !(finalStatus.includes("REVIEW") || finalStatus.includes("VALUE") || finalStatus.includes("CONTEXT") || finalStatus.includes("FOOTBALL"))) return false;
      if (query.only_active && !(matchStatusValue.includes("open") || matchStatusValue.includes("pending") || matchStatusValue.includes("scheduled") || matchStatusValue.includes("live"))) return false;
      return true;
    });

    const matches = filtered.map((match) => {
      const detail = match.detail && typeof match.detail === "object" ? match.detail as Record<string, any> : {};
      const missing = Array.isArray(detail.missing_context_fields) ? detail.missing_context_fields : [];
      const blocks = Array.isArray(detail.block_confirmation_reasons) ? detail.block_confirmation_reasons : [];
      const finalStatus = String(match.final_chain_status || "NO_DATA");
      const isFootball = String(match.sport || "") === "soccer";
      const recommendation = match.recommended_action || (
        finalStatus.includes("CONFIRMED")
          ? "Revisar como paper confirmado. No dinero real."
          : finalStatus.includes("BLOCK")
            ? "No tocar; resolver bloqueos primero."
            : "Mantener en revision hasta completar contexto."
      );

      return {
        match_id: match.match_id,
        sport: match.sport,
        league_id: match.league_id,
        league_name: match.league_name,
        start_time: match.start_time,
        status: match.status,
        home_team: match.home_team,
        away_team: match.away_team,
        home_score: match.home_score ?? null,
        away_score: match.away_score ?? null,
        system_mode: isFootball ? "SHADOW_PAPER_ONLY" : "REAL_PAPER_ONLY",
        recommended_action: recommendation,
        final_status: finalStatus,
        final_chain_status: finalStatus,
        recommended_pick: match.recommended_pick ?? null,
        odds: match.odds ?? null,
        expected_value: match.expected_value ?? null,
        provider: match.provider ?? null,
        intelligence_status: match.intelligence_status || "NO_CONTEXT",
        player_intelligence_status: match.player_intelligence_status || "NO_CONTEXT",
        settlement_status: match.settlement_status || "NONE",
        pick: {
          market: isFootball ? "football_market" : "moneyline_2way",
          selection: match.recommended_pick ?? null,
          label: match.recommended_pick ?? null,
          odds: match.odds ?? null,
          model_probability: detail.model_probability ?? null,
          expected_value: match.expected_value ?? null,
          provider: match.provider ?? null
        },
        odds_detail: {
          entry_odds: match.odds ?? null,
          current_odds: null,
          closing_odds: detail.closing_odds ?? null,
          odds_timestamp: detail.odds_timestamp ?? match.start_time ?? null,
          freshness_status: detail.freshness_status || "UNKNOWN",
          line_movement_status: detail.line_movement_status || "UNKNOWN",
          stale_status: String(detail.freshness_status || "").toUpperCase().includes("STALE"),
          outlier_status: detail.high_ev_status || "REVIEW"
        },
        intelligence: {
          status: match.intelligence_status || "NO_CONTEXT",
          support_score: detail.intelligence_support_score ?? null,
          conflict_score: detail.intelligence_conflict_score ?? null,
          reasons: [...missing, ...blocks],
          recommendation
        },
        player_intelligence: {
          status: match.player_intelligence_status || "NO_CONTEXT",
          home_pitcher: detail.home_pitcher ?? null,
          away_pitcher: detail.away_pitcher ?? null,
          lineup_home_status: detail.lineup_home_status || (isFootball ? "PENDING" : "UNKNOWN"),
          lineup_away_status: detail.lineup_away_status || (isFootball ? "PENDING" : "UNKNOWN"),
          top_hitters_status: detail.top_hitters_status || "UNKNOWN",
          injury_status: detail.injury_status || "REVIEW",
          bullpen_status: detail.bullpen_status || "UNKNOWN",
          weather_status: detail.weather_status || "PENDING"
        },
        pick_chain: {
          provider_clean: detail.provider_clean ?? null,
          fresh_line: detail.freshness_status ? String(detail.freshness_status).includes("FRESH") : null,
          duplicate_exposure: detail.duplicate_status ? !String(detail.duplicate_status).includes("NO_DUPLICATE") : null,
          suspicious_move: detail.suspicious_move_status ?? null,
          high_ev_status: detail.high_ev_status || "UNKNOWN",
          matchup_status: detail.matchup_status || match.intelligence_status || "NO_CONTEXT",
          final_chain_status: finalStatus,
          missing_context_fields: missing
        },
        settlement: {
          entry_captured: match.odds !== null && match.odds !== undefined,
          closing_captured: detail.closing_odds !== null && detail.closing_odds !== undefined,
          result_captured: match.home_score !== null || match.away_score !== null,
          clv: detail.clv ?? null,
          profit: detail.profit ?? null,
          settlement_status: match.settlement_status || "WAITING"
        },
        football: isFootball ? {
          league_trust_score: detail.league_trust_score ?? null,
          league_trust_status: detail.league_trust_status || "REVIEW",
          source_consensus_status: detail.source_consensus ? "VERIFIED" : "REQUIRED",
          kickoff_verified: detail.kickoff_trusted ?? detail.source_consensus ?? false,
          is_friendly: detail.is_friendly ?? false,
          team_intelligence_status: detail.team_intelligence_status || "NO_CONTEXT",
          player_intelligence_status: match.player_intelligence_status || "NO_CONTEXT",
          market_lab_status: detail.market_lab_status || "ACCUMULATING",
          football_final_chain_status: finalStatus
        } : null,
        detail
      };
    });

    const summary = {
      matches_today: matches.length,
      games_today: matches.length,
      confirmed_paper: matches.filter((match) => String(match.final_status).includes("CONFIRMED")).length,
      review: matches.filter((match) => /REVIEW|VALUE|CONTEXT/.test(String(match.final_status))).length,
      blocked: matches.filter((match) => String(match.final_status).includes("BLOCK")).length,
      pending_settlement: matches.filter((match) => /PENDING|READY|WAITING/.test(String(match.settlement_status))).length,
      pilot_status: "PILOT_LOCKED"
    };
    const leagueMap = new Map<string, Record<string, any>>();
    for (const match of matches) {
      const key = `${match.sport}:${match.league_id}`;
      const current = leagueMap.get(key) || {
        sport: match.sport,
        league_id: match.league_id,
        league_name: match.league_name,
        games_today: 0,
        review: 0,
        blocked: 0,
        confirmed_paper: 0,
        pending_settlement: 0
      };
      current.games_today += 1;
      if (String(match.final_chain_status).includes("CONFIRMED")) current.confirmed_paper += 1;
      if (String(match.final_chain_status).includes("BLOCKED") || String(match.final_chain_status).includes("BLOCK_CONFIRMATION")) current.blocked += 1;
      if (/REVIEW|VALUE|CONTEXT/.test(String(match.final_chain_status))) current.review += 1;
      if (/PENDING|READY|WAITING/.test(String(match.settlement_status))) current.pending_settlement += 1;
      leagueMap.set(key, current);
    }

    return {
      date: (liveBoard as Record<string, any>).date,
      requested_date: (liveBoard as Record<string, any>).requested_date || requestedDate,
      date_fallback_applied: dateFallbackApplied || Boolean((liveBoard as Record<string, any>).date_fallback_applied),
      fallback_reason: (liveBoard as Record<string, any>).fallback_reason || null,
      system_status: "MATCH_CENTER_SAFE",
      view_mode: "MATCH_CENTER_READ_ONLY",
      summary,
      data_quality: {
        match_center_rows_raw: deduped.metrics.rows_raw,
        match_center_rows_unique: deduped.metrics.rows_unique,
        match_center_duplicates_removed: deduped.metrics.duplicates_removed,
        match_center_unresolved_identity: deduped.metrics.unresolved_identity,
        mlb_rows_raw: mlbRows.length,
        mlb_rows_unique: matches.filter((match) => String(match.sport || "") === "baseball" && String(match.league_id || "") === "mlb").length,
        mlb_duplicates_removed: Math.max(0, mlbRows.length - matches.filter((match) => String(match.sport || "") === "baseball" && String(match.league_id || "") === "mlb").length),
        mlb_unresolved_identity: allLiveMatches.filter((match) => String(match.sport || "") === "baseball" && String(match.league_id || "") === "mlb" && !hasUsableTeamIdentity(match)).length
      },
      alerts: [
        ...((liveBoard as Record<string, any>).alerts || []),
        ...(mlbMatches.length > 0 ? [`${mlbMatches.length} juegos MLB agregados al Match Center.`] : []),
        ...(deduped.metrics.duplicates_removed > 0 ? [`Match Center limpio ${deduped.metrics.duplicates_removed} duplicados canónicos.`] : [])
      ],
      leagues: Array.from(leagueMap.values()).sort((a, b) => Number(b.games_today) - Number(a.games_today)),
      matches,
      recommendation: summary.confirmed_paper > 0
        ? "Hay candidato confirmado en paper; revisar Match Center y mantener sin dinero real."
        : "No hay confirmado paper; revisar bloqueos, contexto faltante y pendientes por partido.",
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        shadow_paper_only_for_football: true,
        kill_switch_enabled: true
      }
    };
  }

  async function buildBestBetsPerMatch(rawQuery: unknown = {}) {
    const queryObject = rawQuery && typeof rawQuery === "object" ? rawQuery as Record<string, unknown> : {};
    const requestedSport = String(queryObject.sport || "").toLowerCase();
    const requestedDate = String(queryObject.date || "");
    const matchCenter = await buildMatchCenter(rawQuery) as Record<string, any>;
    const matches = Array.isArray(matchCenter.matches) ? matchCenter.matches as Array<Record<string, any>> : [];

    const numberOrNull = (value: unknown): number | null => {
      if (value === null || value === undefined || value === "") return null;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    };
    const asList = (value: unknown): string[] => Array.isArray(value)
      ? value.map((item) => String(item)).filter(Boolean)
      : [];
    const contains = (value: unknown, needle: string) => String(value || "").toUpperCase().includes(needle);
    const isFootballRequested = ["soccer", "football", "futbol", "fútbol"].includes(requestedSport);
    const isBaseballRequested = ["baseball", "mlb"].includes(requestedSport);
    const isSameRequestedDate = (kickoff: unknown) => {
      if (!requestedDate) return true;
      const date = new Date(String(kickoff || ""));
      if (Number.isNaN(date.getTime())) return false;
      const window = localDateWindow(requestedDate);
      return date.getTime() >= new Date(window.start).getTime() && date.getTime() < new Date(window.end).getTime();
    };
    const marketLabelForMatch = (match: Record<string, any>) => {
      const detail = match.detail && typeof match.detail === "object" ? match.detail as Record<string, any> : {};
      const rawMarket = String(match.pick?.market || detail.market || "");
      if (rawMarket && rawMarket !== "football_market") return rawMarket;
      if (String(match.sport) === "soccer") return match.recommended_pick ? "football_owned_market" : "contextual_lean";
      return "moneyline_2way";
    };
    const footballMarketLabel = (market: unknown) => String(market || "") === "btts" ? "btts_review_only" : String(market || "football_market");
    const contextScoreForMatch = (match: Record<string, any>, missing: string[]) => {
      const explicit = numberOrNull(match.context_completeness_score)
        ?? numberOrNull(match.detail?.context_completeness_score)
        ?? numberOrNull(match.detail?.football_context_completeness_score);
      if (explicit !== null) return Math.max(0, Math.min(100, explicit));
      const statusText = [
        match.final_chain_status,
        match.intelligence_status,
        match.player_intelligence_status,
        match.pick_chain?.matchup_status
      ].join(" ").toUpperCase();
      let base = 30;
      if (statusText.includes("CONFIRMED")) base = 90;
      else if (statusText.includes("MATCHUP_CONTEXT_SUPPORTS") || statusText.includes("SUPPORTS_PICK")) base = 82;
      else if (statusText.includes("PARTIAL_CONTEXT_REVIEW") || statusText.includes("REVIEWABLE")) base = 68;
      else if (statusText.includes("CONTEXT_GAPS")) base = 52;
      else if (statusText.includes("OBSERVATION")) base = 35;
      return Math.max(0, Math.min(100, base - Math.min(25, missing.length * 4)));
    };
    const marketScoreForCandidate = (input: {
      sport: string;
      market: string;
      odds: number | null;
      modelProbability: number | null;
      expectedValue: number | null;
      freshnessStatus: string;
      finalStatus: string;
    }) => {
      let score = 0;
      if (input.odds && input.odds > 1) score += 20;
      if (input.modelProbability !== null) score += 20;
      if (input.expectedValue !== null && input.expectedValue > 0) score += 20;
      if (input.expectedValue !== null && input.expectedValue >= 0.05) score += 10;
      if (input.expectedValue !== null && input.expectedValue >= 0.10) score += 5;
      if (input.freshnessStatus.includes("FRESH") || input.freshnessStatus.includes("MARKET_SNAPSHOT") || input.freshnessStatus === "VALID") score += 10;
      if (input.sport === "baseball" && input.market === "moneyline_2way") score += 10;
      if (input.sport === "soccer" && ["draw_no_bet", "moneyline_3way", "total_goals_2_5", "double_chance"].includes(input.market)) score += 10;
      if (["run_line", "total_runs", "btts", "btts_review_only"].includes(input.market)) score -= 15;
      if (input.finalStatus.includes("REJECT") || input.finalStatus.includes("BLOCKED")) score -= 35;
      return Math.max(0, Math.min(100, score));
    };
    const classifyBestBet = (input: {
      sport: string;
      market: string;
      odds: number | null;
      modelProbability: number | null;
      expectedValue: number | null;
      contextScore: number;
      marketScore: number;
      finalScore: number;
      missing: string[];
      finalStatus: string;
    }) => {
      if (input.finalStatus.includes("CONFIRMED")) return "CONFIRMED_PAPER";
      if (input.finalStatus.includes("REJECT") || input.finalStatus.includes("BLOCKED")) return "NO_BET";
      if (!input.odds || input.modelProbability === null || input.expectedValue === null) return "NO_FINANCIAL_BET";
      if (["run_line", "total_runs", "btts", "btts_review_only"].includes(input.market)) return "REVIEW_ONLY";
      if (input.missing.length || input.contextScore < 61) return "CONTEXT_GAPS";
      if (input.finalScore >= 75 || input.finalStatus.includes("BETTABLE")) return "BETTABLE_PAPER";
      if (input.finalScore >= 55 || input.finalStatus.includes("REVIEW") || input.finalStatus.includes("VALUE")) return "REVIEW_ONLY";
      return "NO_BET";
    };
    const freshnessStatusForFootball = (row: Record<string, any>) => {
      const layer = row.market_layer && typeof row.market_layer === "object" ? row.market_layer as Record<string, any> : {};
      const age = numberOrNull(layer.odds_age_minutes);
      const status = String(row.odds_timestamp_status || layer.status || "UNKNOWN").toUpperCase();
      if (status === "VALID" && age !== null && age <= 90) return "FRESH_LINE";
      if (status === "VALID") return "STALE_LINE_REVIEW";
      return status;
    };
    const classifyFootballBestBet = (input: {
      market: string;
      odds: number | null;
      oddsTimestamp: unknown;
      modelProbability: number | null;
      expectedValue: number | null;
      contextScore: number;
      marketScore: number;
      finalScore: number;
      missing: string[];
      finalStatus: string;
      kickoff: unknown;
      closingOddsSnapshot: boolean;
      freshnessStatus: string;
      calibrationState?: string;
    }) => {
      const kickoff = new Date(String(input.kickoff || ""));
      const calibrationState = String(input.calibrationState || "").toUpperCase();
      if (!Number.isNaN(kickoff.getTime()) && kickoff.getTime() <= Date.now()) return "POST_KICKOFF_AUDIT_ONLY";
      if (input.finalStatus === "FOOTBALL_CONFIRMED_PAPER") return "FOOTBALL_CONFIRMED_PAPER";
      if (!input.odds || !input.oddsTimestamp || input.modelProbability === null || input.expectedValue === null) return "NO_FINANCIAL_BET";
      if (calibrationState === "UNCALIBRATED_PRIOR" || calibrationState === "CALIBRATING") return "CALIBRATING";
      if (input.market === "btts_review_only" || input.market === "btts") return "REVIEW_ONLY";
      if (input.missing.length || input.contextScore < 61) return "CONTEXT_GAPS";
      if (input.expectedValue <= 0) return "REVIEW_ONLY";
      if (input.finalScore >= 85 && input.contextScore >= 80 && input.marketScore >= 75 && input.closingOddsSnapshot && ["moneyline_3way", "draw_no_bet"].includes(input.market)) {
        return "FOOTBALL_CONFIRMED_PAPER";
      }
      if (!input.closingOddsSnapshot && input.finalScore >= 75) return "BETTABLE_PAPER";
      if (input.freshnessStatus === "FRESH_LINE" && input.finalScore >= 75) return "BETTABLE_PAPER";
      if (input.finalScore >= 65) return "READY_FOR_SHADOW_REVIEW";
      return "REVIEW_ONLY";
    };

    const baseRows = isFootballRequested ? [] : matches.map((match) => {
      const detail = match.detail && typeof match.detail === "object" ? match.detail as Record<string, any> : {};
      const pickChain = match.pick_chain && typeof match.pick_chain === "object" ? match.pick_chain as Record<string, any> : {};
      const missing = [
        ...asList(detail.missing_context_fields),
        ...asList(pickChain.missing_context_fields)
      ].filter((value, index, list) => list.indexOf(value) === index);
      const blocks = asList(detail.block_confirmation_reasons);
      const market = marketLabelForMatch(match);
      const rawOdds = numberOrNull(match.odds ?? match.pick?.odds);
      const rawModelProbability = numberOrNull(match.pick?.model_probability ?? detail.model_probability);
      const rawExpectedValue = numberOrNull(match.expected_value ?? match.pick?.expected_value);
      const odds = rawOdds !== null && rawOdds > 1 ? rawOdds : null;
      const modelProbability = rawModelProbability !== null && rawModelProbability > 0 && rawModelProbability <= 1 ? rawModelProbability : null;
      const expectedValue = rawExpectedValue !== null && (odds !== null || modelProbability !== null || rawExpectedValue !== 0) ? rawExpectedValue : null;
      const contextScore = contextScoreForMatch(match, missing);
      const freshnessStatus = String(match.odds_detail?.freshness_status || detail.freshness_status || "UNKNOWN").toUpperCase();
      const finalStatus = String(match.final_chain_status || match.final_status || "NO_DATA").toUpperCase();
      const marketScore = marketScoreForCandidate({
        sport: String(match.sport || ""),
        market,
        odds,
        modelProbability,
        expectedValue,
        freshnessStatus,
        finalStatus
      });
      const finalScore = Math.max(0, Math.min(100, Math.round((contextScore * 0.45) + (marketScore * 0.45) + (expectedValue !== null && expectedValue > 0 ? 10 : 0))));
      const status = classifyBestBet({
        sport: String(match.sport || ""),
        market,
        odds,
        modelProbability,
        expectedValue,
        contextScore,
        marketScore,
        finalScore,
        missing,
        finalStatus
      });
      const whyYes = [
        odds && odds > 1 ? "Odds disponibles" : null,
        modelProbability !== null ? "Modelo disponible" : null,
        expectedValue !== null && expectedValue > 0 ? "EV positivo" : null,
        contextScore >= 75 ? "Contexto fuerte o cercano" : null,
        market === "moneyline_2way" ? "MLB moneyline confirmable" : null,
        ["draw_no_bet", "moneyline_3way", "total_goals_2_5", "double_chance"].includes(market) ? "Mercado de futbol permitido para shadow" : null
      ].filter(Boolean);
      const whyNo = [
        !odds ? "Falta odds real" : null,
        modelProbability === null ? "Falta model_probability" : null,
        expectedValue === null ? "Falta expected_value" : null,
        ...missing.map((item) => `Falta ${item}`),
        ...blocks,
        contains(match.odds_detail?.outlier_status || detail.high_ev_status, "REVIEW") ? "EV alto requiere auditoria" : null,
        ["run_line", "total_runs", "btts"].includes(market) ? "Mercado analysis-only/review-only" : null
      ].filter(Boolean);
      return {
        match_id: match.match_id,
        match: `${match.home_team || "Home"} vs ${match.away_team || "Away"}`,
        sport: String(match.sport || ""),
        league_id: match.league_id,
        kickoff: match.start_time,
        best_market: market,
        pick: match.recommended_pick || match.pick?.selection || "none",
        odds,
        model_probability: modelProbability,
        fair_odds: modelProbability && modelProbability > 0 ? Number((1 / modelProbability).toFixed(4)) : null,
        expected_value: expectedValue,
        context_score: contextScore,
        market_score: marketScore,
        final_score: finalScore,
        status,
        why_yes: whyYes.length ? whyYes : ["Lectura contextual disponible"],
        why_no: whyNo.length ? whyNo : ["Sin bloqueos principales en esta vista; revisar cadena completa"],
        confirmed_pick: status === "CONFIRMED_PAPER",
        source_final_chain_status: finalStatus,
        recommendation: status === "CONFIRMED_PAPER"
          ? "Medir solo en paper; dinero real sigue apagado."
          : status === "BETTABLE_PAPER"
            ? "Buen candidato paper; revisar cierre/guardrails antes de confiar."
            : status === "NO_FINANCIAL_BET"
              ? "No es apuesta: falta capa financiera real."
              : "Usar como lectura/review, no como apuesta."
      };
    });

    const footballChainRows = isBaseballRequested
      ? []
      : (((await getFootballConfirmedPickChain(db) as Record<string, any>).rows ?? []) as Array<Record<string, any>>)
        .filter((row: Record<string, any>) => isSameRequestedDate(row.kickoff));
    const footballChainByMatch = new Map<string, Record<string, any>>();
    for (const row of footballChainRows) {
      footballChainByMatch.set(String(row.match_id || row.match || ""), row);
    }

    const footballRows = footballChainRows
      .map((row: Record<string, any>) => {
        const market = footballMarketLabel(row.market);
        const rawOdds = numberOrNull(row.odds);
        const rawModelProbability = numberOrNull(row.model_probability);
        const rawExpectedValue = numberOrNull(row.expected_value);
        const odds = rawOdds !== null && rawOdds > 1 ? rawOdds : null;
        const modelProbability = rawModelProbability !== null && rawModelProbability > 0 && rawModelProbability <= 1 ? rawModelProbability : null;
        const expectedValue = rawExpectedValue !== null && odds !== null && modelProbability !== null ? rawExpectedValue : null;
        const contextScore = Math.max(0, Math.min(100, numberOrNull(row.football_context_completeness_score) ?? numberOrNull(row.football_context_raw_score) ?? 0));
        const finalStatus = String(row.final_chain_status || "OBSERVATION_ONLY").toUpperCase();
        const missing = asList(row.missing_context_fields);
        const freshnessStatus = freshnessStatusForFootball(row);
        const layer = row.market_layer && typeof row.market_layer === "object" ? row.market_layer as Record<string, any> : {};
        const rawCalibrationState = String(row.calibration_state || row.model_label || layer.calibration_state || layer.model_label || "").toUpperCase();
        const calibrationState = ["UNCALIBRATED_PRIOR", "CALIBRATING"].includes(rawCalibrationState) ? "CALIBRATING" : rawCalibrationState;
        const layers = row.football_context_layers && typeof row.football_context_layers === "object" ? row.football_context_layers as Record<string, any> : {};
        const closingLayer = layers.closing_odds_tracking && typeof layers.closing_odds_tracking === "object" ? layers.closing_odds_tracking as Record<string, any> : {};
        const closingOddsSnapshot = Boolean(row.closing_odds_snapshot || row.closing_odds || Number(closingLayer.value || 0) >= 10);
        const marketScore = marketScoreForCandidate({
          sport: "soccer",
          market,
          odds,
          modelProbability,
          expectedValue,
          freshnessStatus,
          finalStatus
        });
        const finalScore = Math.max(0, Math.min(100, Math.round((contextScore * 0.45) + (marketScore * 0.45) + (expectedValue !== null && expectedValue > 0 ? 10 : 0))));
        const status = classifyFootballBestBet({
          market,
          odds,
          oddsTimestamp: row.odds_timestamp || layer.odds_real_timestamp,
          modelProbability,
          expectedValue,
          contextScore,
          marketScore,
          finalScore,
          missing,
          finalStatus,
          kickoff: row.kickoff,
          closingOddsSnapshot,
          freshnessStatus,
          calibrationState
        });
        const whyYes = [
          odds && odds > 1 ? "Odds reales disponibles" : null,
          row.odds_timestamp || layer.odds_real_timestamp ? "Odds timestamp disponible" : null,
          modelProbability !== null ? "Modelo disponible" : null,
          expectedValue !== null && expectedValue > 0 ? "EV positivo" : null,
          contextScore >= 70 ? "Contexto futbol revisable" : null,
          ["moneyline_3way", "draw_no_bet"].includes(market) ? "Mercado confirmable en Shadow Paper" : null,
          market === "double_chance" ? "Doble oportunidad conservador" : null
        ].filter(Boolean);
        const whyNo = [
          !odds ? "Falta odds real" : null,
          !(row.odds_timestamp || layer.odds_real_timestamp) ? "Falta odds_timestamp" : null,
          modelProbability === null ? "Falta model_probability" : null,
          expectedValue === null ? "Falta expected_value" : null,
          ...missing.map((item) => `Falta ${item}`),
          market === "btts_review_only" ? "BTTS es solo review/manual" : null,
          !closingOddsSnapshot ? "Falta closing_odds_snapshot" : null,
          freshnessStatus !== "FRESH_LINE" && odds ? `Freshness ${freshnessStatus}` : null
        ].filter(Boolean);
        return {
          match_id: row.match_id,
          match: row.match,
          sport: "soccer",
          league_id: row.league_id || row.league,
          kickoff: row.kickoff,
          match_status: row.paper_status || row.status || null,
          best_market: market,
          pick: row.pick || "none",
          odds,
          provider: row.provider || "-",
          odds_timestamp: odds !== null ? row.odds_timestamp || layer.odds_real_timestamp || null : null,
          model_probability: modelProbability,
          fair_odds: modelProbability && modelProbability > 0 ? Number((1 / modelProbability).toFixed(4)) : null,
          expected_value: expectedValue,
          context_score: contextScore,
          market_score: marketScore,
          final_score: finalScore,
          status,
          calibration_state: calibrationState || null,
          why_yes: whyYes.length ? whyYes : ["Lectura contextual disponible"],
          why_no: whyNo.length ? whyNo : ["Sin bloqueos principales en esta vista; revisar cadena completa"],
          confirmed_pick: status === "FOOTBALL_CONFIRMED_PAPER",
          source_final_chain_status: finalStatus,
          recommendation: status === "FOOTBALL_CONFIRMED_PAPER"
            ? "Confirmado solo Shadow Paper; dinero real sigue apagado."
            : status === "BETTABLE_PAPER"
              ? "Buen candidato Shadow Paper; falta cierre o validacion final."
              : status === "NO_FINANCIAL_BET"
                ? "No es apuesta: falta odds/modelo/EV."
                : "Usar como lectura/review, no como apuesta."
        };
      }) ?? [];

    const bridgeWindow = requestedDate ? localDateWindow(requestedDate) : null;
    const footballBridgeResult = isBaseballRequested
      ? { rows: [] as Array<Record<string, any>> }
      : await db.query(
        `
          WITH latest_model_quotes AS (
            SELECT DISTINCT ON (mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999))
              mq.*
            FROM model_quotes mq
            JOIN v_valid_matches m ON m.id = mq.match_id
            JOIN leagues l ON l.id = m.league_id
            JOIN sports s ON s.id = l.sport_id
            WHERE s.slug = 'soccer'
              AND mq.model_name = $1
              AND mq.confidence >= $2
              AND (
                ($5::text = '' AND mq.generated_at >= NOW() - ($3::int * INTERVAL '1 minute'))
                OR (
                  $5::text <> ''
                  AND m.match_date >= $5::timestamptz
                  AND m.match_date < $6::timestamptz
                )
              )
              AND m.status::text IN ('scheduled', 'live')
            ORDER BY mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999), mq.generated_at DESC
          ),
          model_selections AS (
            SELECT
              mq.id AS model_quote_id,
              mq.match_id,
              l.slug AS league_slug,
              mq.market_type,
              mq.line,
              m.match_date AS kickoff,
              COALESCE(mq.raw_data->>'calibration_state', 'CALIBRATING') AS calibration_state,
              COALESCE(mq.raw_data->>'model_family', 'football_context_prior_v1') AS model_family,
              COALESCE(mq.raw_data->>'target_model_family', 'dixon_coles_market_blend_v1') AS target_model_family,
              COALESCE(pem.home_team_name, home_comp.team_name) AS home_team_name,
              COALESCE(pem.away_team_name, away_comp.team_name) AS away_team_name,
              mq.confidence,
              mq.generated_at,
              COALESCE((mq.raw_data->>'analysis_only')::boolean, false) AS analysis_only,
              selection.market_selection,
              selection.model_probability,
              selection.model_fair_odds,
              COALESCE(selection.min_market_odds_for_ev, ROUND((selection.model_fair_odds * 1.03)::numeric, 4)) AS min_market_odds_for_ev
            FROM latest_model_quotes mq
            JOIN v_valid_matches m ON m.id = mq.match_id
            JOIN leagues l ON l.id = m.league_id
            LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = mq.match_id AND pem.is_active = TRUE
            LEFT JOIN LATERAL (
              SELECT t.name AS team_name
              FROM match_competitors mc
              JOIN teams t ON t.id = mc.team_id
              WHERE mc.match_id = mq.match_id AND mc.home_away = 'home'
              LIMIT 1
            ) home_comp ON TRUE
            LEFT JOIN LATERAL (
              SELECT t.name AS team_name
              FROM match_competitors mc
              JOIN teams t ON t.id = mc.team_id
              WHERE mc.match_id = mq.match_id AND mc.home_away = 'away'
              LIMIT 1
            ) away_comp ON TRUE
            CROSS JOIN LATERAL (
              VALUES
                (
                  COALESCE(mq.raw_data #>> ARRAY['selection_map', 'home'], CASE WHEN mq.market_type LIKE 'over_under%' THEN 'over' ELSE 'home' END),
                  mq.home_probability,
                  mq.home_fair_odds,
                  ((mq.raw_data #>> ARRAY['min_market_odds_for_ev', 'home'])::numeric)
                ),
                (
                  COALESCE(mq.raw_data #>> ARRAY['selection_map', 'away'], CASE WHEN mq.market_type LIKE 'over_under%' THEN 'under' ELSE 'away' END),
                  mq.away_probability,
                  mq.away_fair_odds,
                  ((mq.raw_data #>> ARRAY['min_market_odds_for_ev', 'away'])::numeric)
                ),
                (
                  COALESCE(mq.raw_data #>> ARRAY['selection_map', 'draw'], 'draw'),
                  mq.draw_probability,
                  mq.draw_fair_odds,
                  ((mq.raw_data #>> ARRAY['min_market_odds_for_ev', 'draw'])::numeric)
                )
            ) AS selection(market_selection, model_probability, model_fair_odds, min_market_odds_for_ev)
            WHERE selection.model_probability IS NOT NULL
              AND selection.model_fair_odds IS NOT NULL
              AND NOT (COALESCE(mq.raw_data->'disabled_selections', '[]'::jsonb) ? selection.market_selection)
          ),
          bridged AS (
            SELECT
              ms.*,
              best_market.market_quote_id,
              best_market.provider_name,
              best_market.captured_at,
              best_market.market_odds,
              CASE
                WHEN best_market.market_odds IS NULL THEN NULL
                ELSE ROUND(((ms.model_probability * best_market.market_odds) - 1)::numeric, 6)
              END AS expected_value
            FROM model_selections ms
            LEFT JOIN LATERAL (
              SELECT
                mk.id AS market_quote_id,
                mk.provider_name,
                mk.captured_at,
                market_selection.market_odds
              FROM market_quotes mk
              CROSS JOIN LATERAL (
                VALUES
                  (
                    COALESCE(mk.raw_data #>> ARRAY['selection_map', 'home'], CASE WHEN mk.market_type LIKE 'over_under%' THEN 'over' ELSE 'home' END),
                    mk.home_odds
                  ),
                  (
                    COALESCE(mk.raw_data #>> ARRAY['selection_map', 'away'], CASE WHEN mk.market_type LIKE 'over_under%' THEN 'under' ELSE 'away' END),
                    mk.away_odds
                  ),
                  (COALESCE(mk.raw_data #>> ARRAY['selection_map', 'draw'], 'draw'), mk.draw_odds)
              ) AS market_selection(market_selection, market_odds)
              WHERE mk.match_id = ms.match_id
                AND mk.market_type = ms.market_type
                AND COALESCE(mk.line, -9999) = COALESCE(ms.line, -9999)
                AND mk.captured_at >= NOW() - ($4::int * INTERVAL '1 minute')
                AND market_selection.market_selection = ms.market_selection
                AND market_selection.market_odds IS NOT NULL
              ORDER BY market_selection.market_odds DESC, mk.captured_at DESC
              LIMIT 1
            ) best_market ON TRUE
          )
          SELECT
            *,
            CASE
              WHEN analysis_only THEN 'ANALYSIS_ONLY'
              WHEN market_quote_id IS NULL THEN 'MARKET_ODDS_MISSING'
              WHEN expected_value >= $8 THEN 'READY_FOR_SHADOW_REVIEW'
              WHEN expected_value > 0 THEN 'POSITIVE_EV_WATCH'
              ELSE 'NO_EDGE'
            END AS bridge_status,
            EXTRACT(EPOCH FROM (NOW() - generated_at))::int AS model_age_seconds,
            EXTRACT(EPOCH FROM (NOW() - captured_at))::int AS market_age_seconds
          FROM bridged
          ORDER BY
            CASE
              WHEN market_quote_id IS NULL THEN 2
              WHEN expected_value >= $8 THEN 0
              WHEN expected_value > 0 THEN 1
              ELSE 3
            END,
            expected_value DESC NULLS LAST,
            confidence DESC,
            generated_at DESC
          LIMIT $7
        `,
        [
          ACTIVE_FOOTBALL_FAIR_ODDS_MODEL,
          0,
          1440,
          1440,
          bridgeWindow?.start ?? "",
          bridgeWindow?.end ?? "",
          300,
          0.03
        ]
      );
    const footballBridgeRows = (footballBridgeResult.rows as Array<Record<string, any>>).map((row) => {
      const chainRow = footballChainByMatch.get(String(row.match_id)) || {};
      const market = footballMarketLabel(row.market_type);
      const rawCalibrationState = String(row.calibration_state || "").toUpperCase();
      const calibrationState = ["UNCALIBRATED_PRIOR", "CALIBRATING"].includes(rawCalibrationState) ? "CALIBRATING" : rawCalibrationState;
      const odds = numberOrNull(row.market_odds);
      const modelProbability = numberOrNull(row.model_probability);
      const expectedValue = odds !== null && modelProbability !== null ? numberOrNull(row.expected_value) : null;
      const contextScore = Math.max(
        0,
        Math.min(
          100,
          numberOrNull(chainRow.football_context_completeness_score)
            ?? numberOrNull(chainRow.football_context_raw_score)
            ?? 45
        )
      );
      const missing = asList(chainRow.missing_context_fields);
      const marketAgeMinutes = numberOrNull(row.market_age_seconds) === null ? null : Math.round(Number(row.market_age_seconds) / 60);
      const freshnessStatus = marketAgeMinutes === null
        ? "MARKET_ODDS_MISSING"
        : marketAgeMinutes <= 90
          ? "FRESH_LINE"
          : "STALE_LINE_REVIEW";
      const marketScore = marketScoreForCandidate({
        sport: "soccer",
        market,
        odds,
        modelProbability,
        expectedValue,
        freshnessStatus,
        finalStatus: String(row.bridge_status || "MARKET_BRIDGE").toUpperCase()
      });
      const finalScore = Math.max(0, Math.min(100, Math.round((contextScore * 0.45) + (marketScore * 0.45) + (expectedValue !== null && expectedValue > 0 ? 10 : 0))));
      const status = classifyFootballBestBet({
        market,
        odds,
        oddsTimestamp: row.captured_at,
        modelProbability,
        expectedValue,
        contextScore,
        marketScore,
        finalScore,
        missing,
        finalStatus: String(row.bridge_status || "MARKET_BRIDGE").toUpperCase(),
        kickoff: row.kickoff,
        closingOddsSnapshot: false,
        freshnessStatus,
        calibrationState
      });
      const whyYes = [
        "Fair odds propia calculada por nuestra API",
        odds && odds > 1 ? "Market odds real disponible" : null,
        row.captured_at ? "Market timestamp disponible" : null,
        modelProbability !== null ? "Model probability propia disponible" : null,
        expectedValue !== null && expectedValue > 0 ? "EV positivo contra mercado" : null,
        contextScore >= 61 ? "Contexto deportivo revisable" : null
      ].filter(Boolean);
      const whyNo = [
        !odds ? "Falta market odds real" : null,
        !row.captured_at ? "Falta market timestamp real" : null,
        modelProbability === null ? "Falta model_probability propia" : null,
        expectedValue === null ? "Falta EV calculable" : null,
        ...missing.map((item) => `Falta ${item}`),
        freshnessStatus !== "FRESH_LINE" && odds ? `Freshness ${freshnessStatus}` : null,
        "Falta closing_odds_snapshot para confirmar paper"
      ].filter(Boolean);
      return {
        match_id: row.match_id,
        match: `${row.home_team_name || "Home"} vs ${row.away_team_name || "Away"}`,
        sport: "soccer",
        league_id: row.league_slug,
        kickoff: row.kickoff,
        best_market: market,
        pick: row.market_selection || "none",
        odds,
        provider: row.provider_name || "-",
        odds_timestamp: row.captured_at || null,
        model_probability: modelProbability,
        fair_odds: numberOrNull(row.model_fair_odds),
        min_market_odds_for_ev: numberOrNull(row.min_market_odds_for_ev),
        expected_value: expectedValue,
        context_score: contextScore,
        market_score: marketScore,
        final_score: finalScore,
        status,
        bridge_status: row.bridge_status,
        calibration_state: row.calibration_state || null,
        model_family: row.model_family || null,
        target_model_family: row.target_model_family || null,
        why_yes: whyYes.length ? whyYes : ["Fair odds propia disponible"],
        why_no: whyNo.length ? whyNo : ["Sin bloqueos principales en esta vista; revisar cadena completa"],
        confirmed_pick: false,
        source_final_chain_status: chainRow.final_chain_status || row.bridge_status || "OWNED_FAIR_ODDS_BRIDGE",
        recommendation: status === "BETTABLE_PAPER"
          ? "Mejor lectura financiera Shadow Paper; falta closing/contexto final."
          : status === "READY_FOR_SHADOW_REVIEW"
            ? "Revisar Shadow Paper: nuestra cuota justa detecta posible valor."
            : status === "NO_FINANCIAL_BET"
              ? "No es apuesta: falta cuota real contra nuestra linea."
              : "Usar como lectura/review, no como apuesta."
      };
    });

    const statusRank = (status: unknown) => {
      const normalized = String(status || "").toUpperCase();
      if (normalized.includes("CONFIRMED")) return 6;
      if (normalized === "READY_FOR_SETTLEMENT") return 5;
      if (normalized === "BETTABLE_PAPER") return 5;
      if (normalized === "WAITING_VALID_CLOSING") return 4;
      if (normalized === "READY_FOR_SHADOW_REVIEW") return 4;
      if (normalized === "CALIBRATING") return 4;
      if (normalized === "SHADOW_TICKET_READY") return 3;
      if (normalized === "REVIEW_ONLY" || normalized === "POSITIVE_EV_WATCH") return 3;
      if (normalized === "CONTEXT_GAPS") return 2;
      if (normalized === "NO_FINANCIAL_BET") return 1;
      if (normalized === "POST_KICKOFF_AUDIT_ONLY") return 0;
      return 1;
    };
    const footballPreflight = isBaseballRequested
      ? { rows: [] as Array<Record<string, any>> }
      : await getMatchPreflightStatus(db, {
        date: requestedDate || String(matchCenter.date || matchCenter.requested_date || "") || undefined,
        sport: "soccer",
        limit: 300
      });
    const footballShadowRows = ((footballPreflight.rows || []) as Array<Record<string, any>>)
      .filter((row) => row.paper_trade_id && row.financial_ready && isSameRequestedDate(row.kickoff))
      .map((row) => {
        const odds = numberOrNull(row.entry_odds);
        const modelProbability = numberOrNull(row.model_probability);
        const expectedValue = numberOrNull(row.expected_value);
        const market = footballMarketLabel(row.market);
        const missing = asList(row.missing);
        const contextScore = row.context_ready ? 75 : Math.max(45, 68 - Math.min(25, missing.length * 4));
        const freshnessStatus = "SHADOW_TICKET_READY";
        const marketScore = marketScoreForCandidate({
          sport: "soccer",
          market,
          odds,
          modelProbability,
          expectedValue,
          freshnessStatus,
          finalStatus: String(row.preflight_status || "SHADOW_TICKET_READY").toUpperCase()
        });
        const finalScore = Math.max(0, Math.min(100, Math.round((contextScore * 0.45) + (marketScore * 0.45) + (expectedValue !== null && expectedValue > 0 ? 10 : 0))));
        const preflightStatus = String(row.preflight_status || "").toUpperCase();
        const status = preflightStatus === "POST_KICKOFF_AUDIT_ONLY"
          ? "POST_KICKOFF_AUDIT_ONLY"
          : preflightStatus === "READY_FOR_SETTLEMENT"
            ? "READY_FOR_SETTLEMENT"
            : preflightStatus === "WAITING_VALID_CLOSING"
              ? "WAITING_VALID_CLOSING"
              : row.context_ready
                ? "READY_FOR_SHADOW_REVIEW"
                : "SHADOW_TICKET_READY";
        const whyYes = [
          "Shadow ticket registrado en paper_trades",
          odds && odds > 1 ? "Entry odds verificadas" : null,
          modelProbability !== null ? "Model probability disponible" : null,
          expectedValue !== null ? "EV guardado en ticket shadow" : null,
          row.financial_ready ? "Capa financiera lista" : null
        ].filter(Boolean);
        const whyNo = [
          ...missing.map((item) => `Falta ${item}`),
          !row.closing_ready ? "Falta closing valido on-time" : null,
          row.closing_quality && !row.closing_ready ? `Closing no valido para CLV: ${row.closing_quality}` : null,
          row.context_ready ? null : "Contexto deportivo incompleto",
          "Football sigue shadow: UNCALIBRATED_PRIOR no confirma paper"
        ].filter(Boolean);
        return {
          match_id: row.match_id,
          paper_trade_id: row.paper_trade_id,
          match: row.match,
          sport: "soccer",
          league_id: row.league,
          kickoff: row.kickoff,
          match_status: row.match_status || row.ticket_status || null,
          best_market: market,
          pick: row.pick || "none",
          odds,
          provider: "football_shadow_ticket",
          odds_timestamp: row.kickoff || null,
          model_probability: modelProbability,
          fair_odds: modelProbability && modelProbability > 0 ? Number((1 / modelProbability).toFixed(4)) : null,
          expected_value: expectedValue,
          context_score: contextScore,
          market_score: marketScore,
          final_score: finalScore,
          status,
          bridge_status: "SHADOW_TICKET_REGISTERED",
          preflight_status: row.preflight_status,
          closing_quality: row.closing_quality || null,
          why_yes: whyYes.length ? whyYes : ["Shadow ticket registrado"],
          why_no: whyNo.length ? whyNo : ["Esperar closing/settlement; no confirmado"],
          confirmed_pick: false,
          source_final_chain_status: row.preflight_status || "SHADOW_TICKET_READY",
          recommendation: status === "WAITING_VALID_CLOSING"
            ? "Ticket shadow con odds/modelo/EV; esperar closing valido."
            : status === "READY_FOR_SETTLEMENT"
              ? "Ticket listo para settlement cuando exista resultado final verificado."
              : "Ticket shadow auditable; no confirmed paper ni dinero real."
        };
      });
    const bestByCanonicalMatch = new Map<string, Record<string, any>>();
    for (const row of [...baseRows, ...footballRows, ...footballBridgeRows, ...footballShadowRows]) {
      const key = `${row.sport || "unknown"}:${row.match_id || row.match || ""}`;
      const current = bestByCanonicalMatch.get(key);
      const rowRank = statusRank(row.status);
      const currentRank = statusRank(current?.status);
      if (!current
        || rowRank > currentRank
        || (rowRank === currentRank && Number(row.final_score || 0) > Number(current.final_score || 0))
        || (rowRank === currentRank && Number(row.final_score || 0) === Number(current.final_score || 0) && Number(row.expected_value || -999) > Number(current.expected_value || -999))) {
        bestByCanonicalMatch.set(key, row);
      }
    }
    const rows = Array.from(bestByCanonicalMatch.values()).sort((a, b) => Number(b.final_score || 0) - Number(a.final_score || 0));
    const countStatus = (status: string) => rows.filter((row) => row.status === status).length;
    return {
      date: matchCenter.date || requestedDate || null,
      requested_date: matchCenter.requested_date || requestedDate || null,
      system_status: "BEST_BETS_PER_MATCH_READ_ONLY",
      summary: {
        matches: rows.length,
        confirmed_paper: countStatus("CONFIRMED_PAPER"),
        football_confirmed_paper: countStatus("FOOTBALL_CONFIRMED_PAPER"),
        bettable_paper: countStatus("BETTABLE_PAPER"),
        shadow_ticket_ready: countStatus("SHADOW_TICKET_READY"),
        ready_for_shadow_review: countStatus("READY_FOR_SHADOW_REVIEW"),
        calibrating: countStatus("CALIBRATING"),
        waiting_valid_closing: countStatus("WAITING_VALID_CLOSING"),
        ready_for_settlement: countStatus("READY_FOR_SETTLEMENT"),
        review_only: countStatus("REVIEW_ONLY"),
        context_gaps: countStatus("CONTEXT_GAPS"),
        post_kickoff_audit_only: countStatus("POST_KICKOFF_AUDIT_ONLY"),
        no_financial_bet: countStatus("NO_FINANCIAL_BET"),
        no_bet: countStatus("NO_BET")
      },
      rows,
      recommendation: "Best Bet Per Match separa mejor lectura por partido de pick confirmado. No activa dinero real.",
      guardrails: matchCenter.guardrails
    };
  }

  async function runNearStartContext(rawQuery: unknown = {}, rawBody: unknown = {}) {
    const input = {
      ...(rawQuery && typeof rawQuery === "object" ? rawQuery as Record<string, unknown> : {}),
      ...(rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {})
    };
    const query = z.object({
      date: z.string().optional(),
      fallback_recent: booleanQuery(true),
      apply: booleanQuery(false)
    }).parse(input);

    const runAt = new Date();
    const runAtIso = runAt.toISOString();
    const matchCenter = await buildMatchCenter({ date: query.date, fallback_recent: query.fallback_recent }) as Record<string, any>;
    const bestBets = await buildBestBetsPerMatch({ date: matchCenter.date || query.date, fallback_recent: query.fallback_recent }) as Record<string, any>;
    const matches = Array.isArray(matchCenter.matches) ? matchCenter.matches as Array<Record<string, any>> : [];
    const bestRows = Array.isArray(bestBets.rows) ? bestBets.rows as Array<Record<string, any>> : [];

    const upper = (value: unknown) => String(value || "").toUpperCase();
    const asList = (value: unknown): string[] => Array.isArray(value)
      ? value.map((item) => String(item)).filter(Boolean)
      : [];
    const numberOrNull = (value: unknown): number | null => {
      if (value === null || value === undefined || value === "") return null;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    };
    const normalize = (value: unknown) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const matchLabel = (match: Record<string, any>) => `${match.home_team || "Home"} vs ${match.away_team || "Away"}`;
    const keyForMatch = (match: Record<string, any>) => String(match.match_id || match.canonical_match_id || match.provider_match_id || normalize(matchLabel(match)));
    const keyForBestRow = (row: Record<string, any>) => String(row.match_id || normalize(row.match));
    const bestByMatch = new Map<string, Record<string, any>>();
    for (const row of bestRows) {
      bestByMatch.set(keyForBestRow(row), row);
    }

    const hasObjectData = (value: unknown) => {
      if (!value) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
      return Boolean(value);
    };
    const isConfirmed = (value: unknown) => upper(value).includes("CONFIRMED") || upper(value).includes("OFFICIAL");
    const isMlbMatch = (match: Record<string, any>) => {
      const text = [match.sport, match.league_id, match.league_name].map(upper).join(" ");
      return text.includes("BASEBALL") && (text.includes("MLB") || text.includes("MAJOR LEAGUE BASEBALL"));
    };
    const missingText = (missing: string[], needle: string) => missing.some((item) => upper(item).includes(needle));

    const rows = matches.filter(isMlbMatch).map((match) => {
      const detail = match.detail && typeof match.detail === "object" ? match.detail as Record<string, any> : {};
      const pickChain = match.pick_chain && typeof match.pick_chain === "object" ? match.pick_chain as Record<string, any> : {};
      const settlement = match.settlement && typeof match.settlement === "object" ? match.settlement as Record<string, any> : {};
      const oddsDetail = match.odds_detail && typeof match.odds_detail === "object" ? match.odds_detail as Record<string, any> : {};
      const missing = [
        ...asList(detail.missing_context_fields),
        ...asList(pickChain.missing_context_fields),
        ...asList(match.missing_context_fields)
      ].filter((value, index, list) => list.indexOf(value) === index);
      const best = bestByMatch.get(keyForMatch(match)) || bestByMatch.get(normalize(matchLabel(match))) || {};
      const kickoff = new Date(String(match.start_time || match.kickoff || ""));
      const statusText = upper(match.status || match.game_status || detail.status);
      const postKickoff = statusText.includes("LIVE")
        || statusText.includes("FINISHED")
        || statusText.includes("FINAL")
        || (!Number.isNaN(kickoff.getTime()) && kickoff.getTime() <= runAt.getTime());

      const homeLineupStatus = detail.home_lineup_status ?? detail.lineup_home_status ?? match.home_lineup_status ?? detail.home_lineup?.status;
      const awayLineupStatus = detail.away_lineup_status ?? detail.lineup_away_status ?? match.away_lineup_status ?? detail.away_lineup?.status;
      const homeLineupPresent = isConfirmed(homeLineupStatus) || hasObjectData(detail.home_lineup) || hasObjectData(match.home_lineup);
      const awayLineupPresent = isConfirmed(awayLineupStatus) || hasObjectData(detail.away_lineup) || hasObjectData(match.away_lineup);
      const homeLineupConfirmed = isConfirmed(homeLineupStatus);
      const awayLineupConfirmed = isConfirmed(awayLineupStatus);
      const battingOrderComplete = Boolean(detail.batting_order_complete || detail.lineup_complete || match.batting_order_complete)
        || (homeLineupConfirmed && awayLineupConfirmed && !missingText(missing, "BATTING") && !missingText(missing, "LINEUP"));
      const pitcherContext = Boolean(detail.pitcher_context || match.pitcher_context || detail.pitchers_confirmed || detail.probable_home_pitcher || detail.probable_away_pitcher)
        || !missingText(missing, "PITCHER");
      const bullpenContext = Boolean(detail.bullpen_context || match.bullpen_context || detail.bullpen_fatigue_score || detail.bullpen_home_fatigue_score || detail.bullpen_away_fatigue_score)
        || !missingText(missing, "BULLPEN");
      const travelRestContext = Boolean(detail.travel_rest_context || match.travel_rest_context || detail.rest_travel_home_status || detail.rest_travel_away_status)
        || (!missingText(missing, "TRAVEL") && !missingText(missing, "REST"));
      const closingOddsSnapshot = Boolean(
        detail.closing_odds_snapshot
        || detail.closing_odds
        || oddsDetail.closing_odds
        || settlement.closing_odds
        || settlement.closing_captured
        || match.closing_odds_snapshot
      );

      const contextScore = numberOrNull(best.context_score) ?? numberOrNull(match.context_completeness_score) ?? 0;
      const marketScore = numberOrNull(best.market_score) ?? 0;
      const finalScore = numberOrNull(best.final_score) ?? 0;
      const market = String(best.best_market || match.pick?.market || detail.market || "moneyline_2way");
      let status = String(best.status || match.final_chain_status || "REVIEW_ONLY").toUpperCase();
      const whyYes = Array.isArray(best.why_yes) ? [...best.why_yes] : [];
      const whyNo = Array.isArray(best.why_no) ? [...best.why_no] : [];

      if (postKickoff) {
        status = "POST_KICKOFF_AUDIT_ONLY";
        whyNo.unshift("El partido ya inició; solo auditoría, no nuevos picks.");
      } else if (!homeLineupPresent || !awayLineupPresent) {
        status = "CONTEXT_GAPS";
        whyNo.unshift("Falta lineup home/away verificable.");
      } else if (!battingOrderComplete) {
        status = "CONTEXT_GAPS";
        whyNo.unshift("Falta batting order completo.");
      } else if (!closingOddsSnapshot) {
        status = finalScore >= 75 ? "BETTABLE_PAPER" : status;
        whyNo.unshift("Falta closing odds snapshot; máximo BETTABLE_PAPER.");
      } else if (market === "moneyline_2way" && finalScore >= 85 && contextScore >= 85 && marketScore >= 75) {
        status = "CONFIRMED_PAPER";
        whyYes.unshift("Contexto, mercado y closing cumplen umbrales paper.");
      } else if (["run_line", "total_runs"].includes(market)) {
        status = "REVIEW_ONLY";
        whyNo.unshift("Run line/totals siguen analysis-only.");
      }

      return {
        match_id: match.match_id,
        match: matchLabel(match),
        kickoff: match.start_time || match.kickoff || null,
        previous_status: best.status || match.final_chain_status || "NO_DATA",
        status,
        confirmed_pick: status === "CONFIRMED_PAPER",
        best_market: market,
        pick: best.pick || match.recommended_pick || match.pick?.selection || "none",
        context_score: contextScore,
        market_score: marketScore,
        final_score: finalScore,
        pitcher_context: pitcherContext ? "LOADED_OR_NOT_MISSING" : "MISSING",
        bullpen_context: bullpenContext ? "LOADED_OR_NOT_MISSING" : "MISSING",
        lineup_context: homeLineupPresent && awayLineupPresent ? (homeLineupConfirmed && awayLineupConfirmed ? "CONFIRMED_BOTH" : "LINEUP_PRESENT_REVIEW") : "MISSING",
        batting_order_complete: battingOrderComplete,
        home_lineup: homeLineupStatus || (homeLineupPresent ? "PRESENT" : "MISSING"),
        away_lineup: awayLineupStatus || (awayLineupPresent ? "PRESENT" : "MISSING"),
        travel_rest_context: travelRestContext ? "LOADED_OR_NOT_MISSING" : "MISSING",
        closing_odds_snapshot: closingOddsSnapshot ? "CAPTURED" : "MISSING",
        why_yes: whyYes.filter((value, index, list) => list.indexOf(value) === index),
        why_no: whyNo.filter((value, index, list) => list.indexOf(value) === index),
        missing_context_fields: missing,
        recommendation: status === "CONFIRMED_PAPER"
          ? "Confirmado solo en paper; dinero real sigue apagado."
          : status === "POST_KICKOFF_AUDIT_ONLY"
            ? "Guardar para auditoría/settlement; no modificar decisión pregame."
            : status === "BETTABLE_PAPER"
              ? "Buen candidato paper; falta cierre o validación final."
              : "Mantener review/context gaps hasta que llegue dato oficial."
      };
    });

    const count = (status: string) => rows.filter((row) => row.status === status).length;
    const promotedToBettable = rows.filter((row) => row.status === "BETTABLE_PAPER" && row.previous_status !== "BETTABLE_PAPER").length;
    const promotedToConfirmed = rows.filter((row) => row.status === "CONFIRMED_PAPER" && row.previous_status !== "CONFIRMED_PAPER").length;
    return {
      date: matchCenter.date || query.date || null,
      requested_date: matchCenter.requested_date || query.date || null,
      generated_at: runAtIso,
      last_near_start_run_at: runAtIso,
      system_status: "NEAR_START_CONTEXT_RUNNER_SAFE",
      persistence_mode: "DERIVED_RECALC_ONLY",
      dry_run: !query.apply,
      apply_requested: query.apply,
      apply_effect: "No escribe datos inventados; recalcula con contexto ya verificado.",
      summary: {
        scanned: rows.length,
        updated: rows.length,
        promoted_to_bettable_paper: promotedToBettable,
        promoted_to_confirmed_paper: promotedToConfirmed,
        blocked_post_kickoff: count("POST_KICKOFF_AUDIT_ONLY"),
        still_context_gaps: count("CONTEXT_GAPS")
      },
      rows,
      recommendation: "Ejecuta el worker near-start real antes de este runner para hidratar lineups/closing verificables.",
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_paper_only: true,
        kill_switch_enabled: true
      }
    };
  }

  async function runFootballNearStartContext(rawQuery: unknown = {}, rawBody: unknown = {}) {
    const input = {
      ...(rawQuery && typeof rawQuery === "object" ? rawQuery as Record<string, unknown> : {}),
      ...(rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {})
    };
    const query = z.object({
      date: z.string().optional(),
      fallback_recent: booleanQuery(true),
      apply: booleanQuery(false)
    }).parse(input);

    const runAt = new Date();
    const runAtIso = runAt.toISOString();
    const bestBets = await buildBestBetsPerMatch({
      date: query.date,
      fallback_recent: query.fallback_recent,
      sport: "soccer"
    }) as Record<string, any>;
    const chain = await getFootballConfirmedPickChain(db) as Record<string, any>;
    const bestRows = Array.isArray(bestBets.rows) ? bestBets.rows as Array<Record<string, any>> : [];
    const chainRows = Array.isArray(chain.rows) ? chain.rows as Array<Record<string, any>> : [];

    const requestedDate = String(bestBets.date || bestBets.requested_date || query.date || "");
    const inRequestedDate = (kickoff: unknown) => {
      if (!requestedDate) return true;
      const date = new Date(String(kickoff || ""));
      if (Number.isNaN(date.getTime())) return false;
      const window = localDateWindow(requestedDate);
      return date.getTime() >= new Date(window.start).getTime() && date.getTime() < new Date(window.end).getTime();
    };
    const upper = (value: unknown) => String(value || "").toUpperCase();
    const asList = (value: unknown): string[] => Array.isArray(value)
      ? value.map((item) => String(item)).filter(Boolean)
      : [];
    const numberOrNull = (value: unknown): number | null => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    };
    const normalize = (value: unknown) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const chainById = new Map<string, Record<string, any>>();
    for (const row of chainRows.filter((row) => inRequestedDate(row.kickoff))) {
      chainById.set(String(row.match_id || normalize(row.match)), row);
    }

    const layerState = (layers: Record<string, any>, key: string, fallback = "UNKNOWN") => {
      const layer = layers[key] && typeof layers[key] === "object" ? layers[key] as Record<string, any> : {};
      return String(layer.state || fallback);
    };
    const layerValue = (layers: Record<string, any>, key: string) => {
      const layer = layers[key] && typeof layers[key] === "object" ? layers[key] as Record<string, any> : {};
      return numberOrNull(layer.value) ?? 0;
    };
    const classifyLineup = (playerStatus: string, lineupState: string) => {
      const combined = `${playerStatus} ${lineupState}`.toUpperCase();
      if (combined.includes("OFFICIAL") || combined.includes("CONFIRMED") || combined.includes("VERIFIED") || combined.includes("SUPPORTS")) return "VERIFIED_OR_OFFICIAL";
      if (combined.includes("PENDING") || combined.includes("PROJECTED")) return "PENDING_OR_PROJECTED";
      if (combined.includes("CONFLICT") || combined.includes("ALERT")) return "REVIEW";
      return "UNKNOWN";
    };

    const rows = bestRows.map((best) => {
      const chainRow = chainById.get(String(best.match_id || normalize(best.match))) || {};
      const layers = chainRow.football_context_layers && typeof chainRow.football_context_layers === "object"
        ? chainRow.football_context_layers as Record<string, any>
        : {};
      const marketLayer = chainRow.market_layer && typeof chainRow.market_layer === "object"
        ? chainRow.market_layer as Record<string, any>
        : {};
      const missing = [
        ...asList(best.why_no)
          .filter((item) => item.toLowerCase().startsWith("falta "))
          .map((item) => item.replace(/^Falta\s+/i, "")),
        ...asList(chainRow.missing_context_fields)
      ].filter((value, index, list) => value && list.indexOf(value) === index);
      const kickoff = new Date(String(best.kickoff || chainRow.kickoff || ""));
      const postKickoff = !Number.isNaN(kickoff.getTime()) && kickoff.getTime() <= runAt.getTime();
      const playerStatus = String(chainRow.player_intelligence_status || chainRow.player_status || "");
      const teamStatus = String(chainRow.team_intelligence_status || chainRow.team_status || "");
      const lineupState = layerState(layers, "lineup_official_status", playerStatus || "UNKNOWN");
      const homeLineup = classifyLineup(playerStatus, lineupState);
      const awayLineup = classifyLineup(playerStatus, lineupState);
      const goalkeeperState = layerState(layers, "portero_titular");
      const injuriesState = layerState(layers, "key_players_absent");
      const travelRestState = layerState(layers, "descanso_viaje_calendario");
      const closingState = layerState(layers, "closing_odds_tracking", String(marketLayer.status || "UNKNOWN"));
      const hasFinancialLayer = Boolean(best.odds && best.odds_timestamp && best.model_probability !== null && best.expected_value !== null);
      const closingOddsSnapshot = Boolean(chainRow.closing_odds_snapshot || chainRow.closing_odds || layerValue(layers, "closing_odds_tracking") >= 10);
      const contextScore = numberOrNull(best.context_score) ?? 0;
      const marketScore = numberOrNull(best.market_score) ?? 0;
      const finalScore = numberOrNull(best.final_score) ?? 0;
      const market = String(best.best_market || chainRow.market || "");
      let status = String(best.status || "REVIEW_ONLY").toUpperCase();
      const whyYes = Array.isArray(best.why_yes) ? [...best.why_yes] : [];
      const whyNo = Array.isArray(best.why_no) ? [...best.why_no] : [];

      if (postKickoff) {
        status = "POST_KICKOFF_AUDIT_ONLY";
        whyNo.unshift("El partido ya inicio; solo auditoria post-kickoff.");
      } else if (!hasFinancialLayer) {
        status = "NO_FINANCIAL_BET";
        whyNo.unshift("Falta capa financiera completa: odds, timestamp, modelo o EV.");
      } else if (market === "btts_review_only" || market === "btts") {
        status = "REVIEW_ONLY";
        whyNo.unshift("BTTS se mantiene solo en revision/manual.");
      } else if (homeLineup !== "VERIFIED_OR_OFFICIAL" || awayLineup !== "VERIFIED_OR_OFFICIAL" || injuriesState.toUpperCase().includes("PENDING")) {
        status = "CONTEXT_GAPS";
        whyNo.unshift("Falta lineup oficial/verificado o reporte de bajas resuelto.");
      } else if (!closingOddsSnapshot) {
        status = finalScore >= 75 ? "BETTABLE_PAPER" : status;
        whyNo.unshift("Falta closing odds snapshot; maximo BETTABLE_PAPER.");
      } else if (finalScore >= 85 && contextScore >= 80 && marketScore >= 75 && ["moneyline_3way", "draw_no_bet", "total_goals_2_5"].includes(market)) {
        status = "FOOTBALL_CONFIRMED_PAPER";
        whyYes.unshift("Contexto futbol, mercado y closing cumplen umbrales shadow.");
      } else if (finalScore >= 65 && ["REVIEW_ONLY", "CONTEXT_GAPS"].includes(status)) {
        status = "READY_FOR_SHADOW_REVIEW";
        whyYes.unshift("Tiene senal financiera/contextual para revision shadow.");
      }

      return {
        match_id: best.match_id,
        match: best.match,
        league_id: best.league_id,
        kickoff: best.kickoff || chainRow.kickoff || null,
        previous_status: best.status || chainRow.final_chain_status || "NO_DATA",
        status,
        confirmed_pick: status === "FOOTBALL_CONFIRMED_PAPER",
        best_market: market,
        pick: best.pick || chainRow.pick || "none",
        odds: best.odds ?? null,
        odds_timestamp: best.odds_timestamp ?? null,
        model_probability: best.model_probability ?? null,
        expected_value: best.expected_value ?? null,
        context_score: contextScore,
        market_score: marketScore,
        final_score: finalScore,
        home_lineup: homeLineup,
        away_lineup: awayLineup,
        goalkeeper_home: goalkeeperState,
        goalkeeper_away: goalkeeperState,
        formation_home: "PENDING_SOURCE",
        formation_away: "PENDING_SOURCE",
        injuries_context: injuriesState,
        suspensions_context: "PENDING_SOURCE",
        travel_rest_context: travelRestState || teamStatus || "UNKNOWN",
        closing_odds_snapshot: closingOddsSnapshot ? "CAPTURED" : "MISSING",
        missing_context_fields: missing,
        why_yes: whyYes.filter((value, index, list) => list.indexOf(value) === index),
        why_no: whyNo.filter((value, index, list) => list.indexOf(value) === index),
        recommendation: status === "FOOTBALL_CONFIRMED_PAPER"
          ? "Confirmado solo Shadow Paper; dinero real sigue apagado."
          : status === "BETTABLE_PAPER"
            ? "Buen candidato shadow; esperar closing/final validation."
            : status === "READY_FOR_SHADOW_REVIEW"
              ? "Listo para revision shadow; falta confirmacion final."
              : status === "NO_FINANCIAL_BET"
                ? "No es apuesta: falta odds/modelo/EV reales."
                : status === "POST_KICKOFF_AUDIT_ONLY"
                  ? "Solo auditoria; no modificar decision pregame."
                  : "Mantener en review hasta resolver contexto."
      };
    });

    const count = (status: string) => rows.filter((row) => row.status === status).length;
    return {
      date: bestBets.date || query.date || null,
      requested_date: bestBets.requested_date || query.date || null,
      generated_at: runAtIso,
      last_football_near_start_run_at: runAtIso,
      system_status: "FOOTBALL_NEAR_START_CONTEXT_RUNNER_SAFE",
      persistence_mode: "DERIVED_RECALC_ONLY",
      dry_run: !query.apply,
      apply_requested: query.apply,
      apply_effect: "No escribe alineaciones ni cuotas inventadas; solo recalcula estados con datos verificados existentes.",
      summary: {
        scanned: rows.length,
        updated: rows.length,
        promoted_to_ready_for_shadow_review: count("READY_FOR_SHADOW_REVIEW"),
        promoted_to_bettable_paper: count("BETTABLE_PAPER"),
        promoted_to_football_confirmed_paper: count("FOOTBALL_CONFIRMED_PAPER"),
        blocked_post_kickoff: count("POST_KICKOFF_AUDIT_ONLY"),
        still_context_gaps: count("CONTEXT_GAPS"),
        no_financial_bet: count("NO_FINANCIAL_BET")
      },
      rows,
      recommendation: "Primero cargar odds/model_probability/EV con football-owned-signals; luego correr near-start 60-30 min antes del kickoff.",
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        shadow_paper_only_for_football: true,
        kill_switch_enabled: true
      }
    };
  }

  async function buildFootballPerformanceSegments(rawQuery: unknown = {}) {
    const query = footballPerformanceSegmentsQuerySchema.parse(rawQuery);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Matamoros" });
    const fromWindow = localDateWindow(query.date_from || shiftLocalDate(today, -90));
    const toWindow = localDateWindow(query.date_to || today);
    const values = [
      fromWindow.start,
      toWindow.end,
      query.min_closed,
      MIN_BRIER_CLOSED_SAMPLE,
      MIN_LOG_LOSS_CLOSED_SAMPLE,
      MIN_TRAINER_SAMPLE,
      query.limit
    ];

    const result = await db.query(
      `
        WITH base AS (
          SELECT
            pt.id,
            pt.match_id,
            pt.league_slug,
            pt.market_type,
            pt.selection,
            pt.status,
            pt.market_odds,
            pt.expected_value,
            pt.model_probability,
            pt.net_profit,
            pt.created_at,
            pt.raw_data,
            CASE WHEN pt.status IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED') THEN TRUE ELSE FALSE END AS is_closed,
            CASE
              WHEN NULLIF(pt.raw_data->>'closing_odds', '') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (pt.raw_data->>'closing_odds')::numeric
              ELSE NULL
            END AS closing_odds,
            CASE
              WHEN pt.raw_data->>'closing_quality' = 'CAPTURED_ON_TIME'
                AND NULLIF(pt.raw_data->>'clv', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                THEN (pt.raw_data->>'clv')::numeric
              ELSE NULL
            END AS clv,
            CASE
              WHEN NULLIF(pt.raw_data->>'model_vs_market_gap', '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (pt.raw_data->>'model_vs_market_gap')::numeric
              ELSE NULL
            END AS model_vs_market_gap,
            COALESCE(pt.raw_data->>'closing_quality', CASE WHEN pt.raw_data ? 'closing_odds' THEN 'UNKNOWN' ELSE 'MISSING' END) AS closing_quality,
            pt.raw_data->>'clv_band' AS clv_band
          FROM paper_trades pt
          WHERE pt.league_type = 'football_shadow'
            AND pt.created_at >= $1::timestamptz
            AND pt.created_at < $2::timestamptz
        ),
        tagged AS (
          SELECT
            b.*,
            split_part(tag, ':', 1) AS segment_type,
            split_part(tag, ':', 2) AS segment_value
          FROM base b
          CROSS JOIN LATERAL unnest(ARRAY[
            'overall:all',
            'league:' || COALESCE(b.league_slug, 'unknown'),
            'market:' || COALESCE(b.market_type, 'unknown'),
            'selection:' || COALESCE(b.selection, 'unknown'),
            CASE
              WHEN b.market_odds >= 7 THEN 'price:longshot_7_plus'
              WHEN b.market_odds >= 4 THEN 'price:underdog_4_plus'
              WHEN b.market_odds >= 2 THEN 'price:plus_price_2_plus'
              ELSE 'price:favorite_or_mid'
            END,
            CASE
              WHEN b.selection = 'draw' THEN 'pick_type:draw'
              WHEN b.selection IN ('home', 'home_dnb', 'home_draw', 'home_away') THEN 'pick_type:home_side'
              WHEN b.selection IN ('away', 'away_dnb', 'draw_away') THEN 'pick_type:away_side'
              WHEN b.selection LIKE 'over%' THEN 'pick_type:over'
              WHEN b.selection LIKE 'under%' THEN 'pick_type:under'
              ELSE 'pick_type:other'
            END,
            CASE
              WHEN b.clv > 0 THEN 'clv:positive'
              WHEN b.clv < 0 THEN 'clv:negative'
              WHEN b.is_closed THEN 'clv:missing_or_zero'
              ELSE 'clv:open'
            END,
            CASE
              WHEN b.expected_value >= 0.6 THEN 'audit:EXTREME_EV_AUDIT'
              WHEN b.expected_value >= 0.3 THEN 'audit:AGGRESSIVE_VALUE_AUDIT'
              WHEN b.expected_value >= 0.15 THEN 'audit:HIGH_VALUE_REVIEW'
              ELSE 'audit:NORMAL_EV'
            END,
            CASE
              WHEN b.model_vs_market_gap IS NOT NULL AND ABS(b.model_vs_market_gap) >= 0.12 THEN 'audit:MODEL_MARKET_GAP_HIGH'
              ELSE 'audit:MODEL_MARKET_GAP_NORMAL'
            END,
            'closing_quality:' || COALESCE(b.closing_quality, 'MISSING'),
            'clv_band:' || COALESCE(b.clv_band, CASE
              WHEN b.clv > 0 THEN 'POSITIVE'
              WHEN b.clv = 0 THEN 'NEUTRAL'
              WHEN b.clv < 0 THEN 'NEGATIVE'
              ELSE 'MISSING'
            END)
          ]) AS tag
        ),
        grouped AS (
          SELECT
            segment_type,
            segment_value,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_closed)::int AS closed,
            COUNT(*) FILTER (WHERE NOT is_closed)::int AS open,
            COUNT(DISTINCT match_id) FILTER (WHERE is_closed)::int AS distinct_closed_matches,
            COUNT(DISTINCT created_at::date) FILTER (WHERE is_closed)::int AS distinct_closed_days,
            COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
            COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
            COUNT(*) FILTER (WHERE status = 'PUSH')::int AS pushes,
            COUNT(*) FILTER (WHERE closing_odds IS NOT NULL AND closing_quality = 'CAPTURED_ON_TIME')::int AS valid_closing_count,
            COUNT(*) FILTER (WHERE closing_odds IS NOT NULL AND closing_quality IS DISTINCT FROM 'CAPTURED_ON_TIME')::int AS invalid_closing_count,
            ROUND(AVG(market_odds) FILTER (WHERE market_odds IS NOT NULL)::numeric, 4) AS avg_entry_odds,
            ROUND(AVG(closing_odds) FILTER (WHERE closing_odds IS NOT NULL AND closing_quality = 'CAPTURED_ON_TIME')::numeric, 4) AS avg_closing_odds,
            ROUND(AVG(expected_value) FILTER (WHERE expected_value IS NOT NULL)::numeric, 6) AS avg_ev,
            ROUND(AVG(model_probability) FILTER (WHERE model_probability IS NOT NULL)::numeric, 6) AS avg_model_probability,
            ROUND(AVG(model_vs_market_gap) FILTER (WHERE model_vs_market_gap IS NOT NULL)::numeric, 6) AS avg_model_vs_market_gap,
            ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
            COUNT(*) FILTER (WHERE clv IS NOT NULL)::int AS valid_clv_count,
            COUNT(*) FILTER (WHERE clv > 0)::int AS positive_clv,
            ROUND(COALESCE(SUM(net_profit) FILTER (WHERE is_closed), 0)::numeric, 4) AS profit_units,
            ROUND((AVG(net_profit) FILTER (WHERE is_closed))::numeric, 6) AS roi_mean_units,
            ROUND((STDDEV_SAMP(net_profit) FILTER (WHERE is_closed))::numeric, 6) AS roi_stddev_units,
            ROUND((
              AVG(net_profit) FILTER (WHERE is_closed)
              - 1.96 * (COALESCE(STDDEV_SAMP(net_profit) FILTER (WHERE is_closed), 0) / NULLIF(SQRT(COUNT(*) FILTER (WHERE is_closed)::numeric), 0))
            )::numeric, 6) AS roi_ci_95_low,
            ROUND((
              AVG(net_profit) FILTER (WHERE is_closed)
              + 1.96 * (COALESCE(STDDEV_SAMP(net_profit) FILTER (WHERE is_closed), 0) / NULLIF(SQRT(COUNT(*) FILTER (WHERE is_closed)::numeric), 0))
            )::numeric, 6) AS roi_ci_95_high,
            ROUND((AVG(POWER((CASE WHEN status = 'WIN' THEN 1 WHEN status = 'LOSS' THEN 0 ELSE NULL END) - model_probability, 2)) FILTER (WHERE is_closed AND status IN ('WIN', 'LOSS') AND model_probability IS NOT NULL))::numeric, 6) AS raw_brier_preview,
            ROUND((AVG(
              CASE
                WHEN status = 'WIN' AND model_probability IS NOT NULL THEN -LN(GREATEST(LEAST(model_probability, 0.999999), 0.000001))
                WHEN status = 'LOSS' AND model_probability IS NOT NULL THEN -LN(GREATEST(LEAST(1 - model_probability, 0.999999), 0.000001))
                ELSE NULL
              END
            ) FILTER (WHERE is_closed AND status IN ('WIN', 'LOSS') AND model_probability IS NOT NULL))::numeric, 6) AS raw_log_loss_preview
          FROM tagged
          GROUP BY segment_type, segment_value
        )
        SELECT
          *,
          closed::int AS metric_sample_n,
          $4::int AS brier_sample_min,
          $5::int AS log_loss_sample_min,
          $6::int AS trainer_sample_min,
          CASE WHEN closed >= $4 THEN TRUE ELSE FALSE END AS brier_available,
          CASE WHEN closed >= $5 THEN TRUE ELSE FALSE END AS log_loss_available,
          CASE WHEN closed >= LEAST($4, $5) THEN 'READY_FOR_METRIC_DISPLAY' ELSE 'INSUFFICIENT_SAMPLE' END AS metric_sample_status,
          CASE WHEN closed >= $4 THEN raw_brier_preview ELSE NULL END AS brier,
          CASE WHEN closed >= $5 THEN raw_log_loss_preview ELSE NULL END AS log_loss,
          CASE
            WHEN closed >= $4 AND raw_brier_preview IS NOT NULL THEN raw_brier_preview::text
            ELSE 'n/a (' || closed::text || '/' || $4::text || ' minimo)'
          END AS brier_display,
          CASE
            WHEN closed >= $5 AND raw_log_loss_preview IS NOT NULL THEN raw_log_loss_preview::text
            ELSE 'n/a (' || closed::text || '/' || $5::text || ' minimo)'
          END AS log_loss_display,
          CASE WHEN closed >= LEAST($4, $5) THEN TRUE ELSE FALSE END AS raw_metrics_are_decision_eligible,
          CASE
            WHEN LEAST(closed, valid_clv_count, GREATEST(distinct_closed_matches, 0)) >= $6
              AND valid_closing_count >= $6
              THEN 'READY_FOR_RESEARCH_TRAINER'
            ELSE 'NOT_READY_CLOSING_SAMPLE_INSUFFICIENT'
          END AS dixon_coles_readiness,
          CASE WHEN wins + losses > 0 THEN ROUND((wins::numeric / (wins + losses)), 6) ELSE NULL END AS win_rate,
          CASE WHEN valid_clv_count > 0 THEN ROUND((positive_clv::numeric / valid_clv_count), 6) ELSE NULL END AS positive_clv_rate,
          LEAST(closed, valid_clv_count, GREATEST(distinct_closed_matches, 0))::int AS valid_decision_sample,
          GREATEST($3 - LEAST(closed, valid_clv_count, GREATEST(distinct_closed_matches, 0)), 0)::int AS sample_remaining,
          $3::int AS sample_required,
          (LEAST(closed, valid_clv_count, GREATEST(distinct_closed_matches, 0))::text || '/' || $3::text) AS closed_min_sample_display,
          CASE WHEN closed > 0 THEN ROUND((distinct_closed_matches::numeric / closed), 6) ELSE NULL END AS dependency_ratio,
          CASE
            WHEN total > 0 AND valid_closing_count = 0 THEN 'WAITING_VALID_CLOSING'
            WHEN invalid_closing_count > 0 THEN 'CLOSING_QUALITY_REVIEW'
            WHEN LEAST(closed, valid_clv_count, GREATEST(distinct_closed_matches, 0)) < $3 THEN 'INSUFFICIENT_SAMPLE'
            ELSE 'READY_FOR_SEGMENT_DECISION'
          END AS segment_visual_status,
          CASE
            WHEN LEAST(closed, valid_clv_count, GREATEST(distinct_closed_matches, 0)) < $3 THEN 'INSUFFICIENT_SAMPLE'
            WHEN avg_clv IS NULL THEN 'KEEP_SHADOW'
            WHEN avg_clv > 0 AND profit_units > 0 AND COALESCE(roi_ci_95_low, -999) >= 0 AND raw_brier_preview IS NOT NULL AND raw_brier_preview <= 0.21 THEN 'PROMOTE_WATCH'
            WHEN avg_clv > 0 AND profit_units > 0 THEN 'KEEP_SHADOW'
            WHEN avg_clv > 0 AND profit_units <= 0 THEN 'KEEP_SHADOW'
            WHEN avg_clv < 0 AND profit_units <= 0 THEN 'BLOCK_SEGMENT'
            WHEN avg_clv < 0 AND profit_units > 0 THEN 'REDUCE_EXPOSURE'
            WHEN profit_units <= 0 THEN 'KEEP_SHADOW'
            ELSE 'REDUCE_EXPOSURE'
          END AS decision,
          CASE
            WHEN total > 0 AND valid_closing_count = 0 THEN 'Sin closing valido; capturar CAPTURED_ON_TIME antes de usar CLV o promover segmentos.'
            WHEN invalid_closing_count > 0 THEN 'Hay closings fuera de ventana; CLV invalido para decision hasta capturar cierre correcto.'
            WHEN LEAST(closed, valid_clv_count, GREATEST(distinct_closed_matches, 0)) < $3 THEN 'Muestra insuficiente o dependiente; seguir acumulando shadow sin promover.'
            WHEN avg_clv IS NULL THEN 'Falta CLV/closing; mantener shadow y cerrar tickets antes de decidir.'
            WHEN avg_clv > 0 AND profit_units > 0 AND COALESCE(roi_ci_95_low, -999) >= 0 AND raw_brier_preview IS NOT NULL AND raw_brier_preview <= 0.21 THEN 'CLV, profit, Brier y ROI CI apoyan watchlist shadow; no autoriza dinero real.'
            WHEN avg_clv > 0 AND profit_units > 0 THEN 'CLV/profit positivos, pero Brier o intervalo ROI aun no pasan gate; mantener shadow.'
            WHEN avg_clv > 0 AND profit_units <= 0 THEN 'CLV apoya, pero profit/muestra no; mantener en shadow.'
            WHEN avg_clv < 0 AND profit_units <= 0 THEN 'CLV y profit no apoyan; bloquear o reducir este segmento.'
            WHEN avg_clv < 0 AND profit_units > 0 THEN 'Profit positivo sin CLV; posible varianza, reducir confianza.'
            WHEN profit_units <= 0 THEN 'CLV neutral y profit no apoya; mantener shadow.'
            ELSE 'Profit positivo sin ventaja de cierre; reducir confianza y seguir auditando.'
          END AS recommendation,
          CASE
            WHEN total > 0 AND valid_closing_count = 0 THEN 'waiting_valid_closing'
            WHEN invalid_closing_count > 0 THEN 'closing_quality_review'
            WHEN LEAST(closed, valid_clv_count, GREATEST(distinct_closed_matches, 0)) < $3 THEN 'sample_below_threshold_or_dependent'
            WHEN avg_clv IS NULL THEN 'missing_closing_clv'
            WHEN avg_clv > 0 AND profit_units > 0 AND COALESCE(roi_ci_95_low, -999) >= 0 AND raw_brier_preview IS NOT NULL AND raw_brier_preview <= 0.21 THEN 'positive_clv_profit_brier_roi_ci'
            WHEN avg_clv > 0 AND profit_units > 0 THEN 'positive_clv_profit_but_calibration_gate_pending'
            WHEN avg_clv > 0 AND profit_units <= 0 THEN 'positive_clv_negative_profit'
            WHEN avg_clv < 0 AND profit_units <= 0 THEN 'negative_clv_negative_profit'
            WHEN avg_clv < 0 AND profit_units > 0 THEN 'negative_clv_positive_profit'
            WHEN profit_units <= 0 THEN 'neutral_clv_negative_profit'
            ELSE 'neutral_clv_positive_profit'
          END AS decision_reason,
          FALSE AS real_money_allowed,
          FALSE AS confirmed_paper_allowed
        FROM grouped
        ORDER BY
          CASE segment_type
            WHEN 'overall' THEN 0
            WHEN 'audit' THEN 1
            WHEN 'price' THEN 2
            WHEN 'market' THEN 3
            WHEN 'pick_type' THEN 4
            WHEN 'league' THEN 5
            ELSE 9
          END,
          closed DESC,
          profit_units DESC,
          segment_value
        LIMIT $7
      `,
      values
    );

    return {
      system_status: "FOOTBALL_SHADOW_PERFORMANCE_SEGMENTS",
      date_from: fromWindow.selectedDate,
      date_to: toWindow.selectedDate,
      min_closed: query.min_closed,
      metric_gates: {
        min_brier_closed_sample: MIN_BRIER_CLOSED_SAMPLE,
        min_log_loss_closed_sample: MIN_LOG_LOSS_CLOSED_SAMPLE,
        min_segment_promotion_sample: query.min_closed,
        min_trainer_sample: MIN_TRAINER_SAMPLE
      },
      count: result.rows.length,
      rows: result.rows,
      recommendation: "Decision segmentaria v2: Brier/log loss se ocultan como metrica principal hasta muestra minima. Prioridad actual: closing valido CAPTURED_ON_TIME + settlement limpio antes de entrenar Dixon-Coles.",
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        shadow_paper_only_for_football: true,
        kill_switch_enabled: true
      }
    };
  }

  async function runFootballOwnedFairOdds(rawQuery: unknown = {}, rawBody: unknown = {}) {
    const input = {
      ...(rawQuery && typeof rawQuery === "object" ? rawQuery as Record<string, unknown> : {}),
      ...(rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {})
    };
    const query = z.object({
      date: z.string().optional(),
      match_id: z.string().uuid().optional(),
      fallback_recent: booleanQuery(true),
      apply: booleanQuery(false),
      model_version: z.enum(["v2", "v3"]).default(ACTIVE_FOOTBALL_FAIR_ODDS_VERSION),
      model_name: z.string().min(1).max(80).optional(),
      min_ev: z.coerce.number().min(0).max(1).default(0.03),
      include_totals_2_5: booleanQuery(false),
      include_post_kickoff: booleanQuery(false),
      limit: z.coerce.number().int().min(1).max(200).default(80)
    }).parse(input);

    const useV3 = query.model_version === "v3";
    const modelName = query.model_name || (useV3
      ? "sports_data_hub_football_fair_odds_v3"
      : "sports_data_hub_football_fair_odds_v2");
    const modelConfig = useV3 ? FOOTBALL_FAIR_ODDS_V3_CONFIG : FOOTBALL_FAIR_ODDS_MODEL_CONFIG;

    const generatedAt = new Date();
    const generatedAtIso = generatedAt.toISOString();
    const bestBets = await buildBestBetsPerMatch({
      date: query.date,
      fallback_recent: query.fallback_recent,
      sport: "soccer"
    }) as Record<string, any>;
    const rows = Array.isArray(bestBets.rows) ? bestBets.rows as Array<Record<string, any>> : [];

    const numberOrNull = (value: unknown): number | null => {
      if (value === null || value === undefined || value === "") return null;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    };
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const fairOdds = (probability: number) => Number((1 / clamp(probability, 0.01, 0.99)).toFixed(4));
    const minMarketOdds = (probability: number) => Number(((1 + query.min_ev) / clamp(probability, 0.01, 0.99)).toFixed(4));
    const isPostKickoff = (kickoff: unknown) => {
      const date = new Date(String(kickoff || ""));
      return !Number.isNaN(date.getTime()) && date.getTime() <= generatedAt.getTime();
    };
    const leagueText = (row: Record<string, any>) => String(row.league_id || "").toLowerCase();
    const isFriendly = (row: Record<string, any>) => leagueText(row).includes("amistoso") || leagueText(row).includes("friendly");
    const isObservationLeague = (row: Record<string, any>) => leagueText(row).startsWith("football-observed-");
    const isUefaShadowAllowed = (row: Record<string, any>) => {
      const league = leagueText(row);
      return isObservationLeague(row)
        && league.includes("uefa")
        && (league.includes("champions-league-qualification")
          || league.includes("europa-league-qualification")
          || league.includes("europa-conference-league"));
    };
    const isPlayableStatus = (row: Record<string, any>) => {
      const status = String(row.match_status || row.paper_status || "").toLowerCase();
      if (!status) return true;
      return ["scheduled", "pending", "pre", "not_started"].includes(status);
    };
    const normalizedTeamName = (value: unknown) => String(value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/football club|club de futbol|club|fc|sc|cf/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const teamsFor = (row: Record<string, any>) => {
      const label = String(row.match || "").trim();
      const versus = label.split(/\s+vs\s+/i);
      if (versus.length === 2) {
        return { homeTeam: versus[0].trim(), awayTeam: versus[1].trim() };
      }
      const at = label.split(/\s+@\s+/i);
      if (at.length === 2) {
        return { homeTeam: at[1].trim(), awayTeam: at[0].trim() };
      }
      return { homeTeam: "", awayTeam: "" };
    };
    const verifiedFormFor = async (teamName: string, kickoff: unknown): Promise<FootballFormObservation[]> => {
      if (!teamName) return [];
      const result = await db.query(
        `
          SELECT
            tms.match_id,
            mh.match_date,
            tms.points_for,
            tms.points_against,
            tms.is_home,
            tms.source,
            tms.source_confidence_score,
            tms.updated_at AS captured_at,
            mh.match_date AS feature_as_of,
            COALESCE(
              tms.raw_data->>'screenshot_sha256',
              tms.raw_data->>'provider_raw_sha256',
              mh.raw_data->>'screenshot_sha256',
              mh.raw_data->>'provider_raw_sha256'
            ) AS evidence_sha256,
            CASE WHEN COALESCE(tms.raw_data->>'xg_for', tms.raw_data->>'xgFor', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN COALESCE(tms.raw_data->>'xg_for', tms.raw_data->>'xgFor')::numeric END AS xg_for,
            CASE WHEN COALESCE(tms.raw_data->>'xg_against', tms.raw_data->>'xgAgainst', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN COALESCE(tms.raw_data->>'xg_against', tms.raw_data->>'xgAgainst')::numeric END AS xg_against,
            CASE WHEN COALESCE(tms.raw_data->>'opponent_elo', tms.raw_data->>'opponentElo', '') ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN COALESCE(tms.raw_data->>'opponent_elo', tms.raw_data->>'opponentElo')::numeric END AS opponent_elo
          FROM sports_team_match_stats tms
          JOIN sports_match_history mh ON mh.match_id = tms.match_id
          WHERE tms.sport IN ('football', 'soccer')
            AND tms.normalized_team_name = $1
            AND mh.match_date < $2::timestamptz
            AND UPPER(mh.status) IN ('FINAL', 'FINISHED', 'FT')
            AND tms.points_for IS NOT NULL
            AND tms.points_against IS NOT NULL
            AND tms.source_confidence_score >= $3
          ORDER BY mh.match_date DESC
          LIMIT $4
        `,
        [
          normalizedTeamName(teamName),
          new Date(String(kickoff || generatedAtIso)).toISOString(),
          modelConfig.min_source_confidence,
          modelConfig.max_form_matches
        ]
      );
      return result.rows.map((formRow: Record<string, any>) => ({
        matchId: String(formRow.match_id),
        playedAt: new Date(formRow.match_date).toISOString(),
        goalsFor: Number(formRow.points_for),
        goalsAgainst: Number(formRow.points_against),
        isHome: formRow.is_home === null ? null : Boolean(formRow.is_home),
        source: String(formRow.source),
        sourceConfidenceScore: Number(formRow.source_confidence_score),
        evidenceSha256: formRow.evidence_sha256 ? String(formRow.evidence_sha256) : null,
        capturedAt: new Date(formRow.captured_at).toISOString(),
        featureAsOf: new Date(formRow.feature_as_of).toISOString(),
        xgFor: numberOrNull(formRow.xg_for),
        xgAgainst: numberOrNull(formRow.xg_against),
        opponentElo: numberOrNull(formRow.opponent_elo)
      }));
    };
    const verifiedContextFor = async (matchId: string, kickoff: unknown): Promise<FootballFairOddsContext> => {
      const result = await db.query(
        `
          SELECT features.feature_set, features.generated_at, match.raw_data
          FROM v_valid_matches match
          LEFT JOIN LATERAL (
            SELECT feature_set, generated_at
            FROM model_features
            WHERE match_id = match.id
              AND generated_at < $2::timestamptz
            ORDER BY generated_at DESC
            LIMIT 1
          ) features ON TRUE
          WHERE match.id = $1::uuid
        `,
        [matchId, new Date(String(kickoff || generatedAtIso)).toISOString()]
      );
      const featureSet = result.rows[0]?.feature_set && typeof result.rows[0].feature_set === "object"
        ? result.rows[0].feature_set as Record<string, any>
        : {};
      const matchRaw = result.rows[0]?.raw_data && typeof result.rows[0].raw_data === "object"
        ? result.rows[0].raw_data as Record<string, any>
        : {};
      const captures = matchRaw.manual_verified_source_captures && typeof matchRaw.manual_verified_source_captures === "object"
        ? Object.values(matchRaw.manual_verified_source_captures as Record<string, any>) as Array<Record<string, any>>
        : [];
      const latestCapture = (types: string[]) => captures
        .filter((capture) => types.includes(String(capture.capture_type || "")))
        .filter((capture) => new Date(String(capture.captured_at || "")).getTime() < new Date(String(kickoff || generatedAtIso)).getTime())
        .sort((left, right) => new Date(String(right.captured_at)).getTime() - new Date(String(left.captured_at)).getTime())[0];
      const evidenceFor = (capture?: Record<string, any>) => {
        if (!capture) return undefined;
        const sha = String(capture.data?.upstream_evidence_sha256 || capture.data?.provider_raw_sha256 || "");
        if (!/^[a-f0-9]{64}$/i.test(sha)) return undefined;
        return {
          source: String(capture.source_name || "manual_verified"),
          capturedAt: String(capture.captured_at),
          asOf: String(capture.captured_at),
          confidenceScore: Number(capture.confidence_score || 0),
          evidenceSha256: sha
        };
      };
      const lineupCapture = latestCapture(["lineup"]);
      const goalkeeperCapture = latestCapture(["goalkeeper"]);
      const availabilityCapture = latestCapture(["injuries", "suspensions"]);
      const matchStatusCapture = latestCapture(["match_status"]);
      const statsCapture = latestCapture(["stats", "xg"]);
      const provenance = {
        ...(featureSet.feature_provenance && typeof featureSet.feature_provenance === "object" ? featureSet.feature_provenance : {}),
        ...(evidenceFor(statsCapture) ? { elo: evidenceFor(statsCapture) } : {}),
        ...(evidenceFor(matchStatusCapture) ? {
          rest: evidenceFor(matchStatusCapture),
          competition: evidenceFor(matchStatusCapture),
          knockout: evidenceFor(matchStatusCapture)
        } : {}),
        ...(evidenceFor(availabilityCapture) ? {
          absences: evidenceFor(availabilityCapture),
          availability: evidenceFor(availabilityCapture)
        } : {}),
        ...(evidenceFor(goalkeeperCapture) ? { goalkeepers: evidenceFor(goalkeeperCapture) } : {}),
        ...(evidenceFor(lineupCapture) ? { lineups: evidenceFor(lineupCapture) } : {})
      };
      const raw = { ...featureSet, ...matchRaw };
      const stats = raw.manual_verified_stats && typeof raw.manual_verified_stats === "object"
        ? raw.manual_verified_stats as Record<string, any>
        : {};
      return {
        featureProvenance: provenance,
        homeElo: numberOrNull(raw.home_elo ?? stats.home_elo),
        awayElo: numberOrNull(raw.away_elo ?? stats.away_elo),
        homeRestDays: numberOrNull(raw.home_rest_days),
        awayRestDays: numberOrNull(raw.away_rest_days),
        homeAbsenceImpact: numberOrNull(raw.home_absence_impact),
        awayAbsenceImpact: numberOrNull(raw.away_absence_impact),
        homeGoalkeeperStatus: raw.home_goalkeeper_status || (raw.goalkeeper_ready ? "confirmed_starting" : "unknown"),
        awayGoalkeeperStatus: raw.away_goalkeeper_status || (raw.goalkeeper_ready ? "confirmed_starting" : "unknown"),
        homeGoalkeeperImpact: numberOrNull(raw.home_goalkeeper_impact),
        awayGoalkeeperImpact: numberOrNull(raw.away_goalkeeper_impact),
        homeLineupCompleteness: numberOrNull(raw.home_lineup_completeness) ?? (raw.lineup_ready ? 1 : null),
        awayLineupCompleteness: numberOrNull(raw.away_lineup_completeness) ?? (raw.lineup_ready ? 1 : null),
        availabilityVerified: raw.availability_verified === true || raw.player_availability_manual_verified === true,
        competitionStrength: numberOrNull(raw.competition_strength),
        knockout: raw.knockout && typeof raw.knockout === "object" ? raw.knockout : null
      };
    };
    const differentiatedModelFor = async (row: Record<string, any>) => {
      const teams = teamsFor(row);
      const [homeForm, awayForm, context] = await Promise.all([
        verifiedFormFor(teams.homeTeam, row.kickoff),
        verifiedFormFor(teams.awayTeam, row.kickoff),
        verifiedContextFor(String(row.match_id), row.kickoff)
      ]);
      const modelInput = {
        homeTeam: teams.homeTeam,
        awayTeam: teams.awayTeam,
        asOf: generatedAtIso,
        homeForm,
        awayForm
      };
      return useV3
        ? computeFootballFairOddsV3({ ...modelInput, context })
        : computeFootballFairOdds(modelInput);
    };
    const totalsProbabilitiesFor = (row: Record<string, any>) => {
      const contextScore = numberOrNull(row.context_score) ?? 0;
      const league = leagueText(row);
      const friendly = isFriendly(row);
      const observed = isObservationLeague(row);
      const overLean = clamp((contextScore - 50) / 1200, -0.02, 0.02);
      const baseOver = friendly ? 0.50 : observed ? 0.485 : 0.505;
      const over = clamp(baseOver + overLean, 0.42, 0.58);
      const under = 1 - over;
      return {
        over: Number(over.toFixed(6)),
        under: Number(under.toFixed(6)),
        basis: {
          context_score: contextScore,
          league,
          observed_league: observed,
          friendly,
          method: "goals_total_context_prior_v1",
          analysis_only: true,
          needs_goal_stats_upgrade: true
        }
      };
    };

    const soccerRows = rows
      .filter((row) => row.sport === "soccer" && row.match_id)
      .filter((row) => !query.match_id || String(row.match_id) === query.match_id)
      .filter((row) => isPlayableStatus(row))
      .filter((row) => query.include_post_kickoff || !isPostKickoff(row.kickoff));
    const trustByMatchId = await loadCalendarTrustDecisions(
      db,
      soccerRows.map((row) => String(row.match_id))
    );
    const calendarBlockedRows = soccerRows.filter((row) => !trustByMatchId.get(String(row.match_id))?.trusted);
    const candidates = soccerRows
      .filter((row) => trustByMatchId.get(String(row.match_id))?.trusted)
      .slice(0, query.limit);

    let inserted = 0;
    let updated = 0;
    let modelVersionsRegistered = 0;
    const outputRows: Array<Record<string, any>> = [];
    const skippedRows: Array<Record<string, any>> = calendarBlockedRows.map((row) => ({
      match_id: row.match_id,
      match: row.match,
      kickoff: row.kickoff,
      status: "CALENDAR_TRUST_REQUIRED",
      reason: "VERIFY_CALENDAR",
      blockers: trustByMatchId.get(String(row.match_id))?.reasons ?? ["CALENDAR_TRUST_MISSING"]
    }));

    for (const row of candidates) {
      let differentiatedModel: ReturnType<typeof computeFootballFairOdds> | ReturnType<typeof computeFootballFairOddsV3>;
      try {
        differentiatedModel = await differentiatedModelFor(row);
      } catch (error) {
        skippedRows.push({
          match_id: row.match_id,
          match: row.match,
          kickoff: row.kickoff,
          status: "OWNED_FAIR_ODDS_INPUTS_MISSING",
          reason: error instanceof Error ? error.message : "football_fair_odds_generation_failed",
          required: {
            min_verified_matches_per_team: modelConfig.min_form_matches,
            min_source_confidence: modelConfig.min_source_confidence,
            pre_kickoff_only: true,
            market_inputs_allowed: false
          }
        });
        continue;
      }
      const probabilities = {
        ...differentiatedModel.probabilities,
        basis: differentiatedModel.basis
      };
      const confidence = differentiatedModel.confidence;
      const artifactSha256 = useV3 ? footballFairOddsV3ArtifactSha256() : footballFairOddsArtifactSha256();
      const modelVersionLabel = `${modelConfig.model_family}-cutoff-${differentiatedModel.training_cutoff_date}`;
      if (query.apply) {
        await db.query("SELECT * FROM register_forecast_match($1::uuid)", [row.match_id]);
      }
      const modelVersion = query.apply
        ? await registerForecastModelVersion({
            versionLabel: modelVersionLabel,
            sportSlug: "soccer",
            modelName,
            trainingCutoffDate: differentiatedModel.training_cutoff_date,
            trainedAt: generatedAtIso,
            artifactSha256,
            configSha256: artifactSha256,
            featureSchemaVersion: modelConfig.feature_schema_version,
            notes: useV3
              ? "Contextual xG/Elo model with verified feature provenance. Market odds are excluded from model inputs."
              : "Recency-weighted verified goals model. Market odds are excluded from model inputs."
          })
        : null;
      if (modelVersion) modelVersionsRegistered += 1;
      const promotionAllowed = !isFriendly(row) && (!isObservationLeague(row) || isUefaShadowAllowed(row));
      const commonRawData = {
        owned_fair_odds: true,
        fair_odds_only: true,
        not_market_odds: true,
        source: "sports_data_hub_owned_api",
        model_name: modelName,
        model_family: modelConfig.model_family,
        model_version_label: modelVersionLabel,
        model_version_id: modelVersion?.id ?? null,
        training_cutoff_date: differentiatedModel.training_cutoff_date,
        trained_at: generatedAtIso,
        artifact_sha256: artifactSha256,
        feature_schema_version: modelConfig.feature_schema_version,
        fair_odds_method_version: modelConfig.fair_odds_method_version,
        market_inputs_used: false,
        independence_attestation: "Market quote is comparison-only and was not used to generate probabilities.",
        target_model_family: "dixon_coles_market_blend_v1",
        calibration_route: "Dixon-Coles + market no-vig blend after closed sample gate",
        blend_weight_model: 0.2,
        blend_weight_market: 0.8,
        champion_model_ready: false,
        calibration_state: "CALIBRATING",
        previous_calibration_state: "UNCALIBRATED_PRIOR",
        calibration_gate: {
          min_closed_matches: 50,
          max_brier_score: 0.21,
          reliability_max_bucket_deviation_pp: 3,
          require_log_loss_improvement_vs_market: true,
          require_two_consecutive_windows: true
        },
        calibration_required_before_real_money: true,
        immutable_candidate_input: useV3,
        generated_at: generatedAtIso,
        promotion_allowed: promotionAllowed,
        shadow_allowlist_reason: isUefaShadowAllowed(row) ? "UEFA_QUALIFIER_SHADOW_ONLY" : null,
        shadow_only_allowlist: isUefaShadowAllowed(row),
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        basis: probabilities.basis,
        expected_goals: differentiatedModel.expected_goals
      };
      const moneyline: Record<string, any> = {
        match_id: row.match_id,
        match: row.match,
        league_id: row.league_id,
        kickoff: row.kickoff,
        model_name: modelName,
        market_type: "moneyline_3way",
        line: null,
        home_probability: probabilities.home,
        draw_probability: probabilities.draw,
        away_probability: probabilities.away,
        home_fair_odds: fairOdds(probabilities.home),
        draw_fair_odds: fairOdds(probabilities.draw),
        away_fair_odds: fairOdds(probabilities.away),
        home_min_market_odds_for_ev: minMarketOdds(probabilities.home),
        draw_min_market_odds_for_ev: minMarketOdds(probabilities.draw),
        away_min_market_odds_for_ev: minMarketOdds(probabilities.away),
        confidence,
        model_family: modelConfig.model_family,
        model_version_label: modelVersionLabel,
        model_version_id: modelVersion?.id ?? null,
        training_cutoff_date: differentiatedModel.training_cutoff_date,
        expected_goals_home: differentiatedModel.expected_goals.home,
        expected_goals_away: differentiatedModel.expected_goals.away,
        market_inputs_used: false,
        audit_basis: differentiatedModel.basis,
        status: promotionAllowed ? "OWNED_FAIR_ODDS_READY" : "OWNED_FAIR_ODDS_OBSERVATION_ONLY",
        recommendation: promotionAllowed
          ? "Usar como precio justo interno; requiere cuota real para calcular EV."
          : "Solo observacion/modelado; no promover por liga observada o amistoso."
      };
      const dnbHomeProb = probabilities.home / (probabilities.home + probabilities.away);
      const dnbAwayProb = probabilities.away / (probabilities.home + probabilities.away);
      const dnb: Record<string, any> = {
        ...moneyline,
        market_type: "draw_no_bet",
        line: null,
        home_probability: Number(dnbHomeProb.toFixed(6)),
        draw_probability: null,
        away_probability: Number(dnbAwayProb.toFixed(6)),
        home_fair_odds: fairOdds(dnbHomeProb),
        draw_fair_odds: null,
        away_fair_odds: fairOdds(dnbAwayProb),
        home_min_market_odds_for_ev: minMarketOdds(dnbHomeProb),
        draw_min_market_odds_for_ev: null,
        away_min_market_odds_for_ev: minMarketOdds(dnbAwayProb)
      };
      const quotes: Array<Record<string, any>> = [moneyline, dnb];
      if (query.include_totals_2_5) {
        const totals = totalsProbabilitiesFor(row);
        quotes.push({
          ...moneyline,
          market_type: "over_under_2_5",
          line: 2.5,
          home_probability: totals.over,
          draw_probability: null,
          away_probability: totals.under,
          home_fair_odds: fairOdds(totals.over),
          draw_fair_odds: null,
          away_fair_odds: fairOdds(totals.under),
          home_min_market_odds_for_ev: minMarketOdds(totals.over),
          draw_min_market_odds_for_ev: null,
          away_min_market_odds_for_ev: minMarketOdds(totals.under),
          confidence: Number(Math.max(0.25, confidence - 0.12).toFixed(4)),
          status: "OWNED_FAIR_ODDS_TOTALS_ANALYSIS_ONLY",
          recommendation: "O/U 2.5 preparado como analysis-only; requiere stats de goles/xG mas fuertes y cuota real."
        });
      }

      for (const quote of quotes) {
        outputRows.push(quote);
        if (query.apply) {
          const quoteRawData = {
            ...commonRawData,
            market_type: quote.market_type,
            min_ev_threshold: query.min_ev,
            selection_map: quote.market_type === "over_under_2_5"
              ? { home: "over", away: "under" }
              : { home: "home", away: "away", draw: "draw" },
            disabled_selections: quote.market_type === "over_under_2_5" || quote.market_type === "draw_no_bet" ? ["draw"] : [],
            analysis_only: quote.market_type === "over_under_2_5",
            promotion_allowed: quote.market_type === "over_under_2_5" ? false : promotionAllowed,
            basis: quote.market_type === "over_under_2_5"
              ? totalsProbabilitiesFor(row).basis
              : probabilities.basis,
            min_market_odds_for_ev: {
              home: quote.home_min_market_odds_for_ev,
              draw: quote.draw_min_market_odds_for_ev,
              away: quote.away_min_market_odds_for_ev
            }
          };
          const quoteParams = [
            quote.match_id,
            quote.model_name,
            quote.market_type,
            quote.line,
            quote.home_probability,
            quote.away_probability,
            quote.draw_probability,
            quote.home_fair_odds,
            quote.away_fair_odds,
            quote.draw_fair_odds,
            quote.confidence,
            generatedAtIso,
            JSON.stringify(quoteRawData)
          ];
          const insertResult = await db.query(
            useV3 ? `
              INSERT INTO model_quotes (
                match_id, model_name, market_type, line,
                home_probability, away_probability, draw_probability,
                home_fair_odds, away_fair_odds, draw_fair_odds,
                confidence, generated_at, raw_data
              ) VALUES (
                $1::uuid, $2::varchar, $3::varchar, $4::numeric,
                $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::jsonb
              )
              RETURNING id
            ` : `
              INSERT INTO model_quotes (
                match_id, model_name, market_type, line,
                home_probability, away_probability, draw_probability,
                home_fair_odds, away_fair_odds, draw_fair_odds,
                confidence, generated_at, raw_data
              )
              SELECT
                $1::uuid, $2::varchar, $3::varchar, $4::numeric,
                $5, $6, $7,
                $8, $9, $10,
                $11, $12::timestamptz, $13::jsonb
              WHERE NOT EXISTS (
                SELECT 1
                FROM model_quotes existing
                WHERE existing.match_id = $1::uuid
                  AND existing.model_name = $2::varchar
                  AND existing.market_type = $3::varchar
                  AND COALESCE(existing.line, -9999) = COALESCE($4::numeric, -9999)
                  AND existing.raw_data->>'owned_fair_odds' = 'true'
                  AND existing.generated_at::date = ($12::timestamptz)::date
              )
              RETURNING id
            `,
            quoteParams
          );
          const insertedRows = insertResult.rowCount ?? insertResult.rows.length;
          inserted += insertedRows;
          if (!useV3 && insertedRows === 0) {
            const updateResult = await db.query(
              `
                UPDATE model_quotes existing
                SET
                  home_probability = $5,
                  away_probability = $6,
                  draw_probability = $7,
                  home_fair_odds = $8,
                  away_fair_odds = $9,
                  draw_fair_odds = $10,
                  confidence = $11,
                  generated_at = $12::timestamptz,
                  raw_data = $13::jsonb
                WHERE existing.match_id = $1::uuid
                  AND existing.model_name = $2::varchar
                  AND existing.market_type = $3::varchar
                  AND COALESCE(existing.line, -9999) = COALESCE($4::numeric, -9999)
                  AND existing.raw_data->>'owned_fair_odds' = 'true'
                  AND existing.generated_at::date = ($12::timestamptz)::date
              `,
              quoteParams
            );
            updated += updateResult.rowCount ?? 0;
          }
        }
      }
    }

    return {
      system_status: "FOOTBALL_OWNED_FAIR_ODDS",
      date: bestBets.date || query.date || null,
      requested_date: bestBets.requested_date || query.date || null,
      generated_at: generatedAtIso,
      dry_run: !query.apply,
      apply_requested: query.apply,
      model_name: modelName,
      scanned_matches: rows.length,
      priced_matches: new Set(outputRows.map((row) => String(row.match_id))).size,
      calendar_trust_blocked: calendarBlockedRows.length,
      quotes_generated: outputRows.length,
      inserted,
      updated,
      model_versions_registered: modelVersionsRegistered,
      skipped_matches: skippedRows.length,
      markets: query.include_totals_2_5 ? ["moneyline_3way", "draw_no_bet", "over_under_2_5"] : ["moneyline_3way", "draw_no_bet"],
      note: "Estas son odds justas propias/model odds. No son cuotas reales de mercado y no calculan EV financiero por si solas.",
      rows: outputRows,
      skipped_rows: skippedRows,
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        shadow_paper_only_for_football: true,
        kill_switch_enabled: true
      }
    };
  }
  app.get("/api/v1/internal/analytics/stale-archive-report", async (request) => buildStaleArchiveReport(request.query));
  app.get("/api/v1/trading/stale-archive-report", async (request) => buildStaleArchiveReport(request.query));
  app.get("/api/trading/stale-archive-report", async (request) => buildStaleArchiveReport(request.query));
  app.get("/api/v1/internal/analytics/fresh-vs-archive", async (request) => buildFreshArchiveState(request.query));
  app.get("/api/v1/trading/fresh-vs-archive", async (request) => buildFreshArchiveState(request.query));
  app.get("/api/trading/fresh-vs-archive", async (request) => buildFreshArchiveState(request.query));
  app.get("/api/v1/internal/analytics/data-quality-scores", async (request) => buildDataQualityScores(request.query));
  app.get("/api/v1/trading/data-quality-scores", async (request) => buildDataQualityScores(request.query));
  app.get("/api/trading/data-quality-scores", async (request) => buildDataQualityScores(request.query));
  app.get("/api/v1/internal/analytics/ev-outlier-guardrail", async (request) => buildEvOutlierGuardrail(request.query));
  app.get("/api/v1/trading/ev-outlier-guardrail", async (request) => buildEvOutlierGuardrail(request.query));
  app.get("/api/trading/ev-outlier-guardrail", async (request) => buildEvOutlierGuardrail(request.query));
  app.get("/api/v1/internal/analytics/confirmed-vs-ev-backtest", async (request) => buildConfirmedVsEvBacktest(request.query));
  app.get("/api/v1/trading/confirmed-vs-ev-backtest", async (request) => buildConfirmedVsEvBacktest(request.query));
  app.get("/api/trading/confirmed-vs-ev-backtest", async (request) => buildConfirmedVsEvBacktest(request.query));
  app.get("/api/v1/internal/analytics/underdog-lab", async () => buildUnderdogLab());
  app.get("/api/v1/trading/underdog-lab", async () => buildUnderdogLab());
  app.get("/api/trading/underdog-lab", async () => buildUnderdogLab());
  app.get("/api/v1/internal/analytics/pick-decisions", async () => buildPickDecisionRows());
  app.get("/api/v1/trading/pick-decisions", async () => buildPickDecisionRows());
  app.get("/api/trading/pick-decisions", async () => buildPickDecisionRows());
  app.get("/api/v1/internal/analytics/underdog-plus-v2", async () => buildUnderdogPlusV2());
  app.get("/api/v1/trading/underdog-plus-v2", async () => buildUnderdogPlusV2());
  app.get("/api/trading/underdog-plus-v2", async () => buildUnderdogPlusV2());
  app.get("/api/v1/internal/analytics/pending-settlement-monitor", async () => buildPendingSettlementMonitor());
  app.get("/api/v1/trading/pending-settlement-monitor", async () => buildPendingSettlementMonitor());
  app.get("/api/trading/pending-settlement-monitor", async () => buildPendingSettlementMonitor());
  app.get("/api/v1/internal/analytics/command-center", async () => buildCommandCenter());
  app.get("/api/v1/trading/command-center", async () => buildCommandCenter());
  app.get("/api/trading/command-center", async () => buildCommandCenter());
  app.get("/api/v1/internal/analytics/safety-suite/status", async () => buildSafetySuiteStatus());
  app.get("/api/v1/trading/safety-suite/status", async () => buildSafetySuiteStatus());
  app.get("/api/trading/safety-suite/status", async () => buildSafetySuiteStatus());
  app.get("/api/v1/internal/analytics/pilot-readiness-gate", async () => buildPilotReadinessGate());
  app.get("/api/v1/trading/pilot-readiness-gate", async () => buildPilotReadinessGate());
  app.get("/api/trading/pilot-readiness-gate", async () => buildPilotReadinessGate());
  app.get("/api/v1/internal/analytics/formal-pilot-readiness", async (request) => buildFormalPilotReadiness(request.query));
  app.get("/api/v1/trading/formal-pilot-readiness", async (request) => buildFormalPilotReadiness(request.query));
  app.get("/api/trading/formal-pilot-readiness", async (request) => buildFormalPilotReadiness(request.query));
  app.get("/api/v1/internal/analytics/fresh-candidate-inbox", async () => buildFreshCandidateInbox());
  app.get("/api/v1/trading/fresh-candidate-inbox", async () => buildFreshCandidateInbox());
  app.get("/api/trading/fresh-candidate-inbox", async () => buildFreshCandidateInbox());
  app.get("/api/v1/internal/analytics/rule-confidence", async () => buildRuleConfidence());
  app.get("/api/v1/trading/rule-confidence", async () => buildRuleConfidence());
  app.get("/api/trading/rule-confidence", async () => buildRuleConfidence());
  app.get("/api/v1/internal/analytics/walk-forward-backtest", async () => buildWalkForwardBacktest());
  app.get("/api/v1/trading/walk-forward-backtest", async () => buildWalkForwardBacktest());
  app.get("/api/trading/walk-forward-backtest", async () => buildWalkForwardBacktest());
  app.get("/api/v1/internal/analytics/real-pilot-simulator", async () => buildRealPilotSimulator());
  app.get("/api/v1/trading/real-pilot-simulator", async () => buildRealPilotSimulator());
  app.get("/api/trading/real-pilot-simulator", async () => buildRealPilotSimulator());
  app.get("/api/v1/internal/analytics/live-board", async (request) => buildSportsIntelligenceLiveBoard(request.query));
  app.get("/api/v1/trading/live-board", async (request) => buildSportsIntelligenceLiveBoard(request.query));
  app.get("/api/trading/live-board", async (request) => buildSportsIntelligenceLiveBoard(request.query));
  app.get("/api/v1/internal/analytics/match-center", async (request) => buildMatchCenter(request.query));
  app.get("/api/v1/trading/match-center", async (request) => buildMatchCenter(request.query));
  app.get("/api/trading/match-center", async (request) => buildMatchCenter(request.query));
  app.get("/api/v1/internal/analytics/best-bets-per-match", async (request) => buildBestBetsPerMatch(request.query));
  app.get("/api/v1/trading/best-bets-per-match", async (request) => buildBestBetsPerMatch(request.query));
  app.get("/api/trading/best-bets-per-match", async (request) => buildBestBetsPerMatch(request.query));
  app.get("/api/v1/internal/analytics/near-start-context/status", async (request) => runNearStartContext(request.query));
  app.get("/api/v1/trading/near-start-context/status", async (request) => runNearStartContext(request.query));
  app.get("/api/trading/near-start-context/status", async (request) => runNearStartContext(request.query));
  app.post("/api/v1/internal/analytics/near-start-context/run", async (request) => runNearStartContext(request.query, request.body));
  app.post("/api/v1/trading/near-start-context/run", async (request) => runNearStartContext(request.query, request.body));
  app.post("/api/trading/near-start-context/run", async (request) => runNearStartContext(request.query, request.body));
  app.get("/api/v1/internal/analytics/football/near-start-context/status", async (request) => runFootballNearStartContext(request.query));
  app.get("/api/v1/trading/football/near-start-context/status", async (request) => runFootballNearStartContext(request.query));
  app.get("/api/trading/football/near-start-context/status", async (request) => runFootballNearStartContext(request.query));
  app.post("/api/v1/internal/analytics/football/near-start-context/run", async (request) => runFootballNearStartContext(request.query, request.body));
  app.post("/api/v1/trading/football/near-start-context/run", async (request) => runFootballNearStartContext(request.query, request.body));
  app.post("/api/trading/football/near-start-context/run", async (request) => runFootballNearStartContext(request.query, request.body));
  app.get("/api/v1/internal/analytics/football-owned-fair-odds/status", async (request) => runFootballOwnedFairOdds(request.query));
  app.get("/api/v1/trading/football-owned-fair-odds/status", async (request) => runFootballOwnedFairOdds(request.query));
  app.get("/api/trading/football-owned-fair-odds/status", async (request) => runFootballOwnedFairOdds(request.query));
  app.post("/api/v1/internal/analytics/football-owned-fair-odds/run", async (request) => runFootballOwnedFairOdds(request.query, request.body));
  app.post("/api/v1/trading/football-owned-fair-odds/run", async (request) => runFootballOwnedFairOdds(request.query, request.body));
  app.post("/api/trading/football-owned-fair-odds/run", async (request) => runFootballOwnedFairOdds(request.query, request.body));
  app.get("/api/v1/internal/analytics/nfl-owned-fair-odds/status", async (request) => runNflOwnedFairOdds(request.query));
  app.get("/api/v1/trading/nfl-owned-fair-odds/status", async (request) => runNflOwnedFairOdds(request.query));
  app.get("/api/trading/nfl-owned-fair-odds/status", async (request) => runNflOwnedFairOdds(request.query));
  app.post("/api/v1/internal/analytics/nfl-owned-fair-odds/run", async (request) => runNflOwnedFairOdds(request.query, request.body));
  app.post("/api/v1/trading/nfl-owned-fair-odds/run", async (request) => runNflOwnedFairOdds(request.query, request.body));
  app.post("/api/trading/nfl-owned-fair-odds/run", async (request) => runNflOwnedFairOdds(request.query, request.body));
  app.get("/api/v1/internal/analytics/nba-owned-fair-odds/status", async (request) => runNbaOwnedFairOdds(request.query));
  app.get("/api/v1/trading/nba-owned-fair-odds/status", async (request) => runNbaOwnedFairOdds(request.query));
  app.get("/api/trading/nba-owned-fair-odds/status", async (request) => runNbaOwnedFairOdds(request.query));
  app.post("/api/v1/internal/analytics/nba-owned-fair-odds/run", async (request) => runNbaOwnedFairOdds(request.query, request.body));
  app.post("/api/v1/trading/nba-owned-fair-odds/run", async (request) => runNbaOwnedFairOdds(request.query, request.body));
  app.post("/api/trading/nba-owned-fair-odds/run", async (request) => runNbaOwnedFairOdds(request.query, request.body));
  app.get("/api/v1/internal/analytics/nba-near-start-context/status", async (request) => runNbaNearStartContext(request.query));
  app.get("/api/v1/trading/nba-near-start-context/status", async (request) => runNbaNearStartContext(request.query));
  app.get("/api/trading/nba-near-start-context/status", async (request) => runNbaNearStartContext(request.query));
  app.post("/api/v1/internal/analytics/nba-near-start-context/run", async (request) => runNbaNearStartContext(request.query, request.body));
  app.post("/api/v1/trading/nba-near-start-context/run", async (request) => runNbaNearStartContext(request.query, request.body));
  app.post("/api/trading/nba-near-start-context/run", async (request) => runNbaNearStartContext(request.query, request.body));
  app.get("/api/v1/internal/analytics/football-market-lab", async () => getFootballMarketLab(db));
  app.get("/api/v1/trading/football-market-lab", async () => getFootballMarketLab(db));
  app.get("/api/trading/football-market-lab", async () => getFootballMarketLab(db));
  app.get("/api/v1/internal/analytics/football-shadow-feed-status", async () => getFootballShadowFeedStatus(db));
  app.get("/api/v1/trading/football-shadow-feed-status", async () => getFootballShadowFeedStatus(db));
  app.get("/api/trading/football-shadow-feed-status", async () => getFootballShadowFeedStatus(db));
  app.post("/api/v1/internal/analytics/football-shadow-feed", async (request) => processFootballShadowFeed(db, (request.body ?? {}) as { dry_run?: boolean; signals?: Parameters<typeof processFootballShadowFeed>[1]["signals"] }));
  app.get("/api/v1/internal/analytics/football-today-universe", async (request) => {
    const query = z.object({ date: z.string().optional() }).parse(request.query);
    return getFootballTodayUniverse(db, query.date);
  });
  app.get("/api/v1/trading/football-today-universe", async (request) => {
    const query = z.object({ date: z.string().optional() }).parse(request.query);
    return getFootballTodayUniverse(db, query.date);
  });
  app.get("/api/trading/football-today-universe", async (request) => {
    const query = z.object({ date: z.string().optional() }).parse(request.query);
    return getFootballTodayUniverse(db, query.date);
  });
  app.post("/api/v1/internal/analytics/football-today-universe", async (request) => processFootballTodayUniverse(db, request.body ?? {}));
  app.post("/api/v1/trading/football-today-universe", async (request) => processFootballTodayUniverse(db, request.body ?? {}));
  app.post("/api/trading/football-today-universe", async (request) => processFootballTodayUniverse(db, request.body ?? {}));
  app.post("/api/v1/internal/analytics/football-shadow-settlement", async (request) => settleFootballShadow(db, (request.body ?? {}) as Parameters<typeof settleFootballShadow>[1]));
  app.post("/api/v1/trading/football-shadow-settlement", async (request) => settleFootballShadow(db, (request.body ?? {}) as Parameters<typeof settleFootballShadow>[1]));
  app.post("/api/trading/football-shadow-settlement", async (request) => settleFootballShadow(db, (request.body ?? {}) as Parameters<typeof settleFootballShadow>[1]));
  app.post("/api/v1/internal/analytics/football/closing/run", async (request) => settleFootballShadow(db, {
    ...((request.body ?? {}) as Parameters<typeof settleFootballShadow>[1]),
    results: []
  }));
  app.post("/api/v1/trading/football/closing/run", async (request) => settleFootballShadow(db, {
    ...((request.body ?? {}) as Parameters<typeof settleFootballShadow>[1]),
    results: []
  }));
  app.post("/api/trading/football/closing/run", async (request) => settleFootballShadow(db, {
    ...((request.body ?? {}) as Parameters<typeof settleFootballShadow>[1]),
    results: []
  }));
  app.post("/api/v1/internal/analytics/football/settlement/run", async (request) => settleFootballShadow(db, (request.body ?? {}) as Parameters<typeof settleFootballShadow>[1]));
  app.post("/api/v1/trading/football/settlement/run", async (request) => settleFootballShadow(db, (request.body ?? {}) as Parameters<typeof settleFootballShadow>[1]));
  app.post("/api/trading/football/settlement/run", async (request) => settleFootballShadow(db, (request.body ?? {}) as Parameters<typeof settleFootballShadow>[1]));
  app.get("/api/v1/internal/analytics/football/performance/segments", async (request) => buildFootballPerformanceSegments(request.query));
  app.get("/api/v1/trading/football/performance/segments", async (request) => buildFootballPerformanceSegments(request.query));
  app.get("/api/trading/football/performance/segments", async (request) => buildFootballPerformanceSegments(request.query));
  app.get("/api/v1/internal/analytics/football-pending-settlement-monitor", async () => getFootballPendingSettlementMonitor(db));
  app.get("/api/v1/trading/football-pending-settlement-monitor", async () => getFootballPendingSettlementMonitor(db));
  app.get("/api/trading/football-pending-settlement-monitor", async () => getFootballPendingSettlementMonitor(db));
  app.get("/api/v1/internal/analytics/football-feed-quality-report", async () => getFootballFeedQualityReport(db));
  app.get("/api/v1/trading/football-feed-quality-report", async () => getFootballFeedQualityReport(db));
  app.get("/api/trading/football-feed-quality-report", async () => getFootballFeedQualityReport(db));
  app.get("/api/v1/internal/analytics/football-command-center", async () => getFootballCommandCenter(db));
  app.get("/api/v1/trading/football-command-center", async () => getFootballCommandCenter(db));
  app.get("/api/trading/football-command-center", async () => getFootballCommandCenter(db));
  app.get("/api/v1/internal/analytics/football-competition-registry", async () => getFootballCompetitionRegistry(db));
  app.get("/api/v1/trading/football-competition-registry", async () => getFootballCompetitionRegistry(db));
  app.get("/api/trading/football-competition-registry", async () => getFootballCompetitionRegistry(db));
  app.get("/api/v1/internal/analytics/football-league-trust-scores", async () => getFootballLeagueTrustScores(db));
  app.get("/api/v1/trading/football-league-trust-scores", async () => getFootballLeagueTrustScores(db));
  app.get("/api/trading/football-league-trust-scores", async () => getFootballLeagueTrustScores(db));
  app.get("/api/v1/internal/analytics/football-team-intelligence", async () => getFootballTeamIntelligence(db));
  app.get("/api/v1/trading/football-team-intelligence", async () => getFootballTeamIntelligence(db));
  app.get("/api/trading/football-team-intelligence", async () => getFootballTeamIntelligence(db));
  app.get("/api/v1/internal/analytics/football-player-intelligence", async () => getFootballPlayerIntelligence(db));
  app.get("/api/v1/trading/football-player-intelligence", async () => getFootballPlayerIntelligence(db));
  app.get("/api/trading/football-player-intelligence", async () => getFootballPlayerIntelligence(db));
  app.get("/api/v1/internal/analytics/football-confirmed-pick-chain", async () => getFootballConfirmedPickChain(db));
  app.get("/api/v1/trading/football-confirmed-pick-chain", async () => getFootballConfirmedPickChain(db));
  app.get("/api/trading/football-confirmed-pick-chain", async () => getFootballConfirmedPickChain(db));
  app.get("/api/v1/internal/analytics/football-readiness-gate", async () => getFootballReadinessGate(db));
  app.get("/api/v1/trading/football-readiness-gate", async () => getFootballReadinessGate(db));
  app.get("/api/trading/football-readiness-gate", async () => getFootballReadinessGate(db));
  app.get("/api/v1/internal/analytics/match-preflight/status", async (request) => getMatchPreflightStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/match-preflight/status", async (request) => getMatchPreflightStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/match-preflight/status", async (request) => getMatchPreflightStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/internal/analytics/chain-preflight/status", async (request) => getChainPreflightStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/chain-preflight/status", async (request) => getChainPreflightStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/internal/analytics/candidate-preflight/status", async (request) => getCandidatePreflightStatus(db, candidatePreflightQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/candidate-preflight/status", async (request) => getCandidatePreflightStatus(db, candidatePreflightQuerySchema.parse(request.query)));
  app.get("/api/v1/internal/analytics/bottleneck-by-source", async (request) => getBottleneckBySource(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/bottleneck-by-source", async (request) => getBottleneckBySource(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/bottleneck-by-source", async (request) => getBottleneckBySource(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/internal/analytics/closing-window-watch", async (request) => getClosingWindowWatch(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/closing-window-watch", async (request) => getClosingWindowWatch(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/closing-window-watch", async (request) => getClosingWindowWatch(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/internal/analytics/closing-capture-draft", async (request) => getClosingCaptureDraft(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/closing-capture-draft", async (request) => getClosingCaptureDraft(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/closing-capture-draft", async (request) => getClosingCaptureDraft(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/internal/analytics/source-capture-assistant", async (request) => getSourceCaptureAssistant(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/source-capture-assistant", async (request) => getSourceCaptureAssistant(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/source-capture-assistant", async (request) => getSourceCaptureAssistant(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/internal/analytics/source-capture-assistant/rules", async () => getSourceCaptureAssistantRules());
  app.get("/api/v1/trading/source-capture-assistant/rules", async () => getSourceCaptureAssistantRules());
  app.get("/api/trading/source-capture-assistant/rules", async () => getSourceCaptureAssistantRules());
  const postSourceCaptureAssistantEvidence = async (request: any, reply: any) => {
    try {
      return await recordSourceCaptureAssistantEvidence(db, (request.body ?? {}) as Record<string, unknown>);
    } catch (error) {
      reply.status(400);
      return {
        system_status: "SOURCE_CAPTURE_ASSISTANT_EVIDENCE_SAFE_V1",
        applied: false,
        rejected: true,
        evidence_status: "REJECTED_UNSAFE_SOURCE",
        reason: error instanceof Error ? error.message : "invalid_source_capture_assistant_payload",
        guardrails: {
          real_candidate_count: 0,
          real_money_enabled: false,
          kelly_enabled: false,
          telegram_auto_enabled: false,
          kill_switch_enabled: true,
          auto_post_allowed: false,
          auto_scrape_allowed: false
        }
      };
    }
  };
  app.post("/api/v1/internal/analytics/source-capture-assistant/evidence", postSourceCaptureAssistantEvidence);
  app.post("/api/v1/trading/source-capture-assistant/evidence", postSourceCaptureAssistantEvidence);
  app.post("/api/trading/source-capture-assistant/evidence", postSourceCaptureAssistantEvidence);
  app.get("/api/v1/internal/analytics/operational-window-queue", async (request) => getOperationalWindowQueue(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/operational-window-queue", async (request) => getOperationalWindowQueue(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/operational-window-queue", async (request) => getOperationalWindowQueue(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/internal/analytics/operational-alerts", async (request) => getOperationalAlerts(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/operational-alerts", async (request) => getOperationalAlerts(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/operational-alerts", async (request) => getOperationalAlerts(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/internal/analytics/clean-sample-queue", async (request) => getCleanSampleQueue(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/clean-sample-queue", async (request) => getCleanSampleQueue(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/clean-sample-queue", async (request) => getCleanSampleQueue(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/internal/analytics/odds-snapshot-cache", async (request) => getOddsSnapshotCache(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/odds-snapshot-cache", async (request) => getOddsSnapshotCache(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/odds-snapshot-cache", async (request) => getOddsSnapshotCache(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/internal/analytics/shadow-ticket-chain", async (request) => getShadowTicketChain(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/shadow-ticket-chain", async (request) => getShadowTicketChain(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/shadow-ticket-chain", async (request) => getShadowTicketChain(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/internal/analytics/forecast-sample-governance", async () => getForecastSampleGovernanceStatus());
  app.get("/api/v1/trading/forecast-sample-governance", async () => getForecastSampleGovernanceStatus());
  app.get("/api/trading/forecast-sample-governance", async () => getForecastSampleGovernanceStatus());
  app.post("/api/v1/internal/analytics/forecast-sample-gate/calculate", async () => calculateAndRecordForecastGate());
  app.get("/api/v1/internal/analytics/sport-taxonomy-map", async () => sportTaxonomyMap());
  app.get("/api/v1/trading/sport-taxonomy-map", async () => sportTaxonomyMap());
  app.get("/api/trading/sport-taxonomy-map", async () => sportTaxonomyMap());
  const postManualOddsSnapshot = async (request: any, reply: any) => {
    try {
      return await recordManualOddsSnapshot(db, (request.body ?? {}) as Record<string, unknown>);
    } catch (error) {
      reply.status(400);
      return {
        system_status: "ODDS_SNAPSHOT_CACHE_MANUAL_SAFE_V1",
        applied: false,
        rejected: true,
        reason: error instanceof Error ? error.message : "invalid_odds_snapshot_payload",
        guardrails: {
          real_candidate_count: 0,
          real_money_enabled: false,
          kelly_enabled: false,
          telegram_auto_enabled: false,
          auto_post_allowed: false,
          picks_created: 0,
          parlays_created: 0,
          kill_switch_enabled: true
        }
      };
    }
  };
  app.post("/api/v1/internal/analytics/odds-snapshot-cache/manual", postManualOddsSnapshot);
  app.post("/api/v1/trading/odds-snapshot-cache/manual", postManualOddsSnapshot);
  app.post("/api/trading/odds-snapshot-cache/manual", postManualOddsSnapshot);
  app.get("/api/v1/internal/analytics/source-capture/registry", async () => getManualVerifiedSourceRegistry());
  app.get("/api/v1/trading/source-capture/registry", async () => getManualVerifiedSourceRegistry());
  app.get("/api/trading/source-capture/registry", async () => getManualVerifiedSourceRegistry());
  app.get("/api/v1/internal/analytics/source-capture/manual-verified/status", async (request) => getManualVerifiedSourceCaptureStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/source-capture/manual-verified/status", async (request) => getManualVerifiedSourceCaptureStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/source-capture/manual-verified/status", async (request) => getManualVerifiedSourceCaptureStatus(db, matchOpsQuerySchema.parse(request.query)));
  const postManualVerifiedSourceCapture = async (request: any, reply: any) => {
    try {
      return await recordManualVerifiedSourceCapture(db, (request.body ?? {}) as Record<string, unknown>);
    } catch (error) {
      reply.status(400);
      return {
        system_status: "MANUAL_VERIFIED_SOURCE_CAPTURE_SAFE_V1",
        applied: false,
        rejected: true,
        reason: error instanceof Error ? error.message : "invalid_manual_verified_payload",
        guardrails: {
          real_candidate_count: 0,
          real_money_enabled: false,
          kelly_enabled: false,
          telegram_auto_enabled: false,
          kill_switch_enabled: true
        }
      };
    }
  };
  app.post("/api/v1/internal/analytics/source-capture/manual-verified", postManualVerifiedSourceCapture);
  app.post("/api/v1/trading/source-capture/manual-verified", postManualVerifiedSourceCapture);
  app.post("/api/trading/source-capture/manual-verified", postManualVerifiedSourceCapture);
  app.get("/api/v1/internal/analytics/football/lineups/status", async (request) => getFootballManualLineupStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/football/lineups/status", async (request) => getFootballManualLineupStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/football/lineups/status", async (request) => getFootballManualLineupStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.post("/api/v1/internal/analytics/football/lineups/manual-verified", async (request) => recordFootballManualVerifiedLineup(db, (request.body ?? {}) as Record<string, unknown>));
  app.post("/api/v1/trading/football/lineups/manual-verified", async (request) => recordFootballManualVerifiedLineup(db, (request.body ?? {}) as Record<string, unknown>));
  app.post("/api/trading/football/lineups/manual-verified", async (request) => recordFootballManualVerifiedLineup(db, (request.body ?? {}) as Record<string, unknown>));
  app.post("/api/v1/internal/analytics/match-preflight/run", async (request) => runMatchPreflight(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/v1/trading/match-preflight/run", async (request) => runMatchPreflight(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/trading/match-preflight/run", async (request) => runMatchPreflight(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/v1/internal/analytics/chain-preflight/run", async (request) => runChainPreflight(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/v1/trading/chain-preflight/run", async (request) => runChainPreflight(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/v1/internal/analytics/candidate-preflight/run", async (request) => runCandidatePreflight(db, candidatePreflightQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/v1/trading/candidate-preflight/run", async (request) => runCandidatePreflight(db, candidatePreflightQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.get("/api/v1/internal/analytics/match-data-harvester/status", async (request) => getMatchDataHarvesterStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/match-data-harvester/status", async (request) => getMatchDataHarvesterStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/match-data-harvester/status", async (request) => getMatchDataHarvesterStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.post("/api/v1/internal/analytics/match-data-harvester/run", async (request) => runMatchDataHarvester(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/v1/trading/match-data-harvester/run", async (request) => runMatchDataHarvester(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/trading/match-data-harvester/run", async (request) => runMatchDataHarvester(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.get("/api/v1/internal/analytics/mlb/park-weather/status", async (request) => getMlbParkWeatherStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/mlb/park-weather/status", async (request) => getMlbParkWeatherStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/mlb/park-weather/status", async (request) => getMlbParkWeatherStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.post("/api/v1/internal/analytics/mlb/park-weather/run", async (request) => runMlbParkWeatherContext(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/v1/trading/mlb/park-weather/run", async (request) => runMlbParkWeatherContext(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/trading/mlb/park-weather/run", async (request) => runMlbParkWeatherContext(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.get("/api/v1/internal/analytics/mlb/near-start-harvester/status", async (request) => getMlbNearStartHarvesterStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/mlb/near-start-harvester/status", async (request) => getMlbNearStartHarvesterStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/mlb/near-start-harvester/status", async (request) => getMlbNearStartHarvesterStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.post("/api/v1/internal/analytics/mlb/near-start-harvester/run", async (request) => runMlbNearStartHarvester(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/v1/trading/mlb/near-start-harvester/run", async (request) => runMlbNearStartHarvester(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/trading/mlb/near-start-harvester/run", async (request) => runMlbNearStartHarvester(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.get("/api/v1/internal/analytics/mlb/near-start-schedule", async (request) => getMlbNearStartSchedule(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/mlb/near-start-schedule", async (request) => getMlbNearStartSchedule(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/mlb/near-start-schedule", async (request) => getMlbNearStartSchedule(db, matchOpsQuerySchema.parse(request.query)));
  app.post("/api/v1/internal/analytics/mlb/near-start-schedule/run", async (request) => runMlbNearStartSchedule(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/v1/trading/mlb/near-start-schedule/run", async (request) => runMlbNearStartSchedule(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/trading/mlb/near-start-schedule/run", async (request) => runMlbNearStartSchedule(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.get("/api/v1/internal/analytics/mlb/fixture-time-repair/status", async (request) => getMlbFixtureTimeRepairStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/v1/trading/mlb/fixture-time-repair/status", async (request) => getMlbFixtureTimeRepairStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.get("/api/trading/mlb/fixture-time-repair/status", async (request) => getMlbFixtureTimeRepairStatus(db, matchOpsQuerySchema.parse(request.query)));
  app.post("/api/v1/internal/analytics/mlb/fixture-time-repair/run", async (request) => runMlbFixtureTimeRepair(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/v1/trading/mlb/fixture-time-repair/run", async (request) => runMlbFixtureTimeRepair(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/trading/mlb/fixture-time-repair/run", async (request) => runMlbFixtureTimeRepair(db, matchOpsQuerySchema.parse(mergeQueryBody(request.query, request.body))));
  app.post("/api/v1/internal/analytics/football-owned-signals", async (request) => processFootballOwnedSignals(db, request.body ?? {}));
  app.post("/api/v1/trading/football-owned-signals", async (request) => processFootballOwnedSignals(db, request.body ?? {}));
  app.post("/api/trading/football-owned-signals", async (request) => processFootballOwnedSignals(db, request.body ?? {}));
  app.get("/api/v1/internal/analytics/football-data-gateway-status", async () => getFootballDataGatewayStatus(db));
  app.get("/api/v1/trading/football-data-gateway-status", async () => getFootballDataGatewayStatus(db));
  app.get("/api/trading/football-data-gateway-status", async () => getFootballDataGatewayStatus(db));
  app.get("/api/v1/internal/analytics/sports-intelligence-core", async () => getSportsIntelligenceCoreStatus(db));
  app.get("/api/v1/trading/sports-intelligence-core", async () => getSportsIntelligenceCoreStatus(db));
  app.get("/api/trading/sports-intelligence-core", async () => getSportsIntelligenceCoreStatus(db));
  app.get("/api/v1/internal/analytics/expected-lineup-engine", async (request) => getExpectedLineupEngine(db, request.query ?? {}));
  app.get("/api/v1/trading/expected-lineup-engine", async (request) => getExpectedLineupEngine(db, request.query ?? {}));
  app.get("/api/trading/expected-lineup-engine", async (request) => getExpectedLineupEngine(db, request.query ?? {}));
  app.post("/api/v1/internal/analytics/rebuild-expected-lineups", async (request) => rebuildExpectedLineupsFromHistory(db, request.body ?? {}));
  app.post("/api/v1/trading/rebuild-expected-lineups", async (request) => rebuildExpectedLineupsFromHistory(db, request.body ?? {}));
  app.post("/api/trading/rebuild-expected-lineups", async (request) => rebuildExpectedLineupsFromHistory(db, request.body ?? {}));
  app.post("/api/v1/internal/analytics/source-observations", async (request) => recordSourceObservations(db, request.body ?? {}));
  app.post("/api/v1/trading/source-observations", async (request) => recordSourceObservations(db, request.body ?? {}));
  app.post("/api/trading/source-observations", async (request) => recordSourceObservations(db, request.body ?? {}));
  app.post("/api/v1/internal/analytics/sports-context-ingest", async (request) => recordSportsContextData(db, request.body ?? {}));
  app.post("/api/v1/trading/sports-context-ingest", async (request) => recordSportsContextData(db, request.body ?? {}));
  app.post("/api/trading/sports-context-ingest", async (request) => recordSportsContextData(db, request.body ?? {}));
  app.get("/api/v1/internal/analytics/team-context", async (request) => getSportsTeamContext(db, request.query ?? {}));
  app.get("/api/v1/trading/team-context", async (request) => getSportsTeamContext(db, request.query ?? {}));
  app.get("/api/trading/team-context", async (request) => getSportsTeamContext(db, request.query ?? {}));
  app.get("/api/v1/internal/analytics/player-context", async (request) => getSportsPlayerContext(db, request.query ?? {}));
  app.get("/api/v1/trading/player-context", async (request) => getSportsPlayerContext(db, request.query ?? {}));
  app.get("/api/trading/player-context", async (request) => getSportsPlayerContext(db, request.query ?? {}));
  app.get("/api/v1/internal/analytics/match-history", async (request) => getSportsMatchHistoryContext(db, request.query ?? {}));
  app.get("/api/v1/trading/match-history", async (request) => getSportsMatchHistoryContext(db, request.query ?? {}));
  app.get("/api/trading/match-history", async (request) => getSportsMatchHistoryContext(db, request.query ?? {}));
  app.get("/api/v1/internal/analytics/historical-intelligence", async (request) => getHistoricalIntelligenceStatus(db, request.query ?? {}));
  app.get("/api/v1/trading/historical-intelligence", async (request) => getHistoricalIntelligenceStatus(db, request.query ?? {}));
  app.get("/api/trading/historical-intelligence", async (request) => getHistoricalIntelligenceStatus(db, request.query ?? {}));
  app.get("/api/v1/internal/analytics/team-history", async (request) => getTeamHistory(db, request.query ?? {}));
  app.get("/api/v1/trading/team-history", async (request) => getTeamHistory(db, request.query ?? {}));
  app.get("/api/trading/team-history", async (request) => getTeamHistory(db, request.query ?? {}));
  app.get("/api/v1/internal/analytics/player-history", async (request) => getPlayerHistory(db, request.query ?? {}));
  app.get("/api/v1/trading/player-history", async (request) => getPlayerHistory(db, request.query ?? {}));
  app.get("/api/trading/player-history", async (request) => getPlayerHistory(db, request.query ?? {}));
  app.get("/api/v1/internal/analytics/match-historical-context", async (request) => getMatchHistoricalContext(db, request.query ?? {}));
  app.get("/api/v1/trading/match-historical-context", async (request) => getMatchHistoricalContext(db, request.query ?? {}));
  app.get("/api/trading/match-historical-context", async (request) => getMatchHistoricalContext(db, request.query ?? {}));
  app.post("/api/v1/internal/analytics/ingest-historical-matches", async (request) => ingestHistoricalMatches(db, request.body ?? {}));
  app.post("/api/v1/trading/ingest-historical-matches", async (request) => ingestHistoricalMatches(db, request.body ?? {}));
  app.post("/api/trading/ingest-historical-matches", async (request) => ingestHistoricalMatches(db, request.body ?? {}));
  app.post("/api/v1/internal/analytics/ingest-player-history", async (request) => ingestPlayerHistory(db, request.body ?? {}));
  app.post("/api/v1/trading/ingest-player-history", async (request) => ingestPlayerHistory(db, request.body ?? {}));
  app.post("/api/trading/ingest-player-history", async (request) => ingestPlayerHistory(db, request.body ?? {}));
  app.post("/api/v1/internal/analytics/rebuild-historical-context", async (request) => rebuildHistoricalContext(db, request.body ?? {}));
  app.post("/api/v1/trading/rebuild-historical-context", async (request) => rebuildHistoricalContext(db, request.body ?? {}));
  app.post("/api/trading/rebuild-historical-context", async (request) => rebuildHistoricalContext(db, request.body ?? {}));
  app.post("/api/v1/internal/analytics/build-consensus", async (request) => buildConsensusForMatch(db, request.body ?? {}));
  app.post("/api/v1/trading/build-consensus", async (request) => buildConsensusForMatch(db, request.body ?? {}));
  app.post("/api/trading/build-consensus", async (request) => buildConsensusForMatch(db, request.body ?? {}));
  app.post("/api/v1/internal/analytics/hydrate-football-intelligence", async (request) => hydrateFootballIntelligence(db, request.body ?? {}));
  app.post("/api/v1/trading/hydrate-football-intelligence", async (request) => hydrateFootballIntelligence(db, request.body ?? {}));
  app.post("/api/trading/hydrate-football-intelligence", async (request) => hydrateFootballIntelligence(db, request.body ?? {}));
  app.post("/api/v1/internal/analytics/hydrate-football-manual-context", async (request) => hydrateFootballManualContext(db, request.body ?? {}));
  app.post("/api/v1/trading/hydrate-football-manual-context", async (request) => hydrateFootballManualContext(db, request.body ?? {}));
  app.post("/api/trading/hydrate-football-manual-context", async (request) => hydrateFootballManualContext(db, request.body ?? {}));
  app.get("/api/v1/internal/analytics/high-ev-audit", async () => buildHighEvAudit());
  app.get("/api/v1/trading/high-ev-audit", async () => buildHighEvAudit());
  app.get("/api/trading/high-ev-audit", async () => buildHighEvAudit());
  app.get("/api/v1/internal/analytics/timestamp-mismatch-audit", async () => buildTimestampMismatchAudit());
  app.get("/api/v1/trading/timestamp-mismatch-audit", async () => buildTimestampMismatchAudit());
  app.get("/api/trading/timestamp-mismatch-audit", async () => buildTimestampMismatchAudit());
  app.get("/api/v1/internal/analytics/extreme-ev-closing-audit", async () => buildExtremeEvClosingAudit());
  app.get("/api/v1/trading/extreme-ev-closing-audit", async () => buildExtremeEvClosingAudit());
  app.get("/api/trading/extreme-ev-closing-audit", async () => buildExtremeEvClosingAudit());
  app.get("/api/v1/internal/analytics/closing-supported-edge", async () => buildClosingSupportedEdge());
  app.get("/api/v1/trading/closing-supported-edge", async () => buildClosingSupportedEdge());
  app.get("/api/trading/closing-supported-edge", async () => buildClosingSupportedEdge());
  app.get("/api/v1/internal/analytics/matchup-confirmation", async () => buildMatchupConfirmation());
  app.get("/api/v1/trading/matchup-confirmation", async () => buildMatchupConfirmation());
  app.get("/api/trading/matchup-confirmation", async () => buildMatchupConfirmation());
  app.get("/api/v1/internal/analytics/confirmed-pick-chain", async () => buildConfirmedPickChain());
  app.get("/api/v1/trading/confirmed-pick-chain", async () => buildConfirmedPickChain());
  app.get("/api/trading/confirmed-pick-chain", async () => buildConfirmedPickChain());
  app.get("/api/v1/internal/analytics/team-intelligence", async () => buildTeamIntelligence());
  app.get("/api/v1/trading/team-intelligence", async () => buildTeamIntelligence());
  app.get("/api/trading/team-intelligence", async () => buildTeamIntelligence());
  app.get("/api/v1/internal/analytics/player-intelligence", async () => buildPlayerIntelligence());
  app.get("/api/v1/trading/player-intelligence", async () => buildPlayerIntelligence());
  app.get("/api/trading/player-intelligence", async () => buildPlayerIntelligence());
  app.get("/api/v1/internal/analytics/intelligence-scout", async () => buildIntelligenceScout());
  app.get("/api/v1/trading/intelligence-scout", async () => buildIntelligenceScout());
  app.get("/api/trading/intelligence-scout", async () => buildIntelligenceScout());
  app.get("/api/v1/internal/analytics/why-no-bettable-paper", async () => buildWhyNoBettablePaper());
  app.get("/api/v1/trading/why-no-bettable-paper", async () => buildWhyNoBettablePaper());
  app.get("/api/trading/why-no-bettable-paper", async () => buildWhyNoBettablePaper());
  app.get("/api/v1/internal/analytics/auto-research-lab", async () => {
    const result = await db.query(
      `
        WITH params AS (
          SELECT *
          FROM (VALUES
            (0.55::numeric, 0.03::numeric, 1.30::numeric, 1.60::numeric, 'any'::text, 'any'::text, false),
            (0.55, 0.05, 1.61, 2.00, 'any', 'any', false),
            (0.58, 0.05, 2.01, 100.00, 'any', 'underdog', false),
            (0.60, 0.05, 2.01, 100.00, 'any', 'underdog', true),
            (0.60, 0.08, 2.01, 100.00, 'home', 'any', true),
            (0.60, 0.08, 2.01, 100.00, 'away', 'any', true),
            (0.65, 0.05, 1.61, 100.00, 'any', 'any', true)
          ) AS p(min_model_probability, min_ev, min_odds, max_odds, pick_filter, price_role_filter, require_positive_clv)
        ),
        samples AS (
          SELECT
            p.*,
            rps.*
          FROM params p
          JOIN real_paper_snapshots rps
            ON rps.sport_slug = 'baseball'
           AND rps.league_slug = 'mlb'
           AND rps.market_type = 'moneyline_2way'
           AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
           AND rps.model_probability >= p.min_model_probability
           AND rps.expected_value >= p.min_ev
           AND rps.entry_odds >= p.min_odds
           AND rps.entry_odds <= p.max_odds
           AND (p.pick_filter = 'any' OR rps.pick = p.pick_filter)
           AND (
             p.price_role_filter = 'any'
             OR (p.price_role_filter = 'favorite' AND rps.entry_odds <= 1.9499)
             OR (p.price_role_filter = 'underdog' AND rps.entry_odds >= 2.0100)
           )
           AND (p.require_positive_clv = false OR COALESCE(rps.clv, 0) > 0)
        ),
        grouped AS (
          SELECT
            min_model_probability,
            min_ev,
            min_odds,
            max_odds,
            pick_filter,
            price_role_filter,
            require_positive_clv,
            COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
            COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
            CASE WHEN COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS')) > 0
              THEN ROUND((COUNT(*) FILTER (WHERE status = 'WIN')::numeric / COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS'))), 6)
              ELSE NULL
            END AS win_rate,
            ROUND(AVG(POWER((CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) - model_probability, 2))::numeric, 6) AS brier,
            ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_flat,
            ROUND((COALESCE(SUM(profit_loss), 0) / NULLIF(COUNT(*), 0))::numeric, 6) AS roi,
            ROUND((COALESCE(SUM(profit_loss), 0) / NULLIF(COUNT(*), 0))::numeric, 6) AS yield,
            ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS average_clv
          FROM samples
          GROUP BY min_model_probability, min_ev, min_odds, max_odds, pick_filter, price_role_filter, require_positive_clv
        )
        SELECT
          CONCAT(
            'prob>=', min_model_probability,
            ' ev>=', min_ev,
            ' odds=', min_odds, '-', max_odds,
            ' pick=', pick_filter,
            ' role=', price_role_filter,
            ' clv+', require_positive_clv
          ) AS rule_key,
          *,
          0::numeric AS max_drawdown,
          CASE
            WHEN n < 30 THEN 'INSUFFICIENT_SAMPLE'
            WHEN profit_flat > 0 AND COALESCE(average_clv, 0) > 0 AND COALESCE(brier, 1) <= 0.25 THEN 'PROMOTE'
            WHEN profit_flat > 0 AND COALESCE(average_clv, 0) <= 0 THEN 'WATCH'
            WHEN profit_flat < 0 AND COALESCE(average_clv, 0) < 0 THEN 'REJECT'
            ELSE 'ACCUMULATING'
          END AS recommendation
        FROM grouped
        ORDER BY
          CASE
            WHEN n >= 30 AND profit_flat > 0 AND COALESCE(average_clv, 0) > 0 AND COALESCE(brier, 1) <= 0.25 THEN 0
            WHEN n < 30 THEN 2
            ELSE 1
          END,
          profit_flat DESC,
          average_clv DESC NULLS LAST
      `
    );

    return {
      count: result.rows.length,
      rows: result.rows,
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        real_candidate_enabled: false
      }
    };
  });

  app.get("/api/v1/internal/analytics/market-products", async () => {
    const result = await db.query(
      `
        WITH products AS (
          SELECT 'MLB Moneyline' AS product, 'baseball' AS sport_slug, 'mlb' AS league_slug, 'moneyline_2way' AS market_type, NULL::text AS segment, 75 AS required_closed
          UNION ALL SELECT 'MLB Underdogs', 'baseball', 'mlb', 'moneyline_2way', 'underdogs', 50
          UNION ALL SELECT 'MLB Favorites', 'baseball', 'mlb', 'moneyline_2way', 'favorites', 50
          UNION ALL SELECT 'MLB Home', 'baseball', 'mlb', 'moneyline_2way', 'home', 50
          UNION ALL SELECT 'MLB Away', 'baseball', 'mlb', 'moneyline_2way', 'away', 50
          UNION ALL SELECT 'Mundial 1X2', 'soccer', 'fifa-world-cup-2026', 'moneyline_3way', NULL, 50
          UNION ALL SELECT 'Mundial DNB', 'soccer', 'fifa-world-cup-2026', 'draw_no_bet', NULL, 50
          UNION ALL SELECT 'Mundial Under 2.5', 'soccer', 'fifa-world-cup-2026', 'total_goals_2_5', 'under', 50
        ),
        mlb AS (
          SELECT
            p.product,
            p.sport_slug,
            p.league_slug,
            p.market_type,
            p.segment,
            p.required_closed,
            COUNT(rps.*)::int AS current_closed,
            ROUND(AVG(rps.clv) FILTER (WHERE rps.clv IS NOT NULL)::numeric, 6) AS avg_clv,
            ROUND(COALESCE(SUM(rps.profit_loss), 0)::numeric, 4) AS profit_units
          FROM products p
          LEFT JOIN real_paper_snapshots rps
            ON rps.sport_slug = p.sport_slug
           AND rps.league_slug = p.league_slug
           AND rps.market_type = p.market_type
           AND rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
           AND (
             p.segment IS NULL
             OR (p.segment = 'underdogs' AND rps.entry_odds >= 2.0100)
             OR (p.segment = 'favorites' AND rps.entry_odds <= 1.9499)
             OR (p.segment IN ('home', 'away', 'under') AND rps.pick = p.segment)
           )
          WHERE p.sport_slug = 'baseball'
          GROUP BY p.product, p.sport_slug, p.league_slug, p.market_type, p.segment, p.required_closed
        ),
        worldcup AS (
          SELECT
            p.product,
            p.sport_slug,
            p.league_slug,
            p.market_type,
            p.segment,
            p.required_closed,
            COUNT(pt.*)::int AS current_closed,
            NULL::numeric AS avg_clv,
            ROUND(COALESCE(SUM(pt.net_profit), 0)::numeric, 4) AS profit_units
          FROM products p
          LEFT JOIN paper_trades pt
            ON pt.league_type = p.sport_slug
           AND pt.league_slug = p.league_slug
           AND pt.market_type = p.market_type
           AND pt.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
           AND (p.segment IS NULL OR pt.selection = p.segment)
          WHERE p.sport_slug = 'soccer'
          GROUP BY p.product, p.sport_slug, p.league_slug, p.market_type, p.segment, p.required_closed
        )
        SELECT
          *,
          CASE
            WHEN product IN ('MLB Totals', 'MLB Run Line') THEN 'BLOCKED'
            WHEN current_closed < required_closed THEN 'ACCUMULATING'
            WHEN COALESCE(avg_clv, 0) > 0 AND profit_units > 0 THEN 'READY_FOR_REVIEW'
            WHEN profit_units > 0 THEN 'WATCH'
            ELSE 'BLOCKED'
          END AS state,
          CASE
            WHEN current_closed < required_closed THEN 'falta muestra'
            WHEN COALESCE(avg_clv, 0) > 0 AND profit_units > 0 THEN 'muestra, profit y CLV alineados'
            WHEN profit_units > 0 THEN 'profit positivo, CLV necesita revision'
            ELSE 'no promover'
          END AS recommendation
        FROM (
          SELECT * FROM mlb
          UNION ALL
          SELECT * FROM worldcup
        ) all_products
        ORDER BY product
      `
    );

    return { count: result.rows.length, rows: result.rows };
  });

  app.get("/api/v1/internal/analytics/model-error-explorer", async () => {
    const result = await db.query(
      `
        WITH losses AS (
          SELECT
            rps.id AS snapshot_id,
            rps.sport_slug,
            rps.league_slug,
            rps.market_type,
            rps.pick,
            rps.entry_odds,
            rps.closing_odds,
            rps.clv,
            rps.model_probability,
            rps.expected_value,
            rps.profit_loss,
            home_team.name AS home_team_name,
            away_team.name AS away_team_name,
            CONCAT(home_team.name, ' vs ', away_team.name) AS match,
            CASE
              WHEN rps.closing_odds IS NULL THEN 'CLOSING_ODDS_MISSING'
              WHEN COALESCE(rps.clv, 0) < 0 THEN 'MARKET_MOVED_AGAINST_US'
              WHEN rps.model_probability >= 0.60 THEN 'MODEL_OVERCONFIDENT'
              WHEN rps.entry_odds <= 1.95 THEN 'FAVORITE_LOST'
              WHEN rps.entry_odds >= 2.05 THEN 'UNDERDOG_MISS'
              ELSE 'UNCLASSIFIED_LOSS'
            END AS error_type
          FROM real_paper_snapshots rps
          JOIN v_valid_matches m ON m.id = rps.match_id
          LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'home'
          LEFT JOIN teams home_team ON home_team.id = mh.team_id
          LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'away'
          LEFT JOIN teams away_team ON away_team.id = ma.team_id
          WHERE rps.status = 'LOSS'
        ),
        labeled AS (
          SELECT
            *,
            CASE error_type
              WHEN 'CLOSING_ODDS_MISSING' THEN 'falta closing_odds para medir si el mercado confirmo o contradijo el pick'
              WHEN 'MARKET_MOVED_AGAINST_US' THEN 'el mercado se movio contra nosotros antes del cierre'
              WHEN 'MODEL_OVERCONFIDENT' THEN 'el modelo asigno 60%+ y fallo; revisar calibracion'
              WHEN 'FAVORITE_LOST' THEN 'favorito perdio; revisar sesgo de favorito/local'
              WHEN 'UNDERDOG_MISS' THEN 'underdog fallo; revisar varianza y rango de cuota'
              ELSE 'perdida sin causa enriquecida; requiere features de lineup/pitcher/lesiones'
            END AS error_reason,
            CASE
              WHEN error_type IN ('MODEL_OVERCONFIDENT', 'MARKET_MOVED_AGAINST_US') THEN 'review'
              ELSE 'watch'
            END AS severity
          FROM losses
        )
        INSERT INTO model_error_events (
          snapshot_id,
          sport_slug,
          league_slug,
          market_type,
          pick,
          error_type,
          error_reason,
          severity,
          metrics
        )
        SELECT
          snapshot_id,
          sport_slug,
          league_slug,
          market_type,
          pick,
          error_type,
          error_reason,
          severity,
          jsonb_build_object(
            'entry_odds', entry_odds,
            'closing_odds', closing_odds,
            'clv', clv,
            'model_probability', model_probability,
            'expected_value', expected_value,
            'profit_loss', profit_loss,
            'home_team_name', home_team_name,
            'away_team_name', away_team_name,
            'match', match
          )
        FROM labeled
        ON CONFLICT (snapshot_id) DO UPDATE SET
          error_type = EXCLUDED.error_type,
          error_reason = EXCLUDED.error_reason,
          severity = EXCLUDED.severity,
          metrics = EXCLUDED.metrics,
          updated_at = NOW()
        RETURNING *
      `
    );

    const summary = await db.query(
      `
        SELECT error_type, severity, COUNT(*)::int AS losses
        FROM model_error_events
        GROUP BY error_type, severity
        ORDER BY losses DESC
      `
    );

    return { count: result.rows.length, summary: summary.rows, rows: result.rows };
  });

  app.get("/api/v1/internal/analytics/manual-alert-report", async (request) => {
    const query = manualAlertQuerySchema.parse(request.query);
    const values: Array<string | number> = [query.limit];
    const gradeFilter = query.grade ? `WHERE bg.grade = $${values.push(query.grade)}` : "WHERE bg.grade IN ('A', 'B')";
    const candidates = await db.query(
      `
        SELECT bg.*, rps.bookmaker, rps.entry_odds, rps.model_probability, rps.expected_value, rps.clv, rps.profit_loss, rps.status
        FROM bet_grades bg
        JOIN real_paper_snapshots rps ON rps.id = bg.snapshot_id
        ${gradeFilter}
        ORDER BY
          CASE bg.grade WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 WHEN 'D' THEN 3 ELSE 4 END,
          bg.updated_at DESC
        LIMIT $1
      `,
      values
    );

    const payload = {
      title: "Manual Real Paper Report",
      telegram_mode: "manual_only",
      real_money_enabled: false,
      kelly_enabled: false,
      send_enabled: false,
      count: candidates.rows.length,
      rows: candidates.rows
    };

    if (query.persist) {
      await db.query(
        `
          INSERT INTO manual_alert_reports (report_type, status, telegram_mode, real_money_enabled, kelly_enabled, payload)
          VALUES ('real_paper_manual_summary', 'generated_not_sent', 'manual_only', false, false, $1::jsonb)
        `,
        [JSON.stringify(payload)]
      );
    }

    return payload;
  });

  app.get("/api/v1/internal/analytics/pilot-checklist", async () => {
    const result = await db.query(
      `
        WITH mlb AS (
          SELECT
            COUNT(*)::int AS closed,
            ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv,
            ROUND((COALESCE(SUM(profit_loss), 0) / 100.0)::numeric, 4) AS profit_units
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND duplicate_of_id IS NULL
            AND COALESCE(data_state, 'FRESH') IN ('FRESH', 'ARCHIVED')
            AND status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
        ),
        provider AS (
          SELECT COUNT(DISTINCT COALESCE(bookmaker, provider_name))::int AS real_providers
          FROM odds_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
            AND quality_score >= 80
            AND provider_name NOT ILIKE '%manual%'
            AND provider_name NOT ILIKE '%shadow%'
            AND captured_at >= NOW() - INTERVAL '7 days'
        ),
        promotion AS (
          SELECT COUNT(*)::int AS approved_markets
          FROM market_promotion_rules
          WHERE rule_key = 'mlb_moneyline'
            AND status = 'READY_FOR_REVIEW'
        ),
        guardrail AS (
          SELECT *
          FROM pilot_real_guardrails
          ORDER BY updated_at DESC
          LIMIT 1
        )
        SELECT '75+ cerradas' AS check_name, closed >= 75 AS passed, closed::text AS value, 'minimo 75 MLB moneyline' AS requirement FROM mlb
        UNION ALL SELECT 'CLV positivo', COALESCE(avg_clv, 0) > 0, COALESCE(avg_clv::text, '-'), 'avg_clv > 0' FROM mlb
        UNION ALL SELECT 'Profit positivo', COALESCE(profit_units, 0) > 0, COALESCE(profit_units::text, '-'), 'profit > 0' FROM mlb
        UNION ALL SELECT 'Provider real activo', real_providers > 0, real_providers::text, 'provider real quality >= 80 en 7 dias' FROM provider
        UNION ALL SELECT 'Mercado aprobado', approved_markets > 0, approved_markets::text, 'MLB moneyline READY_FOR_REVIEW' FROM promotion
        UNION ALL SELECT 'Kill switch activo', kill_switch_enabled = true, kill_switch_enabled::text, 'kill switch debe seguir activo' FROM guardrail
        UNION ALL SELECT 'Confirmacion manual', manual_confirmation_required = true, manual_confirmation_required::text, 'confirmacion manual obligatoria' FROM guardrail
        UNION ALL SELECT 'Dinero real apagado', real_money_enabled = false, real_money_enabled::text, 'real_money_enabled false' FROM guardrail
        UNION ALL SELECT 'Kelly apagado', kelly_enabled = false, kelly_enabled::text, 'kelly_enabled false' FROM guardrail
      `
    );

    const allDataChecks = result.rows
      .filter((row) => !["Dinero real apagado", "Kelly apagado"].includes(row.check_name))
      .every((row) => row.passed === true);
    return {
      count: result.rows.length,
      rows: result.rows,
      decision: allDataChecks ? "PILOT_READY_BUT_LOCKED" : "REVIEW_ONLY",
      final_state: "NO_REAL_MONEY",
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false
      }
    };
  });

  app.get("/api/v1/internal/analytics/backtest-runs", async (request) => {
    const query = registryQuerySchema.parse(request.query);
    const result = await db.query(
      `
        SELECT id, run_name, sport_slug, league_slug, market_type, filters, results, created_at
        FROM backtest_runs
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [query.limit]
    );
    return { count: result.rows.length, rows: result.rows };
  });

  app.get("/api/v1/internal/analytics/model-registry", async (request) => {
    const query = registryQuerySchema.parse(request.query);
    const values: Array<string | number> = [query.limit];
    const statusFilter = query.status ? `WHERE mr.status = $${values.push(query.status)}` : "";
    const result = await db.query(
      `
        SELECT
          mr.*,
          mp.sample_size,
          mp.accuracy,
          mp.brier_score,
          mp.bias_home,
          mp.updated_at AS parameters_updated_at
        FROM model_registry mr
        LEFT JOIN model_parameters mp ON mp.model_name = mr.model_name AND mp.is_active = TRUE
        ${statusFilter}
        ORDER BY
          CASE mr.status
            WHEN 'active' THEN 0
            WHEN 'candidate' THEN 1
            WHEN 'frozen' THEN 2
            ELSE 3
          END,
          mr.model_name
        LIMIT $1
      `,
      values
    );
    return { filters: query, count: result.rows.length, rows: result.rows };
  });

  app.get("/api/v1/internal/analytics/feature-store-health", async () => {
    const result = await db.query(
      `
        SELECT
          sport_slug,
          model_name,
          COUNT(*)::int AS feature_rows,
          COUNT(DISTINCT match_id)::int AS matches,
          MAX(generated_at) AS latest_generated_at,
          MIN(generated_at) AS first_generated_at
        FROM model_features
        GROUP BY sport_slug, model_name
        ORDER BY latest_generated_at DESC
      `
    );
    return { count: result.rows.length, rows: result.rows };
  });

  app.get("/api/v1/internal/analytics/risk-overview", async () => {
    const [rules, exposure, recentClv] = await Promise.all([
      db.query(
        `
          SELECT rule_key, rule_name, rule_value, severity, is_active, notes
          FROM risk_rules
          ORDER BY severity DESC, rule_key
        `
      ),
      db.query(
        `
          SELECT
            sport_slug,
            league_slug,
            market_type,
            COUNT(*)::int AS open_positions,
            ROUND(COALESCE(SUM(stake_fraction), 0)::numeric, 6) AS open_stake_fraction
          FROM real_paper_snapshots
          WHERE status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULTS')
          GROUP BY sport_slug, league_slug, market_type
          ORDER BY open_stake_fraction DESC
        `
      ),
      db.query(
        `
          SELECT
            ROUND(AVG(clv)::numeric, 6) AS avg_recent_clv,
            COUNT(*)::int AS closed_with_clv
          FROM (
            SELECT clv
            FROM real_paper_snapshots
            WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
              AND clv IS NOT NULL
            ORDER BY entry_timestamp DESC
            LIMIT 25
          ) recent
        `
      )
    ]);

    const avgRecentClv = Number(recentClv.rows[0]?.avg_recent_clv ?? 0);
    return {
      rules: rules.rows,
      exposure: exposure.rows,
      recent_clv: recentClv.rows[0] ?? { avg_recent_clv: null, closed_with_clv: 0 },
      decision: avgRecentClv >= 0 ? "RISK_OK_FOR_PAPER" : "CLV_TREND_WARNING",
      guardrails: {
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false
      }
    };
  });

  app.get("/api/v1/internal/analytics/live-candidates", async () => {
    const result = await db.query(
      `
        SELECT
          rps.id,
          rps.sport_slug,
          rps.league_slug,
          rps.model_name,
          rps.market_type,
          rps.line,
          rps.pick,
          rps.bookmaker,
          rps.entry_odds,
          rps.model_probability,
          rps.expected_value,
          rps.status,
          rps.entry_timestamp,
          m.slug AS match_slug,
          home.name AS home_team_name,
          away.name AS away_team_name,
          CONCAT(home.name, ' vs ', away.name) AS match
        FROM real_paper_snapshots rps
        JOIN v_valid_matches m ON m.id = rps.match_id
        LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'home'
        LEFT JOIN teams home ON home.id = mh.team_id
        LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'away'
        LEFT JOIN teams away ON away.id = ma.team_id
        WHERE rps.status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULTS')
        ORDER BY rps.expected_value DESC, rps.entry_timestamp DESC
        LIMIT 100
      `
    );
    return {
      count: result.rows.length,
      rows: result.rows,
      guardrails: {
        real_candidate_future_only: true,
        real_money_enabled: false
      }
    };
  });
}
