import { FOOTBALL_STANDARD_MARKETS, FootballMarketKey } from "./football-leagues.config.js";
import { resolveFootballLeagueId } from "./football-league-aliases.js";
import { closingWindowDiagnostics } from "./timezone.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

type ResultInput = {
  match_id: string;
  league?: string;
  league_id?: string;
  home_score: number;
  away_score: number;
  finished_at?: string;
  result_source?: string;
};

type ClosingInput = {
  match_id: string;
  market: FootballMarketKey;
  selection: string;
  closing_odds: number;
  closing_odds_timestamp: string;
  closing_odds_provider?: string;
  closing_line_source?: string;
  scheduled_kickoff?: string;
  source_confidence_score?: number;
};

type SettlementInput = {
  dry_run?: boolean;
  results?: ResultInput[];
  closing_odds?: ClosingInput[];
};

const SUPPORTED_MARKETS = new Set<FootballMarketKey>(["moneyline_3way", "total_goals_2_5", "draw_no_bet", "double_chance"]);

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDateIso(value: unknown, field: string): string {
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field}_invalid`);
  }
  return parsed.toISOString();
}

function decimalClv(entryOdds: number, closingOdds: number) {
  const impliedEntry = 1 / entryOdds;
  const impliedClose = 1 / closingOdds;
  const clv = impliedClose - impliedEntry;
  return {
    implied_entry: impliedEntry,
    implied_close: impliedClose,
    clv,
    clv_pct: clv * 100
  };
}

function clvBand(clv: number) {
  if (clv >= 0.005) return "POSITIVE";
  if (clv >= -0.0025) return "NEUTRAL";
  if (clv >= -0.01) return "SMALL_NEGATIVE";
  if (clv >= -0.03) return "NEGATIVE";
  return "BAD_NEGATIVE";
}

function closingQuality(closing: ClosingInput, raw: Record<string, unknown>) {
  const confidence = Number(closing.source_confidence_score ?? raw.source_confidence_score ?? 85);
  if (Number.isFinite(confidence) && confidence < 70) {
    return {
      closing_quality: "SOURCE_WEAK",
      closing_window_start: null,
      closing_window_end: null,
      minutes_before_kickoff: null,
      minutes_from_valid_window: null,
      why_invalid: "Source confidence below 70; stored for audit only."
    };
  }

  const kickoffRaw = closing.scheduled_kickoff
    ?? raw.kickoff
    ?? raw.kickoff_at
    ?? raw.scheduled_kickoff
    ?? raw.match_kickoff;
  return closingWindowDiagnostics(String(closing.closing_odds_timestamp), kickoffRaw ? String(kickoffRaw) : null);
}

function normalizeSelection(selection: string) {
  return selection.toLowerCase().replace(/\s+/g, "_");
}

function isHomeDraw(selection: string) {
  return ["home_draw", "home_or_draw", "1x"].includes(selection);
}

function isHomeAway(selection: string) {
  return ["home_away", "home_or_away", "12"].includes(selection);
}

function isDrawAway(selection: string) {
  return ["draw_away", "draw_or_away", "x2"].includes(selection);
}

function gradePick(market: FootballMarketKey, selectionRaw: string, homeScore: number, awayScore: number) {
  const selection = normalizeSelection(selectionRaw);
  if (market === "moneyline_3way") {
    if (selection === "home") return homeScore > awayScore ? "WIN" : "LOSS";
    if (selection === "away") return awayScore > homeScore ? "WIN" : "LOSS";
    if (selection === "draw") return homeScore === awayScore ? "WIN" : "LOSS";
  }
  if (market === "total_goals_2_5") {
    const total = homeScore + awayScore;
    if (selection === "over" || selection === "over_2_5") return total > 2.5 ? "WIN" : "LOSS";
    if (selection === "under" || selection === "under_2_5") return total < 2.5 ? "WIN" : "LOSS";
  }
  if (market === "draw_no_bet") {
    if (homeScore === awayScore) return "PUSH";
    if (selection === "home" || selection === "home_dnb") return homeScore > awayScore ? "WIN" : "LOSS";
    if (selection === "away" || selection === "away_dnb") return awayScore > homeScore ? "WIN" : "LOSS";
  }
  if (market === "double_chance") {
    if (isHomeDraw(selection)) return homeScore >= awayScore ? "WIN" : "LOSS";
    if (isHomeAway(selection)) return homeScore !== awayScore ? "WIN" : "LOSS";
    if (isDrawAway(selection)) return awayScore >= homeScore ? "WIN" : "LOSS";
  }
  return "SETTLEMENT_ERROR";
}

function profitFor(status: string, marketOdds: number) {
  if (status === "WIN") return marketOdds - 1;
  if (status === "LOSS") return -1;
  return 0;
}

function closingStatus(closing?: ClosingInput) {
  if (!closing) return "MISSING_CLOSING";
  if (!Number.isFinite(Number(closing.closing_odds)) || Number(closing.closing_odds) <= 1) return "CLOSING_INVALID";
  try {
    parseDateIso(closing.closing_odds_timestamp, "closing_odds_timestamp");
  } catch {
    return "CLOSING_INVALID";
  }
  return "HAS_CLOSING";
}

function keyFor(matchId: string, market?: string, selection?: string) {
  return `${matchId}:${market ?? ""}:${selection ?? ""}`;
}

export async function settleFootballShadow(db: Queryable, body: SettlementInput) {
  const dryRun = body.dry_run !== false;
  const results = body.results ?? [];
  const closings = body.closing_odds ?? [];
  const resultByMatch = new Map(results.map((result) => [result.match_id, result]));
  const closingBySignal = new Map(closings.map((closing) => [keyFor(closing.match_id, closing.market, closing.selection), closing]));
  const matchIds = Array.from(new Set([...results.map((item) => item.match_id), ...closings.map((item) => item.match_id)]));
  const summary = {
    dry_run: dryRun,
    would_check: 0,
    would_settle: 0,
    would_update_closing: 0,
    settled: 0,
    updated_closing: 0,
    missing_results: 0,
    missing_closing: 0,
    blocked: 0,
    errors: 0
  };
  const rows: Record<string, unknown>[] = [];

  if (matchIds.length === 0) {
    return {
      ...summary,
      examples: rows,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      real_candidate_count: 0
    };
  }

  const trades = await db.query(
    `
      SELECT *
      FROM paper_trades
      WHERE match_id = ANY($1::uuid[])
        AND league_type = 'football_shadow'
        AND market_type = ANY($2::text[])
    `,
    [matchIds, FOOTBALL_STANDARD_MARKETS]
  );

  for (const trade of trades.rows) {
    summary.would_check += 1;
    const matchId = String(trade.match_id);
    const market = String(trade.market_type) as FootballMarketKey;
    const selection = String(trade.selection);
    const raw = (trade.raw_data ?? {}) as Record<string, unknown>;
    const result = resultByMatch.get(matchId);
    const closing = closingBySignal.get(keyFor(matchId, market, selection));
    const alreadySettled = ["WIN", "LOSS", "PUSH", "VOID", "SETTLED"].includes(String(trade.status));

    if (!SUPPORTED_MARKETS.has(market)) {
      summary.blocked += 1;
      rows.push({ match_id: matchId, market, selection, status: "BLOCKED", reason: "market_not_supported" });
      continue;
    }
    if (market === "btts" && raw.manual_review !== true && raw.manual_review_required !== true) {
      summary.blocked += 1;
      rows.push({ match_id: matchId, market, selection, status: "BLOCKED", reason: "btts_requires_manual_review" });
      continue;
    }
    if (alreadySettled) {
      summary.blocked += 1;
      rows.push({ match_id: matchId, market, selection, status: "BLOCKED", reason: "already_settled" });
      continue;
    }

    const closeStatus = closingStatus(closing);
    let closingPatch: Record<string, unknown> = { closing_status: closeStatus };
    if (closing && closeStatus === "HAS_CLOSING") {
      const closingOdds = Number(closing.closing_odds);
      const entryOdds = Number(trade.market_odds);
      const clv = decimalClv(entryOdds, closingOdds);
      const quality = closingQuality(closing, raw);
      closingPatch = {
        ...closingPatch,
        closing_odds: closingOdds,
        closing_odds_timestamp: parseDateIso(closing.closing_odds_timestamp, "closing_odds_timestamp"),
        closing_odds_timestamp_original: closing.closing_odds_timestamp,
        closing_odds_provider: closing.closing_odds_provider ?? "manual_closing",
        closing_line_source: closing.closing_line_source ?? "manual_closing",
        closing_quality: quality.closing_quality,
        closing_window_start: quality.closing_window_start,
        closing_window_end: quality.closing_window_end,
        minutes_before_kickoff: quality.minutes_before_kickoff,
        minutes_from_valid_window: quality.minutes_from_valid_window,
        closing_why_invalid: quality.why_invalid,
        clv_band: clvBand(clv.clv),
        entry_odds: entryOdds,
        ...clv
      };
      summary.would_update_closing += 1;
    } else {
      summary.missing_closing += 1;
    }

    if (!result) {
      summary.missing_results += 1;
      rows.push({
        match_id: matchId,
        market,
        selection,
        status: "PENDING_RESULT",
        closing_status: closeStatus,
        closing_quality: closingPatch.closing_quality,
        closing_window_start: closingPatch.closing_window_start,
        closing_window_end: closingPatch.closing_window_end,
        minutes_from_valid_window: closingPatch.minutes_from_valid_window,
        closing_why_invalid: closingPatch.closing_why_invalid,
        clv_band: closingPatch.clv_band
      });
      if (!dryRun && closeStatus === "HAS_CLOSING") {
        await db.query(
          `UPDATE paper_trades SET raw_data = raw_data || $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(closingPatch), trade.id]
        );
        summary.updated_closing += 1;
      }
      continue;
    }

    const leagueId = resolveFootballLeagueId(result.league_id ?? result.league ?? String(trade.league_slug));
    if (!leagueId) {
      summary.errors += 1;
      rows.push({ match_id: matchId, market, selection, status: "SETTLEMENT_ERROR", reason: "league_not_resolved" });
      continue;
    }

    const homeScore = toNumber(result.home_score, Number.NaN);
    const awayScore = toNumber(result.away_score, Number.NaN);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
      summary.errors += 1;
      rows.push({ match_id: matchId, market, selection, status: "SETTLEMENT_ERROR", reason: "invalid_score" });
      continue;
    }

    const finalStatus = gradePick(market, selection, homeScore, awayScore);
    if (finalStatus === "SETTLEMENT_ERROR") {
      summary.errors += 1;
      rows.push({ match_id: matchId, market, selection, status: "SETTLEMENT_ERROR", reason: "unsupported_selection" });
      continue;
    }
    const profit = profitFor(finalStatus, Number(trade.market_odds));
    const settledAt = result.finished_at ? parseDateIso(result.finished_at, "finished_at") : new Date().toISOString();
    const patch = {
      ...closingPatch,
      settlement_status: closeStatus === "HAS_CLOSING" ? finalStatus : "SETTLED_WITHOUT_CLOSING",
      settlement_reason: `${market}:${selection}:${homeScore}-${awayScore}`,
      home_score: homeScore,
      away_score: awayScore,
      result_source: result.result_source ?? "manual_result",
      finished_at: result.finished_at ?? null,
      settled_at: settledAt,
      profit_units: profit,
      shadow_paper_only: true,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false
    };
    summary.would_settle += 1;
    rows.push({
      match_id: matchId,
      league_id: leagueId,
      market,
      selection,
      status: finalStatus,
      profit_units: profit,
      closing_status: closeStatus,
      closing_quality: closingPatch.closing_quality,
      closing_window_start: closingPatch.closing_window_start,
      closing_window_end: closingPatch.closing_window_end,
      minutes_from_valid_window: closingPatch.minutes_from_valid_window,
      closing_why_invalid: closingPatch.closing_why_invalid,
      clv_band: closingPatch.clv_band
    });

    if (!dryRun) {
      await db.query(
        `
          UPDATE paper_trades
          SET status = $1,
              net_profit = $2,
              settled_at = $3::timestamptz,
              raw_data = raw_data || $4::jsonb,
              updated_at = NOW()
          WHERE id = $5
        `,
        [finalStatus, profit, settledAt, JSON.stringify(patch), trade.id]
      );
      summary.settled += 1;
      if (closeStatus === "HAS_CLOSING") summary.updated_closing += 1;
    }
  }

  return {
    ...summary,
    examples: rows.slice(0, 50),
    rows,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    real_candidate_count: 0
  };
}
