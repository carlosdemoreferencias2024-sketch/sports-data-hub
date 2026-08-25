import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { AppError } from "../../shared/http-errors.js";

const quoteSchema = z
  .object({
    match_id: z.string().uuid(),
    provider_name: z.string().min(1).max(80),
    market_type: z.string().min(1).max(40).default("moneyline_2way"),
    line: z.number().optional().nullable(),
    home_odds: z.number().gt(1).optional().nullable(),
    away_odds: z.number().gt(1).optional().nullable(),
    draw_odds: z.number().gt(1).optional().nullable(),
    captured_at: z.string().datetime({ offset: true }).optional(),
    force_insert: z.boolean().optional().default(false),
    raw_data: z.record(z.unknown()).optional()
  })
  .refine(
    (quote) => quote.home_odds !== null && quote.home_odds !== undefined
      || quote.away_odds !== null && quote.away_odds !== undefined
      || quote.draw_odds !== null && quote.draw_odds !== undefined,
    { message: "Al menos una cuota debe estar presente." }
  );

const quoteBatchSchema = z.object({
  quotes: z.array(quoteSchema).min(1).max(500)
});

const latestQuoteQuerySchema = z.object({
  provider: z.string().optional(),
  market_type: z.string().default("moneyline_2way"),
  line: z.coerce.number().optional(),
  max_age_seconds: z.coerce.number().int().positive().max(86_400).default(900)
});

const oddsSnapshotHealthQuerySchema = z.object({
  provider: z.string().optional(),
  league_slug: z.string().optional(),
  market_type: z.string().optional(),
  max_age_hours: z.coerce.number().int().positive().max(24 * 30).default(72),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

const providerScorecardQuerySchema = z.object({
  provider: z.string().optional(),
  league_slug: z.string().optional(),
  market_type: z.string().optional(),
  max_age_hours: z.coerce.number().int().positive().max(24 * 30).default(720),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

type NormalizedSnapshotSelection = {
  selection: "home" | "away" | "draw" | "over" | "under" | "yes" | "no" | "home_draw" | "home_away" | "draw_away";
  odds: number;
};

function isManualProvider(providerName: string) {
  const provider = providerName.toLowerCase();
  return provider.includes("manual") || provider.includes("shadow") || provider.includes("simulated");
}

function snapshotRole(providerName: string, rawData: Record<string, unknown> | undefined) {
  const requestedRole = String(rawData?.snapshot_role ?? rawData?.odds_role ?? "").toLowerCase();
  if (["market", "entry", "closing", "live", "manual_shadow"].includes(requestedRole)) {
    return requestedRole;
  }
  return isManualProvider(providerName) ? "manual_shadow" : "market";
}

function snapshotSelections(quote: z.infer<typeof quoteSchema>): NormalizedSnapshotSelection[] {
  const marketType = quote.market_type.toLowerCase();
  const homeSelection = marketType === "double_chance"
    ? "home_draw"
    : marketType.startsWith("total_")
    ? "over"
    : marketType === "btts"
      ? "yes"
      : "home";
  const awaySelection = marketType === "double_chance"
    ? "draw_away"
    : marketType.startsWith("total_")
    ? "under"
    : marketType === "btts"
      ? "no"
      : "away";
  const selections: NormalizedSnapshotSelection[] = [];

  if (quote.home_odds !== null && quote.home_odds !== undefined) {
    selections.push({ selection: homeSelection, odds: quote.home_odds });
  }
  if (quote.away_odds !== null && quote.away_odds !== undefined) {
    selections.push({ selection: awaySelection, odds: quote.away_odds });
  }
  if (quote.draw_odds !== null && quote.draw_odds !== undefined) {
    selections.push({ selection: marketType === "double_chance" ? "home_away" : "draw", odds: quote.draw_odds });
  }

  return selections;
}

function qualityForSnapshot(
  quote: z.infer<typeof quoteSchema>,
  selection: NormalizedSnapshotSelection,
  capturedAt: Date
) {
  const rawData = quote.raw_data ?? {};
  const flags: string[] = [];
  let score = 100;

  if (isManualProvider(quote.provider_name)) {
    flags.push("MANUAL_OR_SHADOW");
    score -= 35;
  }
  if (rawData.processed === false) {
    flags.push("UNPROCESSED");
    score -= 25;
  }
  if (!String(rawData.bookmaker ?? "").trim() && !isManualProvider(quote.provider_name)) {
    flags.push("MISSING_BOOKMAKER");
    score -= 15;
  }
  if (selection.odds <= 1.2 || selection.odds >= 8) {
    flags.push("ODDS_OUTLIER");
    score -= 25;
  }

  const ageSeconds = Math.max(0, Math.floor((Date.now() - capturedAt.getTime()) / 1000));
  if (ageSeconds > 900 && !isManualProvider(quote.provider_name)) {
    flags.push("STALE_ODDS");
    score -= 25;
  }

  return {
    qualityScore: Math.max(0, score),
    qualityFlags: flags
  };
}

export async function quoteRoutes(app: FastifyInstance) {
  app.post("/api/v1/internal/quotes", async (request, reply) => {
    const body = quoteBatchSchema.parse(request.body);
    let inserted = 0;
    let unchanged = 0;

    for (const quote of body.quotes) {
      const result = await db.query(
        `
          WITH exact_existing AS (
            SELECT id
            FROM market_quotes
            WHERE match_id = $1
              AND provider_name = $2
              AND market_type = $3
              AND line IS NOT DISTINCT FROM $4::numeric
              AND home_odds IS NOT DISTINCT FROM $5::numeric
              AND away_odds IS NOT DISTINCT FROM $6::numeric
              AND draw_odds IS NOT DISTINCT FROM $7::numeric
              AND NOT $10::boolean
            ORDER BY COALESCE(last_seen_at, captured_at) DESC
            LIMIT 1
          ),
          refreshed AS (
            UPDATE market_quotes mq
            SET captured_at = GREATEST(mq.captured_at, COALESCE($8::timestamptz, NOW())),
                first_seen_at = COALESCE(mq.first_seen_at, mq.captured_at),
                last_seen_at = GREATEST(COALESCE(mq.last_seen_at, mq.captured_at), COALESCE($8::timestamptz, NOW())),
                seen_count = GREATEST(COALESCE(mq.seen_count, 1), 1) + 1,
                raw_data = mq.raw_data
                  || jsonb_build_object(
                    'last_seen_raw_data', $9::jsonb,
                    'last_seen_at', COALESCE($8::timestamptz, NOW()),
                    'dedupe_guard', 'market_quote_exact_reuse_v1'
                  )
            FROM exact_existing ee
            WHERE mq.id = ee.id
            RETURNING mq.id, mq.captured_at, TRUE AS reused
          ),
          latest AS (
            SELECT home_odds, away_odds, draw_odds
            FROM market_quotes
            WHERE match_id = $1
              AND provider_name = $2
              AND market_type = $3
              AND line IS NOT DISTINCT FROM $4::numeric
            ORDER BY captured_at DESC
            LIMIT 1
          ),
          inserted AS (
          INSERT INTO market_quotes (
            match_id, provider_name, market_type, line, home_odds, away_odds,
            draw_odds, captured_at, raw_data, first_seen_at, last_seen_at, seen_count
          )
          SELECT
            $1, $2, $3, $4, $5, $6, $7,
            COALESCE($8::timestamptz, NOW()),
            $9,
            COALESCE($8::timestamptz, NOW()),
            COALESCE($8::timestamptz, NOW()),
            1
          WHERE NOT EXISTS (SELECT 1 FROM refreshed)
            AND (
              $10::boolean OR NOT EXISTS (
            SELECT 1
            FROM latest
            WHERE home_odds IS NOT DISTINCT FROM $5::numeric
              AND away_odds IS NOT DISTINCT FROM $6::numeric
              AND draw_odds IS NOT DISTINCT FROM $7::numeric
              )
          )
          RETURNING id, captured_at, FALSE AS reused
          )
          SELECT * FROM refreshed
          UNION ALL
          SELECT * FROM inserted;
        `,
        [
          quote.match_id,
          quote.provider_name,
          quote.market_type,
          quote.line ?? null,
          quote.home_odds ?? null,
          quote.away_odds ?? null,
          quote.draw_odds ?? null,
          quote.captured_at ?? null,
          quote.raw_data ?? quote,
          quote.force_insert
        ]
      );
      const quoteRow = result.rows[0];
      inserted += quoteRow && !quoteRow.reused ? 1 : 0;
      unchanged += quoteRow?.reused || !quoteRow ? 1 : 0;

      const insertedQuote = quoteRow;
      if (insertedQuote) {
        const capturedAt = new Date(insertedQuote.captured_at);
        const role = snapshotRole(quote.provider_name, quote.raw_data);
        const sourceName = String(quote.raw_data?.source ?? quote.provider_name);
        const bookmaker = String(quote.raw_data?.bookmaker ?? "");
        const externalEventId = String(quote.raw_data?.event_id ?? quote.raw_data?.provider_event_id ?? "");
        const bookmakerEventId = String(quote.raw_data?.bookmaker_event_id ?? "");

        for (const selection of snapshotSelections(quote)) {
          const quality = qualityForSnapshot(quote, selection, capturedAt);
          await db.query(
            `
              INSERT INTO odds_snapshots (
                market_quote_id, match_id, sport_slug, league_slug, provider_name,
                source_name, bookmaker, external_event_id, bookmaker_event_id,
                market_type, line, selection, odds, snapshot_role, captured_at,
                quality_score, quality_flags, raw_data
              )
              SELECT
                $1, $2,
                CASE
                  WHEN l.slug IN ('mlb', 'baseball/mlb') THEN 'baseball'
                  WHEN l.slug = 'nba' THEN 'basketball'
                  WHEN l.slug LIKE '%world-cup%' OR s.slug = 'soccer' THEN 'soccer'
                  ELSE s.slug
                END,
                l.slug,
                $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''),
                $8, $9, $10, $11, $12, $13,
                $14, $15, $16
              FROM v_valid_matches m
              JOIN leagues l ON l.id = m.league_id
              JOIN sports s ON s.id = l.sport_id
              WHERE m.id = $2
              ON CONFLICT (market_quote_id, selection) WHERE market_quote_id IS NOT NULL DO UPDATE SET
                captured_at = GREATEST(odds_snapshots.captured_at, EXCLUDED.captured_at),
                received_at = NOW(),
                quality_score = EXCLUDED.quality_score,
                quality_flags = EXCLUDED.quality_flags,
                raw_data = odds_snapshots.raw_data
                  || jsonb_build_object(
                    'last_seen_raw_data', EXCLUDED.raw_data,
                    'dedupe_guard', 'odds_snapshot_exact_reuse_v1'
                  );
            `,
            [
              insertedQuote.id,
              quote.match_id,
              quote.provider_name,
              sourceName,
              bookmaker,
              externalEventId,
              bookmakerEventId,
              quote.market_type,
              quote.line ?? null,
              selection.selection,
              selection.odds,
              role,
              insertedQuote.captured_at,
              quality.qualityScore,
              quality.qualityFlags,
              quote.raw_data ?? quote
            ]
          );
        }
      }
    }

    return reply.status(inserted ? 201 : 200).send({
      status: "success",
      received: body.quotes.length,
      inserted,
      unchanged
    });
  });

  app.get<{ Params: { matchId: string } }>(
    "/api/v1/internal/matches/:matchId/latest-quotes",
    async (request) => {
      const matchId = z.string().uuid().parse(request.params.matchId);
      const query = latestQuoteQuerySchema.parse(request.query);
      const values: Array<string | number> = [matchId, query.market_type, query.max_age_seconds];
      const providerFilter = query.provider
        ? `AND provider_name = $${values.push(query.provider)}`
        : "";
      const lineFilter = query.line !== undefined
        ? `AND line IS NOT DISTINCT FROM $${values.push(query.line)}::numeric`
        : "";

      const result = await db.query(
        `
          SELECT
            id, match_id, provider_name, market_type, line, home_odds, away_odds,
            draw_odds, captured_at,
            EXTRACT(EPOCH FROM (NOW() - captured_at))::int AS age_seconds
          FROM market_quotes
          WHERE match_id = $1
            AND market_type = $2
            AND captured_at >= NOW() - ($3::int * INTERVAL '1 second')
            ${providerFilter}
            ${lineFilter}
          ORDER BY captured_at DESC
          LIMIT 1;
        `,
        values
      );

      if (!result.rows[0]) {
        throw new AppError(404, "No hay cuotas frescas disponibles para este partido");
      }
      return result.rows[0];
    }
  );

  app.get("/api/v1/internal/odds-snapshots/health", async (request) => {
    const query = oddsSnapshotHealthQuerySchema.parse(request.query);
    const values: Array<string | number> = [query.max_age_hours, query.limit];
    const filters: string[] = ["captured_at >= NOW() - ($1::int * INTERVAL '1 hour')"];

    if (query.provider) {
      filters.push(`provider_name = $${values.push(query.provider)}`);
    }
    if (query.league_slug) {
      filters.push(`league_slug = $${values.push(query.league_slug)}`);
    }
    if (query.market_type) {
      filters.push(`market_type = $${values.push(query.market_type)}`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await db.query(
      `
        SELECT
          provider_name,
          COALESCE(bookmaker, provider_name) AS bookmaker,
          sport_slug,
          league_slug,
          market_type,
          snapshot_role,
          COUNT(*)::int AS snapshots,
          ROUND(AVG(quality_score)::numeric, 2) AS avg_quality_score,
          COUNT(*) FILTER (WHERE quality_score >= 80)::int AS clean_snapshots,
          COUNT(*) FILTER (WHERE quality_score < 80)::int AS review_snapshots,
          MAX(captured_at) AS latest_captured_at
        FROM odds_snapshots
        ${whereClause}
        GROUP BY provider_name, bookmaker, sport_slug, league_slug, market_type, snapshot_role
        ORDER BY latest_captured_at DESC NULLS LAST, snapshots DESC
        LIMIT $2;
      `,
      values
    );

    const totals = result.rows.reduce(
      (acc, row) => {
        acc.snapshots += Number(row.snapshots ?? 0);
        acc.clean_snapshots += Number(row.clean_snapshots ?? 0);
        acc.review_snapshots += Number(row.review_snapshots ?? 0);
        return acc;
      },
      { snapshots: 0, clean_snapshots: 0, review_snapshots: 0 }
    );

    return {
      totals,
      count: result.rows.length,
      rows: result.rows
    };
  });

  app.get("/api/v1/internal/odds-snapshots/provider-scorecard", async (request) => {
    const query = providerScorecardQuerySchema.parse(request.query);
    const values: Array<string | number> = [query.max_age_hours, query.limit];
    const filters: string[] = ["captured_at >= NOW() - ($1::int * INTERVAL '1 hour')"];

    if (query.provider) {
      filters.push(`provider_name = $${values.push(query.provider)}`);
    }
    if (query.league_slug) {
      filters.push(`league_slug = $${values.push(query.league_slug)}`);
    }
    if (query.market_type) {
      filters.push(`market_type = $${values.push(query.market_type)}`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await db.query(
      `
        WITH provider_metrics AS (
          SELECT
            provider_name,
            COALESCE(bookmaker, provider_name) AS bookmaker,
            COALESCE(source_name, provider_name) AS source_name,
            sport_slug,
            league_slug,
            market_type,
            COUNT(*)::int AS snapshots,
            COUNT(*) FILTER (WHERE snapshot_role IN ('market', 'entry', 'live'))::int AS market_snapshots,
            COUNT(*) FILTER (WHERE snapshot_role = 'closing')::int AS closing_snapshots,
            COUNT(*) FILTER (WHERE quality_score >= 80)::int AS clean_snapshots,
            COUNT(*) FILTER (WHERE quality_score < 80)::int AS review_snapshots,
            COUNT(*) FILTER (
              WHERE snapshot_role IN ('market', 'entry', 'live')
                AND captured_at < NOW() - INTERVAL '15 minutes'
            )::int AS stale_market_snapshots,
            ROUND(AVG(quality_score)::numeric, 2) AS avg_quality_score,
            MAX(captured_at) FILTER (WHERE snapshot_role IN ('market', 'entry', 'live')) AS latest_market_at,
            MAX(captured_at) FILTER (WHERE snapshot_role = 'closing') AS latest_closing_at,
            MAX(captured_at) AS latest_captured_at
          FROM odds_snapshots
          ${whereClause}
          GROUP BY provider_name, bookmaker, source_name, sport_slug, league_slug, market_type
        ),
        scored AS (
          SELECT
            *,
            ROUND(
              LEAST(
                100,
                GREATEST(
                  0,
                  COALESCE(avg_quality_score, 0)
                    + CASE WHEN clean_snapshots > 0 THEN 5 ELSE -10 END
                    + CASE WHEN market_snapshots > 0 THEN 5 ELSE -5 END
                    + CASE WHEN closing_snapshots > 0 THEN 5 ELSE 0 END
                    - CASE WHEN stale_market_snapshots > 0 THEN 10 ELSE 0 END
                )
              )::numeric,
              2
            ) AS provider_score
          FROM provider_metrics
        )
        SELECT
          *,
          CASE
            WHEN market_snapshots = 0 AND closing_snapshots > 0 THEN 'CLOSING_ONLY'
            WHEN clean_snapshots = 0 THEN 'REVIEW'
            WHEN latest_market_at IS NOT NULL AND latest_market_at < NOW() - INTERVAL '2 hours' THEN 'STALE'
            WHEN provider_score >= 80 THEN 'ACTIVE_CLEAN'
            WHEN provider_score >= 60 THEN 'WATCH'
            ELSE 'REVIEW'
          END AS status,
          CASE WHEN snapshots > 0 THEN ROUND((clean_snapshots::numeric / snapshots), 6) ELSE NULL END AS clean_rate,
          CASE WHEN snapshots > 0 THEN ROUND((review_snapshots::numeric / snapshots), 6) ELSE NULL END AS review_rate
        FROM scored
        ORDER BY provider_score DESC, latest_captured_at DESC NULLS LAST, snapshots DESC
        LIMIT $2;
      `,
      values
    );

    return {
      count: result.rows.length,
      rows: result.rows,
      guardrails: {
        alpha_clean_threshold: 80,
        real_money_enabled: false,
        kelly_enabled: false
      }
    };
  });
}
