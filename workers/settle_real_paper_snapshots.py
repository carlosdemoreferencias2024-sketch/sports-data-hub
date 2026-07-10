import argparse
import os
from decimal import Decimal

import psycopg

from settle_paper_trades import settle_selection


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)
BANKROLL_BASE = float(os.getenv("PAPER_BANKROLL_BASE", "10000"))


def _float(value) -> float:
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def _pick_column(selection: str) -> str | None:
    if selection == "home":
        return "home_odds"
    if selection == "away":
        return "away_odds"
    if selection == "draw":
        return "draw_odds"
    return None


def settle_pending(limit: int, dry_run: bool, require_closing: bool) -> dict[str, int]:
    counts = {"checked": 0, "settled": 0, "pending_results": 0, "unsupported": 0, "missing_closing": 0}
    with psycopg.connect(DATABASE_URL) as conn:
        rows = conn.execute(
            """
            SELECT
              rps.id,
              rps.market_type,
              rps.pick,
              rps.stake_fraction,
              rps.entry_odds,
              rps.entry_timestamp,
              rps.line,
              rps.provider_name,
              rps.bookmaker,
              rps.match_id,
              COALESCE(finished_match.home_score, m.home_score) AS home_score,
              COALESCE(finished_match.away_score, m.away_score) AS away_score,
              COALESCE(finished_match.id, m.id) AS settlement_match_id,
              CASE WHEN finished_match.id IS NOT NULL AND finished_match.id <> m.id THEN TRUE ELSE FALSE END AS logical_fallback
            FROM (
              SELECT rps.*, mk.provider_name
              FROM real_paper_snapshots rps
              JOIN market_quotes mk ON mk.id = rps.market_quote_id
            ) rps
            JOIN matches m ON m.id = rps.match_id
            JOIN match_competitors trade_home
              ON trade_home.match_id = m.id
             AND trade_home.home_away = 'home'
            JOIN match_competitors trade_away
              ON trade_away.match_id = m.id
             AND trade_away.home_away = 'away'
            LEFT JOIN LATERAL (
              SELECT fm.id, fm.home_score, fm.away_score
              FROM matches fm
              JOIN match_competitors final_home
                ON final_home.match_id = fm.id
               AND final_home.home_away = 'home'
               AND final_home.team_id = trade_home.team_id
              JOIN match_competitors final_away
                ON final_away.match_id = fm.id
               AND final_away.home_away = 'away'
               AND final_away.team_id = trade_away.team_id
              WHERE fm.league_id = m.league_id
                AND fm.status = 'finished'
                AND fm.home_score IS NOT NULL
                AND fm.away_score IS NOT NULL
                AND fm.match_date::date = m.match_date::date
              ORDER BY
                CASE WHEN fm.id = m.id THEN 0 ELSE 1 END,
                fm.match_date DESC,
                fm.updated_at DESC
              LIMIT 1
            ) finished_match ON TRUE
            WHERE rps.status IN ('OPEN', 'PENDING_RESULTS', 'PENDING_CLOSING')
              AND (m.status = 'finished' OR finished_match.id IS NOT NULL)
            ORDER BY rps.entry_timestamp ASC
            LIMIT %s;
            """,
            (limit,),
        ).fetchall()

        for row in rows:
            counts["checked"] += 1
            (
                snapshot_id,
                market_type,
                pick,
                stake_fraction,
                entry_odds,
                entry_timestamp,
                line,
                provider_name,
                bookmaker,
                match_id,
                home_score,
                away_score,
                settlement_match_id,
                logical_fallback,
            ) = row

            if home_score is None or away_score is None:
                counts["pending_results"] += 1
                if not dry_run:
                    conn.execute("UPDATE real_paper_snapshots SET status = 'PENDING_RESULTS' WHERE id = %s", (snapshot_id,))
                continue

            result = settle_selection(
                str(market_type),
                str(pick),
                int(home_score),
                int(away_score),
                _float(line) if line is not None else None,
            )
            if result is None:
                counts["unsupported"] += 1
                if not dry_run:
                    conn.execute("UPDATE real_paper_snapshots SET status = 'PENDING_RESULTS' WHERE id = %s", (snapshot_id,))
                continue

            odds_column = _pick_column(str(pick))
            closing_odds = None
            closing_source = "latest_market_quote_after_entry_same_provider_bookmaker"
            if odds_column is not None:
                closing_row = conn.execute(
                    f"""
                    SELECT {odds_column}
                    FROM market_quotes
                    WHERE match_id = %s
                      AND provider_name = %s
                      AND market_type = %s
                      AND line IS NOT DISTINCT FROM %s::numeric
                      AND COALESCE(raw_data->>'bookmaker', '') = %s
                      AND {odds_column} IS NOT NULL
                      AND captured_at > %s
                    ORDER BY captured_at DESC
                    LIMIT 1;
                    """,
                    (match_id, provider_name, market_type, line, bookmaker, entry_timestamp),
                ).fetchone()
                closing_odds = closing_row[0] if closing_row else None
                if closing_odds is None and str(provider_name) == "sportsdataio_trial":
                    # SportsDataIO trial masks sportsbook ids, and the selected book can
                    # drift between entry and closing snapshots. For CLV tracking, accept
                    # the latest same-provider price instead of leaving finished games stuck.
                    closing_row = conn.execute(
                        f"""
                        SELECT {odds_column}
                        FROM market_quotes
                        WHERE match_id = %s
                          AND provider_name = %s
                          AND market_type = %s
                          AND line IS NOT DISTINCT FROM %s::numeric
                          AND {odds_column} IS NOT NULL
                          AND captured_at > %s
                        ORDER BY captured_at DESC
                        LIMIT 1;
                        """,
                        (match_id, provider_name, market_type, line, entry_timestamp),
                    ).fetchone()
                    closing_odds = closing_row[0] if closing_row else None
                    if closing_odds is not None:
                        closing_source = "latest_market_quote_after_entry_same_provider_sportsdataio_book_fallback"

            if closing_odds is None:
                counts["missing_closing"] += 1
                if require_closing:
                    if not dry_run:
                        conn.execute(
                            """
                            UPDATE real_paper_snapshots
                            SET status = 'PENDING_CLOSING',
                                raw_data = COALESCE(raw_data, '{}'::jsonb) || jsonb_build_object(
                                  'closing_odds_source', 'missing_quote_after_entry',
                                  'closing_required', true
                                )
                            WHERE id = %s;
                            """,
                            (snapshot_id,),
                        )
                    print(
                        f"[REAL-PAPER-SETTLE] snapshot={snapshot_id} missing_closing "
                        f"entry={_float(entry_odds):.4f} require_closing=True"
                    )
                    continue
                closing_odds = entry_odds

            clv = (_float(entry_odds) - _float(closing_odds)) / _float(closing_odds)
            stake = BANKROLL_BASE * _float(stake_fraction)
            profit = stake * (_float(entry_odds) - 1.0) if result == "WIN" else -stake if result == "LOSS" else 0.0
            counts["settled"] += 1
            fallback_note = f" fallback_match={settlement_match_id}" if logical_fallback else ""
            print(
                f"[REAL-PAPER-SETTLE] snapshot={snapshot_id} result={result} "
                f"profit={profit:.2f} entry={_float(entry_odds):.4f} close={_float(closing_odds):.4f} "
                f"clv={clv:.4%} close_source={closing_source}{fallback_note}"
            )

            if not dry_run:
                conn.execute(
                    """
                    UPDATE real_paper_snapshots
                    SET status = %s,
                        result = %s,
                        profit_loss = %s,
                        closing_odds = %s,
                        clv = %s,
                        raw_data = COALESCE(raw_data, '{}'::jsonb) || jsonb_build_object(
                          'settlement_match_id', %s,
                          'settlement_logical_fallback', %s,
                          'settlement_home_score', %s,
                          'settlement_away_score', %s,
                          'closing_odds_source', %s::text
                        )
                    WHERE id = %s;
                    """,
                    (
                        result,
                        result,
                        round(profit, 4),
                        round(_float(closing_odds), 4),
                        round(clv, 6),
                        settlement_match_id,
                        bool(logical_fallback),
                        int(home_score),
                        int(away_score),
                        closing_source,
                        snapshot_id,
                    ),
                )

        if dry_run:
            conn.rollback()
        else:
            conn.commit()
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description="Cierra real_paper_snapshots OPEN con resultados finished y calcula CLV.")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--require-closing",
        action="store_true",
        help="No liquida si no existe una market_quote capturada despues de entry_timestamp.",
    )
    args = parser.parse_args()
    counts = settle_pending(args.limit, args.dry_run, args.require_closing)
    print(
        "[+] Real Paper settlement finalizado "
        f"checked={counts['checked']} settled={counts['settled']} "
        f"pending_results={counts['pending_results']} unsupported={counts['unsupported']} "
        f"missing_closing={counts['missing_closing']} dry_run={args.dry_run}"
    )


if __name__ == "__main__":
    main()
