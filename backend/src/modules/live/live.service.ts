import { redis } from "../../cache/redis.js";
import { db } from "../../db/index.js";
import { PaperTradeService } from "../paper-trades/paper-trade.service.js";
import { SnapshotService } from "../matches/snapshot.service.js";

export type LiveMatchState = {
  match_id: string;
  status: "scheduled" | "live" | "finished" | "postponed" | "cancelled";
  period?: string | null;
  clock?: string | null;
  home_score?: number | null;
  away_score?: number | null;
  home_odds?: number | null;
  away_odds?: number | null;
  odds_source?: "market_odds" | "simulated_odds" | "manual_backfill_odds" | null;
  updated_at: string;
  payload?: Record<string, unknown>;
};

export const liveMatchKey = (matchId: string) => `match:live:${matchId}`;
export const liveMatchChannel = (matchId: string) => `match:${matchId}`;
export const liveMatchUpdatesChannel = (matchId: string) => `match_updates:${matchId}`;

export class LiveService {
  private readonly paperTrades = new PaperTradeService();
  private readonly snapshots = new SnapshotService();

  async get(matchId: string) {
    const raw = await redis.get(liveMatchKey(matchId));
    return raw ? (JSON.parse(raw) as LiveMatchState) : null;
  }

  async set(matchId: string, state: LiveMatchState) {
    await redis.set(liveMatchKey(matchId), JSON.stringify(state), "EX", 60 * 60 * 8);
    const payload = JSON.stringify(state);
    await Promise.all([
      redis.publish(liveMatchChannel(matchId), payload),
      redis.publish(liveMatchUpdatesChannel(matchId), payload)
    ]);
    return state;
  }

  async persistFinal(matchId: string) {
    const state = await this.get(matchId);
    if (!state || state.status !== "finished") {
      return null;
    }

    await db.query(
      `
        UPDATE matches
        SET
          status = 'finished',
          period = $2,
          clock = $3,
          home_score = $4,
          away_score = $5,
          home_odds = $6,
          away_odds = $7,
          odds_source = COALESCE($8, odds_source)
        WHERE id = $1;
      `,
      [
        matchId,
        state.period ?? null,
        state.clock ?? null,
        state.home_score ?? null,
        state.away_score ?? null,
        state.home_odds ?? null,
        state.away_odds ?? null,
        state.odds_source ?? null
      ]
    );

    if (state.home_score !== null && state.home_score !== undefined && state.away_score !== null && state.away_score !== undefined) {
      await db.query(
        `
          UPDATE match_competitors
          SET
            score = CASE home_away WHEN 'home' THEN $2 WHEN 'away' THEN $3 ELSE score END,
            winner = CASE home_away WHEN 'home' THEN $2 > $3 WHEN 'away' THEN $3 > $2 ELSE FALSE END
          WHERE match_id = $1;
        `,
        [matchId, state.home_score, state.away_score]
      );
    }

    await this.snapshots.captureForMatch(matchId);
    await this.paperTrades.settlePaperTrades(matchId, {
      home_score: state.home_score,
      away_score: state.away_score
    });
    await redis.del(liveMatchKey(matchId));
    return state;
  }
}
