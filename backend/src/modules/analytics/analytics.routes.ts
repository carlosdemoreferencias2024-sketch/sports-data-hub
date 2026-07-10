import { FastifyInstance } from "fastify";
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

const ruleExplorerQuerySchema = z.object({
  active_only: z.coerce.boolean().default(true),
  min_closed: z.coerce.number().int().min(1).max(1000).default(1),
  persist: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const ruleWatchlistQuerySchema = z.object({
  status: z.enum(["watch", "hot", "cooling", "rejected", "ready_for_real_paper_plus", "reviewed", "retired"]).default("watch"),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const governanceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100)
});


const staleArchiveQuerySchema = z.object({
  apply: z.coerce.boolean().default(false),
  dry_run: z.coerce.boolean().default(true),
  max_age_hours: z.coerce.number().int().min(1).max(24 * 365).default(24),
  sport: z.string().min(1).max(40).default("baseball"),
  league_slug: z.string().min(1).max(80).default("mlb"),
  market_type: z.string().min(1).max(80).default("moneyline_2way"),
  reason: z.string().min(1).max(80).default("stale_line"),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});
const manualAlertQuerySchema = z.object({
  persist: z.coerce.boolean().default(false),
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
        JOIN matches m ON m.id = g.match_id
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
            ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
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
          JOIN matches m ON m.id = mq.match_id
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
          JOIN matches m ON m.id = rps.match_id
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
            ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
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

  app.get("/api/v1/internal/analytics/bet-grading", async () => {
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
          JOIN matches m ON m.id = rps.match_id
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
  });

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

  app.get("/api/v1/internal/analytics/pick-explainability", async () => {
    const result = await db.query(
      `
        SELECT
          rps.id AS snapshot_id,
          rps.pick,
          home_team.name AS home_team_name,
          away_team.name AS away_team_name,
          CONCAT(home_team.name, ' vs ', away_team.name) AS match,
          rps.market_type,
          rps.bookmaker AS provider,
          rps.status AS snapshot_status,
          CASE
            WHEN rps.bookmaker ILIKE '%manual%' OR rps.bookmaker ILIKE '%shadow%' THEN 'RADAR_ONLY'
            WHEN rps.status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'WIN', 'LOSS', 'PUSH', 'SETTLED')
              AND rps.sport_slug = 'baseball'
              AND rps.league_slug = 'mlb'
              AND rps.market_type = 'moneyline_2way'
              AND bg.provider_status = 'CLEAN'
              AND rps.expected_value >= 0.03
              AND rps.model_probability >= 0.52 THEN 'REAL_PAPER_CANDIDATE'
            WHEN bg.market_status = 'BLOCKED' OR bg.provider_status <> 'CLEAN' THEN 'REVIEW'
            ELSE 'NO_BET'
          END AS status,
          COALESCE(bg.edge_quality_grade, bg.grade) AS grade,
          rps.model_probability,
          rps.implied_probability,
          rps.expected_value,
          (bg.metrics->>'historical_avg_clv')::numeric AS clv_average,
          COALESCE((bg.metrics->>'historical_similar_sample')::int, 0) AS historical_similar_sample,
          ARRAY_REMOVE(ARRAY[
            CASE WHEN bg.provider_status = 'CLEAN' THEN 'provider_clean' END,
            CASE WHEN rps.market_type = 'moneyline_2way' THEN 'market_allowed_for_real_paper' END,
            CASE WHEN rps.expected_value >= 0.03 THEN 'ev_threshold_passed' END,
            CASE WHEN rps.model_probability >= 0.52 THEN 'model_probability_threshold_passed' END,
            CASE WHEN COALESCE(bg.edge_quality_score, 0) >= 55 THEN 'edge_quality_usable' END
          ], NULL) AS approval_rules_passed,
          ARRAY_REMOVE(ARRAY[
            CASE WHEN bg.provider_status <> 'CLEAN' THEN 'provider_not_clean' END,
            CASE WHEN bg.market_status = 'BLOCKED' THEN 'market_blocked' END,
            CASE WHEN rps.market_type <> 'moneyline_2way' THEN 'market_not_enabled_for_real_paper' END,
            CASE WHEN rps.expected_value < 0.03 THEN 'expected_value_below_threshold' END,
            CASE WHEN rps.model_probability < 0.52 THEN 'model_probability_below_threshold' END,
            CASE WHEN COALESCE(bg.edge_quality_score, 0) < 40 THEN 'edge_quality_too_low' END
          ], NULL) AS blocking_rules,
          COALESCE(
            bg.explanation_text,
            'Sin explicacion generada todavia. Ejecuta bet-grading para recalcular Edge Quality.'
          ) AS explanation_text
        FROM real_paper_snapshots rps
        JOIN matches m ON m.id = rps.match_id
        LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = mh.team_id
        LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = ma.team_id
        LEFT JOIN bet_grades bg ON bg.snapshot_id = rps.id
        ORDER BY rps.entry_timestamp DESC
        LIMIT 150
      `
    );

    return {
      count: result.rows.length,
      rows: result.rows,
      guardrails: {
        real_candidate_enabled: false,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false
      }
    };
  });

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
          JOIN matches m ON m.id = rps.match_id
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
        JOIN matches m ON m.id = rps.match_id
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
        JOIN matches m ON m.id = rps.match_id
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
        JOIN matches m ON m.id = rps.match_id
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
      JOIN matches m ON m.id = rps.match_id
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
            ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units,
            ROUND(AVG(clv) FILTER (WHERE clv IS NOT NULL)::numeric, 6) AS avg_clv
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
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
  async function buildMatchupConfirmation() {
    const [decisions, underdogPlus] = await Promise.all([buildPickDecisionRows(), buildUnderdogPlusV2()]);
    const underdogStatusById = new Map<string, string>();
    for (const row of underdogPlus.candidates || []) {
      if (row.id) underdogStatusById.set(String(row.id), String(row.underdog_plus_status || "-"));
    }

    const rows = (decisions.rows || [])
      .filter((row: Record<string, any>) => row.sport_slug === "baseball" && row.league_slug === "mlb" && row.market_type === "moneyline_2way")
      .map((row: Record<string, any>) => {
        const underdog_plus_status = underdogStatusById.get(String(row.id)) || "-";
        const matchup = confirmMatchup({ ...row, underdog_plus_status });
        const highEvAudit = auditHighEvDuplicate(row);
        const finalOperationalStatus = matchup.final_operational_status === "BETTABLE_PAPER_CONFIRMED" && !highEvAudit.allow_bettable_paper_confirmed
          ? "VALUE_ONLY_REVIEW"
          : matchup.final_operational_status;
        return {
          ...row,
          underdog_plus_status,
          ...matchup,
          ...highEvAudit,
          final_operational_status: finalOperationalStatus,
          recommendation: finalOperationalStatus !== matchup.final_operational_status
            ? `${matchup.recommendation} High EV Audit no esta limpio; mantener en review.`
            : matchup.recommendation,
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
          JOIN matches m ON m.id = rps.match_id
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
          JOIN matches m ON m.id = rps.match_id
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
          JOIN matches m ON m.id = rps.match_id
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

  app.get("/api/v1/internal/analytics/stale-archive-report", async (request) => buildStaleArchiveReport(request.query));
  app.get("/api/v1/trading/stale-archive-report", async (request) => buildStaleArchiveReport(request.query));
  app.get("/api/trading/stale-archive-report", async (request) => buildStaleArchiveReport(request.query));
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
  app.get("/api/v1/internal/analytics/football-pending-settlement-monitor", async () => getFootballPendingSettlementMonitor(db));
  app.get("/api/v1/trading/football-pending-settlement-monitor", async () => getFootballPendingSettlementMonitor(db));
  app.get("/api/trading/football-pending-settlement-monitor", async () => getFootballPendingSettlementMonitor(db));
  app.get("/api/v1/internal/analytics/football-feed-quality-report", async () => getFootballFeedQualityReport(db));
  app.get("/api/v1/trading/football-feed-quality-report", async () => getFootballFeedQualityReport(db));
  app.get("/api/trading/football-feed-quality-report", async () => getFootballFeedQualityReport(db));
  app.get("/api/v1/internal/analytics/football-command-center", async () => getFootballCommandCenter(db));
  app.get("/api/v1/trading/football-command-center", async () => getFootballCommandCenter(db));
  app.get("/api/trading/football-command-center", async () => getFootballCommandCenter(db));
  app.get("/api/v1/internal/analytics/high-ev-audit", async () => buildHighEvAudit());
  app.get("/api/v1/trading/high-ev-audit", async () => buildHighEvAudit());
  app.get("/api/trading/high-ev-audit", async () => buildHighEvAudit());
  app.get("/api/v1/internal/analytics/matchup-confirmation", async () => buildMatchupConfirmation());
  app.get("/api/v1/trading/matchup-confirmation", async () => buildMatchupConfirmation());
  app.get("/api/trading/matchup-confirmation", async () => buildMatchupConfirmation());
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
          JOIN matches m ON m.id = rps.match_id
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
            ROUND(COALESCE(SUM(profit_loss), 0)::numeric, 4) AS profit_units
          FROM real_paper_snapshots
          WHERE sport_slug = 'baseball'
            AND league_slug = 'mlb'
            AND market_type = 'moneyline_2way'
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
        JOIN matches m ON m.id = rps.match_id
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

























