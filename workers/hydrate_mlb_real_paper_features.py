import argparse
import csv
import hashlib
import json
import os
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

import psycopg


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)

REQUIRED_COMPLETE_COLUMNS = ("hub_match_id", "home_era", "home_whip", "away_era", "away_whip")
PARTIAL_CONTEXT_COLUMNS = (
    "probable_pitcher_home",
    "probable_pitcher_away",
    "home_era",
    "home_whip",
    "away_era",
    "away_whip",
    "home_ops",
    "away_ops",
    "home_bullpen_era",
    "away_bullpen_era",
)
ACTIVE_REAL_PAPER_STATUSES = ("OPEN", "PENDING_CLOSING", "PENDING_RESULT", "PENDING_RESULTS")


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _decimal(row: dict[str, str], key: str) -> float | None:
    raw = _clean(row.get(key))
    if not raw:
        return None
    try:
        return float(Decimal(raw))
    except InvalidOperation:
        raise ValueError(f"{key} must be numeric, got {raw!r}") from None


def _bool(row: dict[str, str], key: str) -> bool | None:
    raw = _clean(row.get(key)).lower()
    if not raw:
        return None
    if raw in {"1", "true", "yes", "y", "si", "sÃ­"}:
        return True
    if raw in {"0", "false", "no", "n"}:
        return False
    raise ValueError(f"{key} must be boolean-like, got {raw!r}")


def _text(row: dict[str, str], key: str) -> str | None:
    value = _clean(row.get(key))
    return value or None


def _timestamp(row: dict[str, str], key: str) -> str | None:
    value = _clean(row.get(key))
    if not value:
        return None
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise ValueError(f"{key} must be ISO timestamp, got {value!r}") from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat()


def _json_value(row: dict[str, str], key: str) -> Any | None:
    raw = _clean(row.get(key))
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def _stable_feature_fingerprint(feature_set: dict[str, Any]) -> str:
    volatile_keys = {"feature_hydrated_at", "ingested_at", "provider_observed_at", "feature_verified_at"}
    stable_feature_set = {key: value for key, value in feature_set.items() if key not in volatile_keys}
    encoded = json.dumps(stable_feature_set, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _validate_required(row: dict[str, str], allow_partial: bool) -> list[str]:
    if allow_partial:
        if not _clean(row.get("hub_match_id")):
            return ["hub_match_id"]
        if not any(_clean(row.get(column)) for column in PARTIAL_CONTEXT_COLUMNS):
            return ["at_least_one_verified_context_field"]
        return []
    return [column for column in REQUIRED_COMPLETE_COLUMNS if not _clean(row.get(column))]


def _build_feature_set(row: dict[str, str], source: str, allow_partial: bool) -> dict[str, Any]:
    home_era = _decimal(row, "home_era")
    away_era = _decimal(row, "away_era")
    home_whip = _decimal(row, "home_whip")
    away_whip = _decimal(row, "away_whip")
    feature_set: dict[str, Any] = {
        "feature_schema_version": "mlb_matchup_v1",
        "feature_source": source,
        "feature_verified": True,
        "feature_hydrated_at": datetime.now(UTC).isoformat(),
        "feature_completeness": _text(row, "feature_completeness") or ("partial" if allow_partial else "complete"),
        "missing_context": [item for item in (_text(row, "missing_context") or "").split(";") if item],
    }

    required_numeric = {
        "home_era": ("home_era", "home_starter_era"),
        "away_era": ("away_era", "away_starter_era"),
        "home_whip": ("home_whip",),
        "away_whip": ("away_whip",),
    }
    for source_key, target_keys in required_numeric.items():
        value = {
            "home_era": home_era,
            "away_era": away_era,
            "home_whip": home_whip,
            "away_whip": away_whip,
        }[source_key]
        if value is None:
            continue
        for target_key in target_keys:
            feature_set[target_key] = value

    optional_numeric = {
        "home_ops": ("home_ops", "home_lineup_ops"),
        "away_ops": ("away_ops", "away_lineup_ops"),
        "home_bullpen_era": ("home_bullpen_era",),
        "away_bullpen_era": ("away_bullpen_era",),
        "home_bullpen_last_72h_innings": ("home_bullpen_last_72h_innings",),
        "away_bullpen_last_72h_innings": ("away_bullpen_last_72h_innings",),
        "home_bullpen_last_72h_relievers_used": ("home_bullpen_last_72h_relievers_used",),
        "away_bullpen_last_72h_relievers_used": ("away_bullpen_last_72h_relievers_used",),
        "home_bullpen_high_pitch_arms_last_72h": ("home_bullpen_high_pitch_arms_last_72h",),
        "away_bullpen_high_pitch_arms_last_72h": ("away_bullpen_high_pitch_arms_last_72h",),
        "home_bullpen_fatigue_score": ("home_bullpen_fatigue_score", "home_bullpen_fatigue"),
        "away_bullpen_fatigue_score": ("away_bullpen_fatigue_score", "away_bullpen_fatigue"),
        "home_rest_days": ("home_rest_days",),
        "away_rest_days": ("away_rest_days",),
        "home_travel_distance": ("home_travel_distance",),
        "away_travel_distance": ("away_travel_distance",),
        "minutes_before_start": ("minutes_before_start",),
        "kickoff_drift_minutes": ("kickoff_drift_minutes",),
        "source_confidence_score": ("source_confidence_score",),
    }
    for source_key, target_keys in optional_numeric.items():
        value = _decimal(row, source_key)
        if value is None:
            continue
        for target_key in target_keys:
            feature_set[target_key] = value

    optional_text = {
        "mlb_game_pk": "mlb_game_pk",
        "probable_pitcher_home": "probable_pitcher_home",
        "probable_pitcher_away": "probable_pitcher_away",
        "home_pitcher_id": "home_pitcher_id",
        "away_pitcher_id": "away_pitcher_id",
        "home_pitcher_status": "home_pitcher_status",
        "away_pitcher_status": "away_pitcher_status",
        "lineup_status": "lineup_status",
        "home_lineup_status": "home_lineup_status",
        "away_lineup_status": "away_lineup_status",
        "doubleheader_status": "doubleheader_status",
        "near_start_window": "near_start_window",
        "source_url": "feature_source_url",
        "original_scheduled_start": "original_scheduled_start_raw",
    }
    for source_key, target_key in optional_text.items():
        value = _text(row, source_key)
        if value:
            feature_set[target_key] = value

    for key in (
        "home_lineup_confirmed",
        "away_lineup_confirmed",
        "pitcher_team_mapping_valid",
        "batting_order_complete",
        "home_batting_order_complete",
        "away_batting_order_complete",
        "home_scratches_checked",
        "away_scratches_checked",
        "home_bullpen_context_fresh",
        "away_bullpen_context_fresh",
        "travel_rest_context_complete",
        "post_kickoff_observation",
        "audit_only_context",
        "kickoff_corrected_from_provider",
    ):
        value = _bool(row, key)
        if value is not None:
            feature_set[key] = value

    for key in ("home_batting_order", "away_batting_order"):
        value = _json_value(row, key)
        if value is not None:
            feature_set[key] = value

    verified_at = _timestamp(row, "verified_at")
    if verified_at:
        feature_set["feature_verified_at"] = verified_at
    for source_key, target_key in (
        ("scheduled_start", "scheduled_start"),
        ("provider_observed_at", "provider_observed_at"),
        ("ingested_at", "ingested_at"),
        ("actual_first_pitch", "actual_first_pitch"),
        ("original_scheduled_start", "original_scheduled_start"),
        ("official_game_date", "official_game_date"),
    ):
        timestamp_value = _timestamp(row, source_key)
        if timestamp_value:
            feature_set[target_key] = timestamp_value

    return feature_set


def hydrate_features(input_path: str, model_name: str, apply: bool, hydrate_snapshots: bool, allow_partial: bool) -> dict[str, Any]:
    processed = 0
    skipped = 0
    inserted_model_features = 0
    updated_snapshots = 0
    duplicate_model_features_skipped = 0
    duplicate_snapshot_updates_skipped = 0
    forecast_contexts_inserted = 0
    errors: list[dict[str, Any]] = []
    examples: list[dict[str, Any]] = []

    with psycopg.connect(DATABASE_URL) as conn:
        with open(input_path, newline="", encoding="utf-8") as file:
            reader = csv.DictReader(file)
            for line_number, row in enumerate(reader, start=2):
                missing = _validate_required(row, allow_partial)
                if missing:
                    skipped += 1
                    errors.append({"line": line_number, "reason": "missing_required", "columns": missing})
                    continue

                match_id = _clean(row.get("hub_match_id"))
                row_model_name = _clean(row.get("model_name")) or model_name
                source = _clean(row.get("source")) or "manual_verified_mlb_matchup"

                try:
                    feature_set = _build_feature_set(row, source, allow_partial)
                    feature_fingerprint = _stable_feature_fingerprint(feature_set)
                    feature_set["feature_fingerprint"] = feature_fingerprint
                except ValueError as exc:
                    skipped += 1
                    errors.append({"line": line_number, "match_id": match_id, "reason": str(exc)})
                    continue

                exists = conn.execute("SELECT 1 FROM v_valid_matches WHERE id = %s LIMIT 1;", (match_id,)).fetchone()
                if not exists:
                    skipped += 1
                    errors.append({"line": line_number, "match_id": match_id, "reason": "match_not_found"})
                    continue

                processed += 1
                examples.append(
                    {
                        "match_id": match_id,
                        "model_name": row_model_name,
                        "home_team": _clean(row.get("home_team")),
                        "away_team": _clean(row.get("away_team")),
                        "feature_keys": sorted(feature_set.keys()),
                    }
                )

                if not apply:
                    continue

                feature_json = json.dumps(feature_set, ensure_ascii=False)
                feature_exists = conn.execute(
                    """
                    SELECT 1
                    FROM model_features
                    WHERE match_id = %s
                      AND sport_slug = 'baseball'
                      AND model_name = %s
                      AND feature_set->>'feature_fingerprint' = %s
                    LIMIT 1;
                    """,
                    (match_id, row_model_name, feature_fingerprint),
                ).fetchone()
                model_feature_id = None
                if feature_exists:
                    duplicate_model_features_skipped += 1
                    model_feature_id = conn.execute(
                        """
                        SELECT id
                        FROM model_features
                        WHERE match_id = %s
                          AND sport_slug = 'baseball'
                          AND model_name = %s
                          AND feature_set->>'feature_fingerprint' = %s
                        ORDER BY generated_at DESC
                        LIMIT 1;
                        """,
                        (match_id, row_model_name, feature_fingerprint),
                    ).fetchone()[0]
                else:
                    model_feature_id = conn.execute(
                        """
                        INSERT INTO model_features (match_id, sport_slug, model_name, feature_set)
                        VALUES (%s, 'baseball', %s, %s::jsonb)
                        RETURNING id;
                        """,
                        (match_id, row_model_name, feature_json),
                    ).fetchone()[0]
                    inserted_model_features += 1

                conn.execute("SELECT * FROM register_forecast_match(%s::uuid);", (match_id,))
                lineup_confirmed = bool(feature_set.get("home_lineup_confirmed")) and bool(
                    feature_set.get("away_lineup_confirmed")
                )
                batting_order_complete = bool(feature_set.get("batting_order_complete"))
                pitchers_confirmed = bool(feature_set.get("probable_pitcher_home")) and bool(
                    feature_set.get("probable_pitcher_away")
                ) and bool(feature_set.get("pitcher_team_mapping_valid"))
                bullpen_context_complete = bool(feature_set.get("home_bullpen_context_fresh")) and bool(
                    feature_set.get("away_bullpen_context_fresh")
                )
                post_kickoff = bool(feature_set.get("post_kickoff_observation"))
                complete_context = (
                    feature_set.get("feature_completeness") == "complete"
                    and lineup_confirmed
                    and batting_order_complete
                    and pitchers_confirmed
                    and bullpen_context_complete
                    and not post_kickoff
                )
                missing_context = feature_set.get("missing_context") or []
                if not isinstance(missing_context, list):
                    missing_context = [str(missing_context)] if str(missing_context).strip() else []
                if complete_context:
                    missing_context = []
                else:
                    if not lineup_confirmed:
                        missing_context.append("official_lineups")
                    if not batting_order_complete:
                        missing_context.append("batting_order")
                    if not pitchers_confirmed:
                        missing_context.append("pitchers")
                    if not bullpen_context_complete:
                        missing_context.append("bullpen")
                    if post_kickoff:
                        missing_context.append("post_kickoff_observation")
                captured_at = (
                    feature_set.get("provider_observed_at")
                    or feature_set.get("feature_verified_at")
                    or feature_set.get("feature_hydrated_at")
                )
                context_result = conn.execute(
                    """
                    INSERT INTO forecast_context_snapshots (
                      match_id, model_feature_id, captured_at, lineup_confirmed,
                      batting_order_complete, pitchers_confirmed, bullpen_context_complete,
                      goalkeeper_confirmed, injuries_json, weather_json, missing_fields_json,
                      notes, completeness_flag, source_url, source_payload_hash, capture_mode,
                      source_published_at, source_as_of_at, replay_verified_by,
                      no_post_event_data_attested
                    )
                    SELECT
                      %s::uuid, %s::uuid, COALESCE(%s::timestamptz, NOW()), %s, %s, %s, %s,
                      true, '{}'::jsonb, NULL, %s::jsonb,
                      'MLB near-start context bridged from verified model features', %s,
                      %s, %s, 'LIVE_FORWARD', COALESCE(%s::timestamptz, NOW()),
                      COALESCE(%s::timestamptz, NOW()), 'mlb_stats_api_near_start', %s
                    WHERE NOT EXISTS (
                      SELECT 1 FROM forecast_context_snapshots WHERE model_feature_id = %s::uuid
                    )
                    RETURNING id;
                    """,
                    (
                        match_id,
                        model_feature_id,
                        captured_at,
                        lineup_confirmed,
                        batting_order_complete,
                        pitchers_confirmed,
                        bullpen_context_complete,
                        json.dumps(sorted(set(missing_context))),
                        "complete" if complete_context else "partial",
                        feature_set.get("feature_source_url"),
                        feature_fingerprint,
                        captured_at,
                        captured_at,
                        not post_kickoff,
                        model_feature_id,
                    ),
                ).fetchone()
                if context_result:
                    forecast_contexts_inserted += 1

                if hydrate_snapshots:
                    result = conn.execute(
                        """
                        UPDATE real_paper_snapshots
                        SET raw_data = jsonb_set(
                              COALESCE(raw_data, '{}'::jsonb),
                              '{feature_set}',
                              COALESCE(raw_data->'feature_set', '{}'::jsonb) || %s::jsonb,
                              true
                            )
                            || jsonb_build_object(
                              'feature_set_hydrated_at', NOW(),
                              'feature_set_source', %s::text
                            )
                        WHERE match_id = %s
                          AND sport_slug = 'baseball'
                          AND league_slug = 'mlb'
                          AND market_type = 'moneyline_2way'
                          AND model_name = %s
                          AND status = ANY(%s::text[])
                          AND COALESCE(raw_data->'feature_set'->>'feature_fingerprint', '') <> %s;
                        """,
                        (feature_json, source, match_id, row_model_name, list(ACTIVE_REAL_PAPER_STATUSES), feature_fingerprint),
                    )
                    rowcount = result.rowcount or 0
                    updated_snapshots += rowcount
                    if rowcount == 0:
                        duplicate_snapshot_updates_skipped += 1

        if apply:
            conn.commit()
        else:
            conn.rollback()

    return {
        "dry_run": not apply,
        "hydrate_snapshots": hydrate_snapshots,
        "allow_partial": allow_partial,
        "processed": processed,
        "skipped": skipped,
        "inserted_model_features": inserted_model_features,
        "updated_snapshots": updated_snapshots,
        "duplicate_model_features_skipped": duplicate_model_features_skipped,
        "duplicate_snapshot_updates_skipped": duplicate_snapshot_updates_skipped,
        "forecast_contexts_inserted": forecast_contexts_inserted,
        "errors": errors[:25],
        "examples": examples[:10],
        "guardrails": {
            "real_candidate": 0,
            "real_money_enabled": False,
            "kelly_enabled": False,
            "telegram_auto_enabled": False,
            "real_paper_only": True,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Hydrate MLB Real Paper matchup features from reviewed CSV data.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--model-name", default="carlos_v1_mlb")
    parser.add_argument("--apply", action="store_true", help="Persist model_features rows. Default is dry-run.")
    parser.add_argument("--hydrate-snapshots", action="store_true", help="Also copy feature_set into active real_paper_snapshots.raw_data.")
    parser.add_argument("--allow-partial", action="store_true", help="Allow verified partial context rows when full starter data is not available.")
    args = parser.parse_args()

    summary = hydrate_features(
        input_path=args.input,
        model_name=args.model_name,
        apply=args.apply,
        hydrate_snapshots=args.hydrate_snapshots,
        allow_partial=args.allow_partial,
    )
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
