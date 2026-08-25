import argparse
import os
from decimal import Decimal

import psycopg


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)
BANKROLL_BASE = float(os.getenv("PAPER_BANKROLL_BASE", "10000"))


def _float(value) -> float:
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def settle_selection(market_type: str, selection: str, home_score: int, away_score: int, line: float | None = None) -> str | None:
    draw = home_score == away_score
    home_won = home_score > away_score
    away_won = away_score > home_score
    total_score = home_score + away_score

    if market_type in {"draw_no_bet", "moneyline_2way"} and draw:
        return "PUSH"
    if market_type in {"total_goals_2_5", "total_runs", "total_points"}:
        if line is None:
            return None
        if total_score == line:
            return "PUSH"
        won = (selection == "over" and total_score > line) or (selection == "under" and total_score < line)
        return "WIN" if won else "LOSS"
    if market_type == "btts":
        both_scored = home_score > 0 and away_score > 0
        won = (selection == "yes" and both_scored) or (selection == "no" and not both_scored)
        return "WIN" if won else "LOSS"
    if market_type in {"run_line", "spread"}:
        if line is None:
            return None
        adjusted_margin = (home_score - away_score) + line if selection == "home" else (away_score - home_score) + line
        if adjusted_margin == 0:
            return "PUSH"
        return "WIN" if adjusted_margin > 0 else "LOSS"
    if market_type not in {"moneyline_2way", "moneyline_3way", "draw_no_bet"}:
        return None

    won = (
        (selection == "home" and home_won)
        or (selection == "away" and away_won)
        or (selection == "draw" and draw)
    )
    return "WIN" if won else "LOSS"


def settle_pending(limit: int, dry_run: bool) -> dict[str, int]:
    counts = {"checked": 0, "settled": 0, "pending_results": 0, "unsupported": 0}
    with psycopg.connect(DATABASE_URL) as conn:
        rows = conn.execute(
            """
            SELECT
              pt.id,
              pt.market_type,
              pt.selection,
              pt.bankroll_allocation,
              pt.market_odds,
              pt.line,
              COALESCE(finished_match.home_score, m.home_score) AS home_score,
              COALESCE(finished_match.away_score, m.away_score) AS away_score,
              COALESCE(finished_match.id, m.id) AS settlement_match_id,
              CASE WHEN finished_match.id IS NOT NULL AND finished_match.id <> m.id THEN TRUE ELSE FALSE END AS logical_fallback
            FROM paper_trades pt
            JOIN v_valid_matches m ON m.id = pt.match_id
            JOIN match_competitors trade_home
              ON trade_home.match_id = m.id
             AND trade_home.home_away = 'home'
            JOIN match_competitors trade_away
              ON trade_away.match_id = m.id
             AND trade_away.home_away = 'away'
            LEFT JOIN LATERAL (
              SELECT fm.id, fm.home_score, fm.away_score
              FROM v_valid_matches fm
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
                AND ABS(EXTRACT(EPOCH FROM (fm.match_date - m.match_date))) <= 60 * 60 * 24 * 14
              ORDER BY
                CASE WHEN fm.id = m.id THEN 0 ELSE 1 END,
                fm.match_date DESC,
                fm.updated_at DESC
              LIMIT 1
            ) finished_match ON TRUE
            WHERE pt.status IN ('PENDING', 'PENDING_RESULTS')
              AND (m.status = 'finished' OR finished_match.id IS NOT NULL)
            ORDER BY pt.created_at ASC
            LIMIT %s;
            """,
            (limit,),
        ).fetchall()

        for row in rows:
            counts["checked"] += 1
            trade_id, market_type, selection, allocation, odds, line, home_score, away_score, settlement_match_id, logical_fallback = row
            if home_score is None or away_score is None:
                counts["pending_results"] += 1
                if not dry_run:
                    conn.execute("UPDATE paper_trades SET status = 'PENDING_RESULTS' WHERE id = %s", (trade_id,))
                continue

            result = settle_selection(str(market_type), str(selection), int(home_score), int(away_score), _float(line) if line is not None else None)
            if result is None:
                counts["unsupported"] += 1
                if not dry_run:
                    conn.execute("UPDATE paper_trades SET status = 'PENDING_RESULTS' WHERE id = %s", (trade_id,))
                continue

            stake = BANKROLL_BASE * _float(allocation)
            profit = stake * (_float(odds) - 1.0) if result == "WIN" else -stake if result == "LOSS" else 0.0
            counts["settled"] += 1
            fallback_note = f" fallback_match={settlement_match_id}" if logical_fallback else ""
            print(f"[SETTLE] trade={trade_id} result={result} profit={profit:.2f}{fallback_note}")
            if not dry_run:
                conn.execute(
                    """
                    UPDATE paper_trades
                    SET status = %s,
                        net_profit = %s,
                        settled_at = NOW(),
                        raw_data = COALESCE(raw_data, '{}'::jsonb) || jsonb_build_object(
                          'settlement_match_id', %s,
                          'settlement_logical_fallback', %s
                        )
                    WHERE id = %s;
                    """,
                    (result, round(profit, 2), settlement_match_id, bool(logical_fallback), trade_id),
                )

        if dry_run:
            conn.rollback()
        else:
            conn.commit()
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description="Cierra paper trades pendientes con resultados finished.")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    counts = settle_pending(args.limit, args.dry_run)
    print(
        "[+] Settlement finalizado "
        f"checked={counts['checked']} settled={counts['settled']} "
        f"pending_results={counts['pending_results']} unsupported={counts['unsupported']} dry_run={args.dry_run}"
    )


if __name__ == "__main__":
    main()
