type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export async function getFootballFeedQualityReport(db: Queryable) {
  const summary = await db.query(
    `
      SELECT
        COUNT(*)::int AS total_signals,
        COUNT(*) FILTER (WHERE raw_data->>'line_freshness' = 'FRESH_LINE')::int AS fresh_line,
        COUNT(*) FILTER (WHERE raw_data->>'line_freshness' = 'ACCEPTABLE_LINE')::int AS acceptable_line,
        COUNT(*) FILTER (WHERE raw_data->>'line_freshness' = 'STALE_LINE')::int AS stale_line,
        COUNT(*) FILTER (WHERE raw_data->>'line_freshness' = 'POST_KICKOFF_REJECTED')::int AS post_kickoff_rejected,
        COUNT(*) FILTER (WHERE raw_data->>'kickoff_trusted' = 'true')::int AS kickoff_trusted,
        COUNT(*) FILTER (WHERE raw_data->>'kickoff_trusted' = 'false' OR raw_data->>'validation_status' = 'KICKOFF_UNTRUSTED')::int AS kickoff_untrusted,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(raw_data->>'source_consensus', '')) LIKE '%onefootball%')::int AS onefootball_consensus,
        COUNT(*) FILTER (WHERE market_type = 'btts' AND COALESCE(raw_data->>'manual_review', 'false') <> 'true')::int AS btts_requires_manual_review,
        ROUND(AVG(NULLIF(raw_data->>'line_age_to_kickoff_minutes', '')::numeric), 2) AS avg_line_age_to_kickoff_minutes
      FROM paper_trades
      WHERE league_type = 'football_shadow'
    `
  );

  const byLeague = await db.query(
    `
      SELECT league_slug AS league_id, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE raw_data->>'line_freshness' = 'FRESH_LINE')::int AS fresh_line,
        COUNT(*) FILTER (WHERE raw_data->>'line_freshness' = 'ACCEPTABLE_LINE')::int AS acceptable_line,
        COUNT(*) FILTER (WHERE raw_data->>'line_freshness' = 'STALE_LINE')::int AS stale_line,
        COUNT(*) FILTER (WHERE raw_data->>'kickoff_trusted' = 'true')::int AS kickoff_trusted,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(raw_data->>'source_consensus', '')) LIKE '%onefootball%')::int AS onefootball_consensus,
        ROUND(AVG(NULLIF(raw_data->>'line_age_to_kickoff_minutes', '')::numeric), 2) AS avg_line_age_to_kickoff_minutes
      FROM paper_trades
      WHERE league_type = 'football_shadow'
      GROUP BY league_slug
      ORDER BY total DESC
    `
  );

  const byMarket = await db.query(
    `
      SELECT market_type AS market, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE raw_data->>'line_freshness' = 'FRESH_LINE')::int AS fresh_line,
        COUNT(*) FILTER (WHERE raw_data->>'line_freshness' = 'ACCEPTABLE_LINE')::int AS acceptable_line,
        COUNT(*) FILTER (WHERE raw_data->>'line_freshness' = 'STALE_LINE')::int AS stale_line,
        COUNT(*) FILTER (WHERE raw_data->>'kickoff_trusted' = 'true')::int AS kickoff_trusted,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(raw_data->>'source_consensus', '')) LIKE '%onefootball%')::int AS onefootball_consensus
      FROM paper_trades
      WHERE league_type = 'football_shadow'
      GROUP BY market_type
      ORDER BY total DESC
    `
  );

  const byProvider = await db.query(
    `
      SELECT odds_source AS provider, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE raw_data->>'line_freshness' = 'FRESH_LINE')::int AS fresh_line,
        COUNT(*) FILTER (WHERE raw_data->>'line_freshness' = 'ACCEPTABLE_LINE')::int AS acceptable_line,
        COUNT(*) FILTER (WHERE raw_data->>'line_freshness' = 'STALE_LINE')::int AS stale_line,
        COUNT(*) FILTER (WHERE raw_data->>'kickoff_trusted' = 'true')::int AS kickoff_trusted,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(raw_data->>'source_consensus', '')) LIKE '%onefootball%')::int AS onefootball_consensus
      FROM paper_trades
      WHERE league_type = 'football_shadow'
      GROUP BY odds_source
      ORDER BY total DESC
    `
  );

  return {
    system_status: "FOOTBALL_FEED_QUALITY_REPORT",
    shadow_paper_only: true,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    real_candidate_count: 0,
    inserted: summary.rows[0]?.total_signals ?? 0,
    would_insert: 0,
    skipped: 0,
    duplicates: 0,
    blocked: 0,
    missing_kickoff: 0,
    missing_odds_timestamp: 0,
    invalid_kickoff: 0,
    invalid_odds_timestamp: 0,
    odds_timestamp_after_kickoff: summary.rows[0]?.post_kickoff_rejected ?? 0,
    ...summary.rows[0],
    by_league: byLeague.rows,
    by_market: byMarket.rows,
    by_provider: byProvider.rows,
    note: "Rejected dry-run/apply attempts are intentionally not persisted; this report summarizes accepted football_shadow records and stored raw_data quality fields."
  };
}
