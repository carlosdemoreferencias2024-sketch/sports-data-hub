type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export async function getFootballPendingSettlementMonitor(db: Queryable) {
  const summary = await db.query(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status IN ('PENDING', 'OPEN'))::int AS open,
        COUNT(*) FILTER (WHERE status IN ('PENDING_RESULT', 'PENDING_RESULTS'))::int AS pending_results,
        COUNT(*) FILTER (WHERE status = 'PENDING_CLOSING')::int AS pending_closing,
        COUNT(*) FILTER (
          WHERE status IN ('PENDING', 'OPEN', 'PENDING_RESULT', 'PENDING_RESULTS')
            AND raw_data ? 'closing_odds'
            AND raw_data->>'closing_quality' = 'CAPTURED_ON_TIME'
            AND raw_data ? 'home_score'
        )::int AS finished_ready_for_settle,
        COUNT(*) FILTER (
          WHERE status IN ('PENDING', 'OPEN', 'PENDING_RESULT', 'PENDING_RESULTS')
            AND (
              NOT (raw_data ? 'closing_odds')
              OR raw_data->>'closing_quality' IS DISTINCT FROM 'CAPTURED_ON_TIME'
            )
        )::int AS missing_closing,
        COUNT(*) FILTER (
          WHERE status IN ('PENDING', 'OPEN', 'PENDING_RESULT', 'PENDING_RESULTS')
            AND raw_data ? 'closing_odds'
            AND raw_data->>'closing_quality' IS DISTINCT FROM 'CAPTURED_ON_TIME'
        )::int AS closing_quality_review,
        COUNT(*) FILTER (
          WHERE status IN ('PENDING', 'OPEN', 'PENDING_RESULT', 'PENDING_RESULTS')
            AND NOT (raw_data ? 'home_score')
        )::int AS missing_result,
        COUNT(*) FILTER (
          WHERE status IN ('PENDING', 'OPEN', 'PENDING_RESULT', 'PENDING_RESULTS')
            AND placed_at < NOW() - INTERVAL '48 hours'
        )::int AS stale_open
      FROM paper_trades
      WHERE league_type = 'football_shadow'
    `
  );

  const byLeague = await db.query(
    `
      SELECT league_slug AS league_id, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status IN ('PENDING', 'OPEN', 'PENDING_RESULT', 'PENDING_RESULTS'))::int AS open,
        COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED'))::int AS closed
      FROM paper_trades
      WHERE league_type = 'football_shadow'
      GROUP BY league_slug
      ORDER BY total DESC
    `
  );

  const byMarket = await db.query(
    `
      SELECT market_type AS market, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status IN ('PENDING', 'OPEN', 'PENDING_RESULT', 'PENDING_RESULTS'))::int AS open,
        COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED'))::int AS closed
      FROM paper_trades
      WHERE league_type = 'football_shadow'
      GROUP BY market_type
      ORDER BY total DESC
    `
  );

  const examples = await db.query(
    `
      SELECT id, match_id, league_slug AS league_id, home_team, away_team, market_type AS market,
        selection, status, market_odds, placed_at, raw_data
      FROM paper_trades
      WHERE league_type = 'football_shadow'
        AND status IN ('PENDING', 'OPEN', 'PENDING_RESULT', 'PENDING_RESULTS', 'PENDING_CLOSING')
      ORDER BY placed_at ASC
      LIMIT 25
    `
  );

  const row = summary.rows[0] ?? {};
  const ready = Number(row.finished_ready_for_settle ?? 0);
  const missingClosing = Number(row.missing_closing ?? 0);
  const missingResult = Number(row.missing_result ?? 0);
  const recommendation = ready > 0
    ? "Listo para settlement: ya hay closing valido y resultado."
    : missingClosing > 0
      ? "Capturar closing valido primero."
      : missingResult > 0
        ? "Cargar resultado final verificado."
        : "No hay pendientes liquidables.";

  return {
    system_status: "FOOTBALL_PENDING_SETTLEMENT_MONITOR",
    shadow_paper_only: true,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    real_candidate_count: 0,
    ...row,
    ready_for_settlement: ready,
    missing_closing_strict: missingClosing,
    by_league: byLeague.rows,
    by_market: byMarket.rows,
    examples: examples.rows,
    recommendation
  };
}
