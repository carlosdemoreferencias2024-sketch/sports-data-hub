import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { PaperTradeService } from "./paper-trade.service.js";

const BANKROLL_BASE = 10_000;

const paperTradeSchema = z.object({
  match_id: z.string().uuid(),
  status: z.string().optional().default("PENDING"),
  home_score: z.number().int().optional().nullable(),
  away_score: z.number().int().optional().nullable(),
  league_slug: z.string().min(1).optional(),
  league_type: z.enum(["domestic", "international"]).optional(),
  home_team: z.string().min(1).optional(),
  away_team: z.string().min(1).optional(),
  pick_detected: z.string().min(1).optional(),
  market_type: z.enum([
    "moneyline_2way",
    "moneyline_3way",
    "draw_no_bet",
    "total_goals_2_5",
    "btts",
    "run_line",
    "total_runs",
    "spread",
    "total_points",
    "tennis_moneyline"
  ]).optional(),
  selection: z.enum(["home", "away", "draw", "over", "under", "yes", "no"]).optional(),
  line: z.number().optional().nullable(),
  model_version: z.string().min(1).optional(),
  odds_source: z.enum(["market_odds", "simulated_odds", "manual_backfill_odds"]).optional(),
  model_probability: z.number().min(0).max(1).optional(),
  market_odds: z.number().gt(1).optional(),
  expected_value: z.number().optional(),
  bankroll_fraction: z.number().min(0).max(1).optional(),
  bankroll_allocation: z.number().min(0).max(1).optional(),
  raw_data: z.record(z.unknown()).optional()
});

const listPaperTradesSchema = z.object({
  league: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function roundRate(value: number, decimals = 3) {
  return Number(value.toFixed(decimals));
}

export async function paperTradeRoutes(app: FastifyInstance) {
  const service = new PaperTradeService();

  app.post("/api/v1/internal/paper-trades", async (request, reply) => {
    const body = paperTradeSchema.parse(request.body);
    const status = body.status.toLowerCase();

    if (status === "finished") {
      return service.settlePaperTrades(body.match_id, {
        home_score: body.home_score,
        away_score: body.away_score
      });
    }

    if (
      !body.pick_detected ||
      !body.market_odds ||
      body.model_probability === undefined ||
      !body.market_type ||
      !body.selection ||
      !body.model_version ||
      !body.odds_source
    ) {
      return reply.status(400).send({ error: "MISSING_TRADE_PARAMETERS" });
    }
    if (body.selection === "draw" && body.market_type !== "moneyline_3way") {
      return reply.status(400).send({ error: "INVALID_MARKET_SELECTION" });
    }
    if (["over", "under"].includes(body.selection) && !["total_goals_2_5", "total_runs", "total_points"].includes(body.market_type)) {
      return reply.status(400).send({ error: "INVALID_MARKET_SELECTION" });
    }
    if (["yes", "no"].includes(body.selection) && body.market_type !== "btts") {
      return reply.status(400).send({ error: "INVALID_MARKET_SELECTION" });
    }

    const bankrollFraction = body.bankroll_fraction ?? body.bankroll_allocation ?? 0.01;
    const inserted = await db.query(
      `
        INSERT INTO paper_trades (
          match_id, league_slug, league_type, home_team, away_team, pick_executed,
          market_type, selection, model_version, odds_source,
          model_probability, market_odds, expected_value, bankroll_allocation, line, raw_data
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT DO NOTHING
        RETURNING id;
      `,
      [
        body.match_id,
        body.league_slug ?? "unknown",
        body.league_type ?? "domestic",
        body.home_team ?? "HOME",
        body.away_team ?? "AWAY",
        body.pick_detected,
        body.market_type,
        body.selection,
        body.model_version,
        body.odds_source,
        body.model_probability,
        body.market_odds,
        body.expected_value ?? 0,
        bankrollFraction,
        body.line ?? null,
        body.raw_data ?? body
      ]
    );

    return reply.status(inserted.rowCount ? 201 : 200).send({
      created: Boolean(inserted.rowCount),
      id: inserted.rows[0]?.id ?? null
    });
  });

  app.get("/api/v1/paper-trades", async (request) => {
    const query = listPaperTradesSchema.parse(request.query);
    const filters: string[] = [];
    const values: Array<string | number> = [];

    if (query.league) {
      values.push(query.league);
      filters.push(`league_slug = $${values.length}`);
    }

    if (query.status) {
      values.push(query.status.toUpperCase());
      filters.push(`status = $${values.length}`);
    }

    values.push(query.limit);
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await db.query(
      `
        SELECT *
        FROM paper_trades
        ${where}
        ORDER BY created_at DESC
        LIMIT $${values.length};
      `,
      values
    );

    return result.rows;
  });

  app.get("/api/v1/paper-trades/summary", async () => {
    const result = await db.query(
      `
        SELECT
          COUNT(id)::int AS total_bets,
          COUNT(CASE WHEN status IN ('PENDING', 'PENDING_RESULTS') THEN 1 END)::int AS pending,
          COUNT(CASE WHEN status = 'WIN' THEN 1 END)::int AS wins,
          COUNT(CASE WHEN status = 'LOSS' THEN 1 END)::int AS losses,
          COUNT(CASE WHEN status = 'PUSH' THEN 1 END)::int AS pushes,
          COALESCE(SUM(net_profit), 0)::float8 AS profit_acumulado,
          COALESCE(
            SUM(CASE WHEN status IN ('WIN', 'LOSS', 'PUSH') THEN $1::numeric * bankroll_allocation ELSE 0 END),
            0
          )::float8 AS total_volumen_apostado
        FROM paper_trades;
      `,
      [BANKROLL_BASE]
    );

    const stats = result.rows[0] as {
      total_bets: number;
      pending: number;
      wins: number;
      losses: number;
      pushes: number;
      profit_acumulado: number;
      total_volumen_apostado: number;
    };

    const finished = stats.wins + stats.losses;
    const winRate = finished > 0 ? stats.wins / finished : 0;
    const yieldPercent =
      stats.total_volumen_apostado > 0 ? (stats.profit_acumulado / stats.total_volumen_apostado) * 100 : 0;
    const bankCurrent = BANKROLL_BASE + stats.profit_acumulado;
    const roiPercent = (stats.profit_acumulado / BANKROLL_BASE) * 100;
    const bySource = await db.query(
      `
        SELECT
          odds_source,
          COUNT(*)::int AS total_picks,
          COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
          COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
          COALESCE(SUM(net_profit), 0)::float8 AS net_profit
        FROM paper_trades
        GROUP BY odds_source
        ORDER BY odds_source;
      `
    );

    return {
      banco_control_inicial_mxn: BANKROLL_BASE,
      banco_control_actual_mxn: roundMoney(bankCurrent),
      balance_neto_mxn: roundMoney(stats.profit_acumulado),
      volumen_total_invertido_mxn: roundMoney(stats.total_volumen_apostado),
      rendimiento_por_fuente: bySource.rows,
      auditoria: {
        total_picks: stats.total_bets,
        pendientes: stats.pending,
        ganados: stats.wins,
        perdidos: stats.losses,
        reembolsados_push: stats.pushes,
        win_rate: roundRate(winRate),
        yield_percentage: roundRate(yieldPercent, 2),
        roi_percentage: roundRate(roiPercent, 2)
      }
    };
  });
}
