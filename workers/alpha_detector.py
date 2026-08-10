import argparse
import json
import os
from datetime import UTC, datetime
from decimal import Decimal

import psycopg
from market_integrity_policy import validate_entry_snapshot
from pre_bet_validator import validate_market_quote, validate_mlb_fixture


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)


def _float(value) -> float | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def _selection_rows(row: dict) -> list[dict]:
    selection_map = row.get("selection_map") or {}
    disabled_selections = set(row.get("disabled_selections") or [])
    market_selection_odds = row.get("selection_odds") or {}
    selections = [
        (selection_map.get("home", "home"), row["home_probability"], row["home_fair_odds"], market_selection_odds.get(selection_map.get("home", "home"), row["home_odds"])),
        (selection_map.get("away", "away"), row["away_probability"], row["away_fair_odds"], market_selection_odds.get(selection_map.get("away", "away"), row["away_odds"])),
    ]
    if row.get("draw_probability") is not None or row.get("draw_odds") is not None:
        selections.append((selection_map.get("draw", "draw"), row.get("draw_probability"), row.get("draw_fair_odds"), market_selection_odds.get(selection_map.get("draw", "draw"), row.get("draw_odds"))))

    out = []
    for name, probability, fair_odds, market_odds in selections:
        if name in disabled_selections:
            continue
        probability_f = _float(probability)
        fair_odds_f = _float(fair_odds)
        market_odds_f = _float(market_odds)
        if probability_f is None or fair_odds_f is None or market_odds_f is None:
            continue
        expected_value = (probability_f * market_odds_f) - 1.0
        out.append(
            {
                "selection": name,
                "probability": probability_f,
                "fair_odds": fair_odds_f,
                "market_odds": market_odds_f,
                "expected_value": expected_value,
            }
        )
    return out


def _bankroll_fraction(selection: dict, stake_mode: str, flat_fraction: float, kelly_fraction: float, max_fraction: float) -> float:
    if stake_mode == "flat":
        return min(max(flat_fraction, 0.0), max_fraction)

    probability = float(selection["probability"])
    odds = float(selection["market_odds"])
    edge = (probability * odds) - 1.0
    if odds <= 1 or edge <= 0:
        return 0.0

    # Kelly decimal odds: f* = (bp - q) / b, where b = odds - 1.
    full_kelly = edge / (odds - 1.0)
    return min(max(full_kelly * kelly_fraction, 0.0), max_fraction)


def _is_manual_or_shadow_provider(provider_name: str | None) -> bool:
    provider = str(provider_name or "").lower()
    return "manual" in provider or "shadow" in provider or "simulated" in provider


def _parse_utc(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        raw = str(value).strip()
        if not raw:
            return None
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _entry_after_first_pitch(row: dict) -> bool:
    kickoff = _parse_utc(row.get("official_kickoff"))
    captured_at = _parse_utc(row.get("captured_at"))
    if not kickoff or not captured_at:
        return False
    return captured_at >= kickoff


def _is_real_paper_candidate(row: dict, selection: dict) -> bool:
    if os.getenv("ENABLE_REAL_PAPER", "true").lower() == "false":
        return False
    if os.getenv("ENABLE_REAL_MONEYLINE", "true").lower() == "false":
        return False
    if row.get("quote_processed") is not True:
        return False
    if str(row.get("status") or "").strip() != "scheduled":
        return False
    if not str(row.get("bookmaker") or "").strip():
        return False
    if row["sport_slug"] != "baseball" or row["league_slug"] != "mlb":
        return False
    if row["market_type"] != "moneyline_2way":
        return False
    entry_integrity = validate_entry_snapshot(
        {
            "captured_at": row.get("captured_at"),
            "kickoff": row.get("official_kickoff"),
            "source_name": row.get("source_name") or row.get("provider_name"),
            "evidence_id": row.get("evidence_id"),
            "screenshot_sha256": row.get("screenshot_sha256"),
            "snapshot_type": row.get("snapshot_type"),
            "stale_status": row.get("stale_status"),
            "safe_for_entry": row.get("safe_for_entry"),
            "canonical_match": row.get("canonical_match"),
            "duplicate": row.get("duplicate"),
        }
    )
    if not entry_integrity["eligible"]:
        return False
    odds = float(selection["market_odds"])
    probability = float(selection["probability"])
    return 1.3 < odds < 4.5 and probability >= 0.52 and selection["expected_value"] >= 0.03


def _create_real_paper_snapshot(conn, row: dict, selection: dict, stake_fraction: float) -> bool:
    if not _is_real_paper_candidate(row, selection):
        return False

    implied_probability = 1.0 / float(selection["market_odds"])
    result = conn.execute(
        """
        INSERT INTO real_paper_snapshots (
          event_id, match_id, model_quote_id, market_quote_id,
          sport_slug, league_slug, model_name, market_type, line, pick,
          bookmaker, entry_odds, entry_timestamp, model_probability,
          implied_probability, expected_value, stake_fraction, raw_data
        )
        VALUES (
          %s, %s, %s, %s,
          %s, %s, %s, %s, %s, %s,
          %s, %s, %s, %s,
          %s, %s, %s, %s::jsonb
        )
        ON CONFLICT (
          match_id,
          model_name,
          market_type,
          COALESCE(line, -9999::numeric),
          pick
        )
        WHERE status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
          AND duplicate_of_id IS NULL
          AND COALESCE(data_state, 'FRESH') <> 'DUPLICATE'
        DO UPDATE SET
          market_quote_id = EXCLUDED.market_quote_id,
          model_quote_id = EXCLUDED.model_quote_id,
          data_state = 'FRESH',
          archived_at = NULL,
          archive_reason = NULL,
          last_refreshed_at = GREATEST(
            COALESCE(real_paper_snapshots.last_refreshed_at, real_paper_snapshots.entry_timestamp),
            EXCLUDED.entry_timestamp
          ),
          raw_data = real_paper_snapshots.raw_data || jsonb_build_object(
            'last_seen_market_quote_id', EXCLUDED.market_quote_id,
            'last_seen_model_quote_id', EXCLUDED.model_quote_id,
            'last_seen_entry_odds', EXCLUDED.entry_odds,
            'last_seen_model_probability', EXCLUDED.model_probability,
            'last_seen_expected_value', EXCLUDED.expected_value,
            'dedupe_guard', 'open_exposure_upsert_v1'
          ),
          updated_at = NOW()
        RETURNING id, (xmax = 0) AS inserted;
        """,
        (
            row["match_id"],
            row["match_id"],
            row["model_quote_id"],
            row["market_quote_id"],
            row["sport_slug"],
            row["league_slug"],
            row["model_name"],
            row["market_type"],
            row.get("line"),
            selection["selection"],
            row["bookmaker"],
            selection["market_odds"],
            row["captured_at"],
            selection["probability"],
            implied_probability,
            round(selection["expected_value"], 6),
            round(stake_fraction, 6),
            json.dumps(
                {
                    "source": "alpha_detector_real_paper_v1",
                    "home_team_name": row.get("home_team_name"),
                    "away_team_name": row.get("away_team_name"),
                    "flat_only": True,
                    "kelly_enabled": False,
                    "entry_integrity": "ENTRY_VALID",
                    "entry_snapshot_id": row.get("entry_snapshot_id"),
                    "entry_evidence_id": row.get("evidence_id"),
                    "entry_screenshot_sha256": row.get("screenshot_sha256"),
                    "entry_source_name": row.get("source_name") or row.get("provider_name"),
                    "canonical_match": True,
                    "duplicate_exposure": False,
                    "clean_chain_version": "v2",
                }
            ),
        ),
    )
    returned = result.fetchone()
    return bool(returned and returned.get("inserted"))


def _create_paper_trade(conn, row: dict, selection: dict, stake_fraction: float) -> bool:
    if stake_fraction <= 0:
        return False

    result = conn.execute(
        """
        INSERT INTO paper_trades (
          match_id, league_slug, league_type, home_team, away_team, pick_executed,
          market_type, selection, model_version, odds_source,
          model_probability, market_odds, expected_value, bankroll_allocation, line, raw_data
        )
        VALUES (
          %s, %s, %s, %s, %s, %s,
          %s, %s, %s, 'market_odds',
          %s, %s, %s, %s, %s, %s::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING id;
        """,
        (
            row["match_id"],
            row["league_slug"],
            "international" if row["league_slug"] in {"fifa-world-cup-2026", "uefa-champions-league"} else "domestic",
            row.get("home_team_name") or "HOME",
            row.get("away_team_name") or "AWAY",
            selection["selection"],
            row["market_type"],
            selection["selection"],
            row["model_name"],
            selection["probability"],
            selection["market_odds"],
            round(selection["expected_value"], 6),
            round(stake_fraction, 6),
            row.get("line"),
            json.dumps(
                {
                    "source": "alpha_detector_auto_paper_v1",
                    "provider_name": row["provider_name"],
                    "model_quote_id": str(row["model_quote_id"]),
                    "market_quote_id": str(row["market_quote_id"]),
                    "stake_fraction": round(stake_fraction, 6),
                }
            ),
        ),
    )
    return bool(result.rowcount)


def detect_alpha(
    model_name: str | None,
    min_ev: float,
    max_model_age_minutes: int,
    max_market_age_minutes: int,
    dry_run: bool,
    auto_paper: bool = False,
    stake_mode: str = "flat",
    flat_fraction: float = 0.01,
    kelly_fraction: float = 0.25,
    max_fraction: float = 0.02,
) -> tuple[int, int]:
    evaluated = 0
    inserted = 0
    paper_created = 0
    real_paper_created = 0
    with psycopg.connect(DATABASE_URL, row_factory=psycopg.rows.dict_row) as conn:
        params: list[object] = [max_model_age_minutes]
        model_filter = ""
        if model_name:
            params.append(model_name)
            model_filter = "AND mq.model_name = %s"
        params.append(max_market_age_minutes)
        params.append(max_market_age_minutes)

        rows = conn.execute(
            f"""
            WITH latest_model_quotes AS (
              SELECT DISTINCT ON (mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999))
                mq.*
              FROM model_quotes mq
              JOIN matches m ON m.id = mq.match_id
              WHERE m.status::text IN ('scheduled', 'live')
                AND mq.generated_at >= NOW() - (%s * INTERVAL '1 minute')
                {model_filter}
              ORDER BY mq.match_id, mq.model_name, mq.market_type, COALESCE(mq.line, -9999), mq.generated_at DESC
            ),
            snapshot_quote_sets AS (
              SELECT
                os.market_quote_id,
                os.match_id,
                os.provider_name,
                os.market_type,
                os.line,
                MAX(os.captured_at) AS captured_at,
                MIN(os.quality_score) AS min_quality_score,
                ARRAY_AGG(DISTINCT flag) FILTER (WHERE flag IS NOT NULL) AS quality_flags,
                MAX(COALESCE(NULLIF(os.bookmaker, ''), NULLIF(os.raw_data->>'bookmaker', ''), os.provider_name)) AS bookmaker,
                BOOL_OR(COALESCE((os.raw_data->>'processed')::boolean, false)) AS quote_processed,
                MAX(os.id::text) AS entry_snapshot_id,
                MAX(COALESCE(NULLIF(os.raw_data->>'source_name', ''), os.provider_name)) AS source_name,
                MAX(NULLIF(os.raw_data->>'evidence_id', '')) AS evidence_id,
                MAX(NULLIF(os.raw_data->>'screenshot_sha256', '')) AS screenshot_sha256,
                BOOL_OR(COALESCE((os.raw_data->>'safe_for_entry')::boolean, false)) AS safe_for_entry,
                BOOL_OR(COALESCE((os.raw_data->>'canonical_match')::boolean, false)) AS canonical_match,
                BOOL_OR(COALESCE((os.raw_data->>'duplicate')::boolean, false)) AS duplicate,
                MAX(COALESCE(NULLIF(os.raw_data->>'snapshot_type', ''), os.snapshot_role)) AS snapshot_type,
                MAX(COALESCE(NULLIF(os.raw_data->>'stale_status', ''), 'UNKNOWN')) AS stale_status,
                JSONB_OBJECT_AGG(os.selection, os.odds) AS selection_odds,
                MAX(os.odds) FILTER (WHERE os.selection IN ('home', 'over', 'yes')) AS home_odds,
                MAX(os.odds) FILTER (WHERE os.selection = 'draw') AS draw_odds,
                MAX(os.odds) FILTER (WHERE os.selection IN ('away', 'under', 'no')) AS away_odds
              FROM odds_snapshots os
              LEFT JOIN LATERAL unnest(os.quality_flags) AS flag ON TRUE
              WHERE os.market_quote_id IS NOT NULL
                AND os.captured_at >= NOW() - (%s * INTERVAL '1 minute')
                AND os.quality_score >= 80
                AND os.snapshot_role IN ('market', 'entry', 'live')
              GROUP BY os.market_quote_id, os.match_id, os.provider_name, os.market_type, os.line
            ),
            latest_snapshot_quotes AS (
              SELECT
                sqs.market_quote_id AS id,
                sqs.match_id,
                sqs.provider_name,
                sqs.market_type,
                sqs.line,
                sqs.home_odds,
                sqs.draw_odds,
                sqs.away_odds,
                sqs.captured_at,
                COALESCE(mk.raw_data, '{{}}'::jsonb)
                  || jsonb_build_object(
                    'bookmaker', sqs.bookmaker,
                    'processed', sqs.quote_processed,
                    'selection_odds', sqs.selection_odds,
                    'odds_snapshot_source', true,
                    'odds_snapshot_min_quality_score', sqs.min_quality_score,
                    'odds_snapshot_quality_flags', COALESCE(sqs.quality_flags, '{{}}'::text[])
                    , 'entry_snapshot_id', sqs.entry_snapshot_id
                    , 'source_name', sqs.source_name
                    , 'evidence_id', sqs.evidence_id
                    , 'screenshot_sha256', sqs.screenshot_sha256
                    , 'safe_for_entry', sqs.safe_for_entry
                    , 'canonical_match', sqs.canonical_match
                    , 'duplicate', sqs.duplicate
                    , 'snapshot_type', sqs.snapshot_type
                    , 'stale_status', sqs.stale_status
                  ) AS raw_data
              FROM snapshot_quote_sets sqs
              JOIN market_quotes mk ON mk.id = sqs.market_quote_id
            ),
            latest_manual_quotes AS (
              SELECT
                mk.id,
                mk.match_id,
                mk.provider_name,
                mk.market_type,
                mk.line,
                mk.home_odds,
                mk.draw_odds,
                mk.away_odds,
                mk.captured_at,
                mk.raw_data
              FROM market_quotes mk
              WHERE mk.captured_at >= NOW() - (%s * INTERVAL '1 minute')
                AND (
                  lower(mk.provider_name) LIKE '%%manual%%'
                  OR lower(mk.provider_name) LIKE '%%shadow%%'
                  OR lower(mk.provider_name) LIKE '%%simulated%%'
                )
            ),
            combined_market_quotes AS (
              SELECT * FROM latest_snapshot_quotes
              UNION ALL
              SELECT * FROM latest_manual_quotes
            ),
            latest_market_quotes AS (
              SELECT DISTINCT ON (mk.match_id, mk.market_type, COALESCE(mk.line, -9999))
                mk.*
              FROM combined_market_quotes mk
              ORDER BY mk.match_id, mk.market_type, COALESCE(mk.line, -9999), mk.captured_at DESC
            )
            SELECT
              mq.id AS model_quote_id,
              mk.id AS market_quote_id,
              mq.match_id,
              s.slug AS sport_slug,
              l.slug AS league_slug,
              mq.model_name,
              mk.provider_name,
              COALESCE(NULLIF(mk.raw_data->>'bookmaker', ''), mk.provider_name) AS bookmaker,
              COALESCE((mk.raw_data->>'processed')::boolean, false) AS quote_processed,
              mk.raw_data->>'entry_snapshot_id' AS entry_snapshot_id,
              COALESCE(NULLIF(mk.raw_data->>'source_name', ''), mk.provider_name) AS source_name,
              mk.raw_data->>'evidence_id' AS evidence_id,
              mk.raw_data->>'screenshot_sha256' AS screenshot_sha256,
              COALESCE((mk.raw_data->>'safe_for_entry')::boolean, false) AS safe_for_entry,
              COALESCE((mk.raw_data->>'canonical_match')::boolean, false) AS canonical_match,
              COALESCE((mk.raw_data->>'duplicate')::boolean, false) AS duplicate,
              mk.raw_data->>'snapshot_type' AS snapshot_type,
              mk.raw_data->>'stale_status' AS stale_status,
              mq.market_type,
              mq.line,
              m.status,
              m.match_date,
              pem.kickoff AS official_kickoff,
              COALESCE(pem.home_team_name, home_comp.team_name) AS home_team_name,
              COALESCE(pem.away_team_name, away_comp.team_name) AS away_team_name,
              mq.home_probability,
              mq.draw_probability,
              mq.away_probability,
              mq.home_fair_odds,
              mq.draw_fair_odds,
              mq.away_fair_odds,
              mk.home_odds,
              mk.draw_odds,
              mk.away_odds,
              mk.captured_at,
              mq.raw_data->'selection_map' AS selection_map,
              mq.raw_data->'disabled_selections' AS disabled_selections,
              COALESCE(mk.raw_data->'selection_odds', mk.raw_data->'odds') AS selection_odds
            FROM latest_model_quotes mq
            JOIN latest_market_quotes mk
              ON mk.match_id = mq.match_id
             AND mk.market_type = mq.market_type
             AND COALESCE(mk.line, -9999) = COALESCE(mq.line, -9999)
            JOIN matches m ON m.id = mq.match_id
            JOIN leagues l ON l.id = m.league_id
            JOIN sports s ON s.id = l.sport_id
            LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = mq.match_id AND pem.is_active = TRUE
            LEFT JOIN LATERAL (
              SELECT t.name AS team_name
              FROM match_competitors mc
              JOIN teams t ON t.id = mc.team_id
              WHERE mc.match_id = mq.match_id AND mc.home_away = 'home'
              LIMIT 1
            ) home_comp ON TRUE
            LEFT JOIN LATERAL (
              SELECT t.name AS team_name
              FROM match_competitors mc
              JOIN teams t ON t.id = mc.team_id
              WHERE mc.match_id = mq.match_id AND mc.home_away = 'away'
              LIMIT 1
            ) away_comp ON TRUE;
            """,
            params,
        ).fetchall()

        for row in rows:
            if row["sport_slug"] == "baseball" and row["league_slug"] == "mlb":
                fixture_validation = validate_mlb_fixture(
                    match_date=row["match_date"],
                    home_team=row.get("home_team_name"),
                    away_team=row.get("away_team_name"),
                    status=row.get("status"),
                )
                if not fixture_validation.ok:
                    print(
                        "[PREBET-REJECT]",
                        row["model_name"],
                        row["league_slug"],
                        row["market_type"],
                        fixture_validation.reason,
                    )
                    continue
            for selection in _selection_rows(row):
                market_validation = validate_market_quote(
                    market_type=row["market_type"],
                    market_odds=selection["market_odds"],
                    captured_at=row["captured_at"],
                )
                if not market_validation.ok:
                    print(
                        "[PREBET-REJECT]",
                        row["model_name"],
                        row["league_slug"],
                        row["market_type"],
                        selection["selection"],
                        market_validation.reason,
                    )
                    continue
                evaluated += 1
                if selection["expected_value"] < min_ev:
                    continue
                print(
                    "[ALPHA]",
                    row["model_name"],
                    row["sport_slug"],
                    selection["selection"],
                    f"ev={selection['expected_value']:.2%}",
                    f"market={selection['market_odds']}",
                )
                stake_fraction = _bankroll_fraction(selection, stake_mode, flat_fraction, kelly_fraction, max_fraction)
                if dry_run:
                    inserted += 1
                    if auto_paper:
                        print(
                            "[PAPER-DRY-RUN]",
                            row["model_name"],
                            row["league_slug"],
                            selection["selection"],
                            f"stake={stake_fraction:.4%}",
                        )
                    if _is_real_paper_candidate(row, selection):
                        print(
                            "[REAL-PAPER-DRY-RUN]",
                            row["model_name"],
                            row["league_slug"],
                            selection["selection"],
                            f"stake={stake_fraction:.4%}",
                        )
                    continue
                result = conn.execute(
                    """
                    INSERT INTO alpha_opportunities (
                      match_id, model_quote_id, market_quote_id,
                      sport_slug, league_slug, model_name, provider_name,
                      market_type, line, market_selection, model_probability,
                      model_fair_odds, market_odds, expected_value, raw_data
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                    ON CONFLICT (
                      model_quote_id,
                      market_quote_id,
                      market_selection,
                      COALESCE(line, -9999::numeric)
                    ) DO UPDATE SET
                      market_quote_id = EXCLUDED.market_quote_id,
                      provider_name = EXCLUDED.provider_name,
                      model_probability = EXCLUDED.model_probability,
                      model_fair_odds = EXCLUDED.model_fair_odds,
                      market_odds = EXCLUDED.market_odds,
                      expected_value = EXCLUDED.expected_value,
                      raw_data = EXCLUDED.raw_data,
                      detected_at = NOW()
                    RETURNING id;
                    """,
                    (
                        row["match_id"],
                        row["model_quote_id"],
                        row["market_quote_id"],
                        row["sport_slug"],
                        row["league_slug"],
                        row["model_name"],
                        row["provider_name"],
                        row["market_type"],
                        row.get("line"),
                        selection["selection"],
                        selection["probability"],
                        selection["fair_odds"],
                        selection["market_odds"],
                        round(selection["expected_value"], 6),
                        json.dumps({"source": "alpha_detector_v1"}),
                    ),
                )
                inserted += result.rowcount or 0
                if _create_real_paper_snapshot(conn, row, selection, stake_fraction):
                    real_paper_created += 1
                if auto_paper and _create_paper_trade(conn, row, selection, stake_fraction):
                    paper_created += 1
        if dry_run:
            conn.rollback()
        else:
            conn.commit()
    if auto_paper:
        print(f"[+] Paper trading auto creado={paper_created} stake_mode={stake_mode}")
    print(f"[+] Real paper snapshots creados={real_paper_created}")
    return evaluated, inserted


def main() -> None:
    parser = argparse.ArgumentParser(description="Detecta Alpha EV+ usando model_quotes vs market_quotes.")
    parser.add_argument("--model-name", default=None)
    parser.add_argument("--min-ev", type=float, default=0.05)
    parser.add_argument("--max-model-age-minutes", type=int, default=240)
    parser.add_argument("--max-market-age-minutes", type=int, default=30)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--auto-paper", action="store_true", help="Crea paper_trades para cada Alpha EV+.")
    parser.add_argument("--stake-mode", choices=["flat", "kelly"], default="flat")
    parser.add_argument("--flat-fraction", type=float, default=0.01)
    parser.add_argument("--kelly-fraction", type=float, default=0.25)
    parser.add_argument("--max-fraction", type=float, default=0.02)
    args = parser.parse_args()
    evaluated, inserted = detect_alpha(
        model_name=args.model_name,
        min_ev=args.min_ev,
        max_model_age_minutes=args.max_model_age_minutes,
        max_market_age_minutes=args.max_market_age_minutes,
        dry_run=args.dry_run,
        auto_paper=args.auto_paper,
        stake_mode=args.stake_mode,
        flat_fraction=args.flat_fraction,
        kelly_fraction=args.kelly_fraction,
        max_fraction=args.max_fraction,
    )
    print(f"[+] Alpha detector finalizado evaluadas={evaluated} oportunidades={inserted} dry_run={args.dry_run}")


if __name__ == "__main__":
    main()
