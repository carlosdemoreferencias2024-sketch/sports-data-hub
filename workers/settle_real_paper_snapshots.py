import argparse
import json
import os
from datetime import UTC, datetime
from decimal import Decimal

import psycopg

from market_integrity_policy import (
    validate_clean_sample_eligibility,
    validate_closing_snapshot,
    validate_entry_snapshot,
    validate_settlement_eligibility,
)
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


def _result_source_verified(raw_data) -> bool:
    if not isinstance(raw_data, dict):
        return False
    values = [
        raw_data.get("source"),
        raw_data.get("source_name"),
        raw_data.get("source_match_id"),
        raw_data.get("provider_name"),
    ]
    source = " ".join(str(value or "").lower() for value in values)
    return any(token in source for token in ("mlb_stats", "mlb.com", "mlb_official", "espn-mlb", "manual_verified"))


def _mark_blocked(conn, snapshot_id, status: str, reasons: list[str], dry_run: bool) -> None:
    if dry_run:
        return
    conn.execute(
        """
        UPDATE real_paper_snapshots
        SET status = 'PENDING_CLOSING',
            raw_data = COALESCE(raw_data, '{}'::jsonb) || jsonb_build_object(
              'clean_chain_version', 'v2',
              'settlement_status', %s,
              'settlement_block_reasons', %s::jsonb,
              'clv_valid', false,
              'clean_v2_eligible', false,
              'audit_only', true
            ),
            updated_at = NOW()
        WHERE id = %s;
        """,
        (status, json.dumps(reasons), snapshot_id),
    )


def _closing_context_snapshot(raw_data, closing_odds, clv, result: str) -> dict:
    source = raw_data if isinstance(raw_data, dict) else {}
    feature_set = source.get("feature_set") if isinstance(source.get("feature_set"), dict) else {}
    return {
        "snapshot_type": "immutable_closing_context",
        "captured_at": datetime.now(UTC).isoformat(),
        "result": result,
        "closing_odds": round(_float(closing_odds), 4),
        "clv": round(float(clv), 6),
        "pitchers_at_close": {
            "home_pitcher_id": feature_set.get("home_pitcher_id"),
            "away_pitcher_id": feature_set.get("away_pitcher_id"),
            "home_pitcher_status": feature_set.get("home_pitcher_status"),
            "away_pitcher_status": feature_set.get("away_pitcher_status"),
            "pitcher_team_mapping_valid": feature_set.get("pitcher_team_mapping_valid"),
        },
        "lineup_status_at_close": feature_set.get("lineup_status"),
        "batting_order_complete_at_close": feature_set.get("batting_order_complete"),
        "bullpen_fatigue_at_close": {
            "home": feature_set.get("home_bullpen_fatigue_score"),
            "away": feature_set.get("away_bullpen_fatigue_score"),
            "home_context_fresh": feature_set.get("home_bullpen_context_fresh"),
            "away_context_fresh": feature_set.get("away_bullpen_context_fresh"),
        },
        "rest_context_at_close": {
            "home_rest_days": feature_set.get("home_rest_days"),
            "away_rest_days": feature_set.get("away_rest_days"),
            "travel_rest_context_complete": feature_set.get("travel_rest_context_complete"),
            "doubleheader_status": feature_set.get("doubleheader_status"),
        },
        "feature_completeness": feature_set.get("feature_completeness"),
        "missing_context_at_close": feature_set.get("missing_context", []),
        "decision_state_at_close": source.get("decision_status") or source.get("final_chain_status") or source.get("status"),
        "scheduled_start": feature_set.get("scheduled_start"),
        "provider_observed_at": feature_set.get("provider_observed_at"),
        "minutes_before_start": feature_set.get("minutes_before_start"),
        "post_kickoff_observation": feature_set.get("post_kickoff_observation"),
        "audit_only_context": feature_set.get("audit_only_context"),
    }


def settle_pending(limit: int, dry_run: bool, require_closing: bool = True) -> dict[str, int]:
    counts = {"checked": 0, "settled": 0, "pending_results": 0, "unsupported": 0, "missing_closing": 0, "invalid_entry": 0, "unverified_result": 0}
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
              COALESCE(finished_match.match_date, m.match_date) AS official_kickoff,
              COALESCE(finished_match.raw_data, m.raw_data) AS result_raw_data,
              COALESCE(finished_match.status::text, m.status::text) AS result_status,
              rps.raw_data,
              CASE WHEN finished_match.id IS NOT NULL AND finished_match.id <> m.id THEN TRUE ELSE FALSE END AS logical_fallback
            FROM (
              SELECT rps.*, mk.provider_name
              FROM real_paper_snapshots rps
              JOIN market_quotes mk ON mk.id = rps.market_quote_id
            ) rps
            JOIN v_valid_matches m ON m.id = rps.match_id
            JOIN match_competitors trade_home
              ON trade_home.match_id = m.id
             AND trade_home.home_away = 'home'
            JOIN match_competitors trade_away
              ON trade_away.match_id = m.id
             AND trade_away.home_away = 'away'
            LEFT JOIN LATERAL (
              SELECT fm.id, fm.home_score, fm.away_score, fm.match_date, fm.raw_data, fm.status
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
                official_kickoff,
                result_raw_data,
                result_status,
                raw_data,
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

            entry_row = conn.execute(
                """
                SELECT captured_at, source_name, raw_data->>'evidence_id',
                       raw_data->>'screenshot_sha256',
                       COALESCE(raw_data->>'snapshot_type', snapshot_role),
                       raw_data->>'stale_status',
                       COALESCE((raw_data->>'safe_for_entry')::boolean, false),
                       COALESCE((raw_data->>'canonical_match')::boolean, false),
                       COALESCE((raw_data->>'duplicate')::boolean, false), id
                FROM odds_snapshots
                WHERE market_quote_id = (
                    SELECT market_quote_id FROM real_paper_snapshots WHERE id = %s
                )
                  AND selection = %s
                ORDER BY captured_at DESC
                LIMIT 1;
                """,
                (snapshot_id, pick),
            ).fetchone()
            entry_integrity = validate_entry_snapshot({
                "captured_at": entry_row[0] if entry_row else entry_timestamp,
                "kickoff": official_kickoff,
                "source_name": entry_row[1] if entry_row else provider_name,
                "evidence_id": entry_row[2] if entry_row else None,
                "screenshot_sha256": entry_row[3] if entry_row else None,
                "snapshot_type": entry_row[4] if entry_row else None,
                "stale_status": entry_row[5] if entry_row else None,
                "safe_for_entry": entry_row[6] if entry_row else False,
                "canonical_match": entry_row[7] if entry_row else False,
                "duplicate": entry_row[8] if entry_row else False,
            })
            if not entry_integrity["eligible"]:
                counts["invalid_entry"] += 1
                _mark_blocked(conn, snapshot_id, "BLOCKED_INVALID_ENTRY", entry_integrity["reasons"], dry_run)
                continue

            closing_row = conn.execute(
                """
                SELECT odds, captured_at, source_name, raw_data->>'evidence_id',
                       raw_data->>'screenshot_sha256',
                       COALESCE(raw_data->>'snapshot_type', snapshot_role),
                       COALESCE((raw_data->>'safe_for_closing')::boolean, false),
                       COALESCE((raw_data->>'canonical_match')::boolean, false),
                       COALESCE((raw_data->>'duplicate')::boolean, false), id,
                       COALESCE(bookmaker, raw_data->>'bookmaker')
                FROM odds_snapshots
                WHERE match_id = %s
                  AND market_type = %s
                  AND line IS NOT DISTINCT FROM %s::numeric
                  AND selection = %s
                  AND COALESCE(raw_data->>'snapshot_type', snapshot_role) = 'closing'
                ORDER BY captured_at DESC
                LIMIT 1;
                """,
                (match_id, market_type, line, pick),
            ).fetchone()
            closing_integrity = validate_closing_snapshot({
                "captured_at": closing_row[1] if closing_row else None,
                "kickoff": official_kickoff,
                "source_name": closing_row[2] if closing_row else None,
                "evidence_id": closing_row[3] if closing_row else None,
                "screenshot_sha256": closing_row[4] if closing_row else None,
                "snapshot_type": closing_row[5] if closing_row else None,
                "safe_for_closing": closing_row[6] if closing_row else False,
                "canonical_match": closing_row[7] if closing_row else False,
                "duplicate": closing_row[8] if closing_row else False,
            })
            if not closing_integrity["eligible"]:
                counts["missing_closing"] += 1
                _mark_blocked(conn, snapshot_id, "BLOCKED_MISSING_VALID_CLOSING", closing_integrity["reasons"], dry_run)
                print(f"[REAL-PAPER-SETTLE] snapshot={snapshot_id} blocked closing={closing_integrity['reasons']}")
                continue

            result_verified = str(result_status) == "finished" and _result_source_verified(result_raw_data)
            settlement_integrity = validate_settlement_eligibility(
                entry_integrity,
                closing_integrity,
                result_final=str(result_status) == "finished",
                result_source_verified=result_verified,
            )
            if not settlement_integrity["eligible"]:
                counts["unverified_result"] += 1
                _mark_blocked(conn, snapshot_id, "BLOCKED_UNVERIFIED_RESULT", settlement_integrity["reasons"], dry_run)
                continue

            closing_odds = closing_row[0]
            closing_source = "verified_closing_odds_snapshot"

            clv = (_float(entry_odds) - _float(closing_odds)) / _float(closing_odds)
            stake = BANKROLL_BASE * _float(stake_fraction)
            profit = stake * (_float(entry_odds) - 1.0) if result == "WIN" else -stake if result == "LOSS" else 0.0
            counts["settled"] += 1
            context_snapshot = _closing_context_snapshot(raw_data, closing_odds, clv, result)
            clean_integrity = validate_clean_sample_eligibility(
                settlement_integrity, settlement_final=True, clv_valid=True
            )
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
                          'closing_odds_source', %s::text,
                          'closing_context_snapshot', %s::jsonb,
                          'entry_snapshot_id', %s,
                          'closing_snapshot_id', %s,
                          'closing_evidence_id', %s,
                          'closing_screenshot_sha256', %s,
                          'closing_quality', %s,
                          'result_source_verified', true,
                          'settlement_final', true,
                          'clv_valid', true,
                          'clean_v2_eligible', %s,
                          'clean_chain_version', 'v2',
                          'audit_only', false
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
                        json.dumps(context_snapshot, ensure_ascii=False),
                        str(entry_row[9]),
                        str(closing_row[9]),
                        closing_row[3],
                        closing_row[4],
                        closing_integrity["closing_quality"],
                        bool(clean_integrity["eligible"]),
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
        default=True,
        help="Compatibilidad: closing verificado es obligatorio en Clean Chain v2.",
    )
    args = parser.parse_args()
    counts = settle_pending(args.limit, args.dry_run, args.require_closing)
    print(
        "[+] Real Paper settlement finalizado "
        f"checked={counts['checked']} settled={counts['settled']} "
        f"pending_results={counts['pending_results']} unsupported={counts['unsupported']} "
        f"missing_closing={counts['missing_closing']} invalid_entry={counts['invalid_entry']} "
        f"unverified_result={counts['unverified_result']} dry_run={args.dry_run}"
    )


if __name__ == "__main__":
    main()
