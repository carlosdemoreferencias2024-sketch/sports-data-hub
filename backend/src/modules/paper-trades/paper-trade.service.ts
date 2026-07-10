import { db } from "../../db/index.js";

const BANKROLL_BASE = 10_000;

type SettlementResult = "WIN" | "LOSS" | "PUSH";

function settleSelection(
  marketType: string,
  selection: string,
  homeScore: number,
  awayScore: number,
  line?: number | null
): SettlementResult | null {
  const draw = homeScore === awayScore;
  const homeWon = homeScore > awayScore;
  const awayWon = awayScore > homeScore;
  const totalScore = homeScore + awayScore;

  if (marketType === "draw_no_bet" && draw) {
    return "PUSH";
  }

  if (marketType === "moneyline_2way" && draw) {
    return "PUSH";
  }

  if (["total_goals_2_5", "total_runs", "total_points"].includes(marketType)) {
    if (line === null || line === undefined) {
      return null;
    }
    if (totalScore === line) {
      return "PUSH";
    }
    const won = (selection === "over" && totalScore > line) || (selection === "under" && totalScore < line);
    return won ? "WIN" : "LOSS";
  }

  if (marketType === "btts") {
    const bothScored = homeScore > 0 && awayScore > 0;
    const won = (selection === "yes" && bothScored) || (selection === "no" && !bothScored);
    return won ? "WIN" : "LOSS";
  }

  if (["run_line", "spread"].includes(marketType)) {
    if (line === null || line === undefined) {
      return null;
    }
    const adjustedMargin = selection === "home" ? homeScore - awayScore + line : awayScore - homeScore + line;
    if (adjustedMargin === 0) {
      return "PUSH";
    }
    return adjustedMargin > 0 ? "WIN" : "LOSS";
  }

  if (!["moneyline_2way", "moneyline_3way", "draw_no_bet"].includes(marketType)) {
    return null;
  }

  const won =
    (selection === "home" && homeWon) ||
    (selection === "away" && awayWon) ||
    (selection === "draw" && draw);

  return won ? "WIN" : "LOSS";
}

export class PaperTradeService {
  async settlePaperTrades(matchId: string, suppliedScores?: { home_score?: number | null; away_score?: number | null }) {
    const match = await db.query("SELECT home_score, away_score, status FROM matches WHERE id = $1", [matchId]);
    if (!match.rows[0]) {
      return { updated: 0, reason: "MATCH_NOT_FOUND" };
    }
    if (match.rows[0].status !== "finished") {
      return { updated: 0, reason: "MATCH_NOT_FINISHED" };
    }

    const homeScore = suppliedScores?.home_score ?? match.rows[0].home_score;
    const awayScore = suppliedScores?.away_score ?? match.rows[0].away_score;
    if (homeScore === null || homeScore === undefined || awayScore === null || awayScore === undefined) {
      const pending = await db.query(
        `
          UPDATE paper_trades
          SET status = 'PENDING_RESULTS'
          WHERE match_id = $1 AND status IN ('PENDING', 'PENDING_RESULTS')
          RETURNING id;
        `,
        [matchId]
      );
      return { updated: pending.rowCount ?? 0, reason: "MISSING_FINAL_SCORES" };
    }

    const trades = await db.query(
      `
        SELECT id, market_type, selection, bankroll_allocation, market_odds, line
        FROM paper_trades
        WHERE match_id = $1 AND status IN ('PENDING', 'PENDING_RESULTS');
      `,
      [matchId]
    );

    let updated = 0;
    const settlements = [];
    for (const trade of trades.rows) {
      const result = settleSelection(trade.market_type, trade.selection, homeScore, awayScore, trade.line);
      if (!result) {
        await db.query("UPDATE paper_trades SET status = 'PENDING_RESULTS' WHERE id = $1", [trade.id]);
        settlements.push({ id: trade.id, result: "PENDING_RESULTS", reason: "UNSUPPORTED_MARKET" });
        continue;
      }

      const stake = BANKROLL_BASE * Number(trade.bankroll_allocation);
      const profit = result === "WIN" ? stake * (Number(trade.market_odds) - 1) : result === "LOSS" ? -stake : 0;
      await db.query(
        `
          UPDATE paper_trades
          SET status = $1, net_profit = $2, settled_at = NOW()
          WHERE id = $3;
        `,
        [result, profit, trade.id]
      );
      updated += 1;
      settlements.push({ id: trade.id, result, profit: Number(profit.toFixed(2)) });
    }

    return { updated, settlements };
  }
}
