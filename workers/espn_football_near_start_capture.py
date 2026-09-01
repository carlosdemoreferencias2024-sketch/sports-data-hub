from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import sys
from typing import Any

import requests

from espn_soccer_scraper import (
    canonical_json,
    event_context,
    fetch_json,
    iso_z,
    league_provider_slugs,
    normalize_team,
    sha256_text,
    utc_now,
)


SUMMARY_ROOT = "https://site.api.espn.com/apis/site/v2/sports/soccer"


def _side_roster(payload: dict[str, Any], home_away: str) -> dict[str, Any]:
    return next(
        (row for row in payload.get("rosters") or [] if str(row.get("homeAway") or "").lower() == home_away),
        {},
    )


def _starter_rows(side: dict[str, Any]) -> list[dict[str, Any]]:
    return [row for row in side.get("roster") or [] if row.get("starter") is True]


def _player_name(row: dict[str, Any]) -> str:
    athlete = row.get("athlete") or {}
    return str(athlete.get("displayName") or athlete.get("fullName") or athlete.get("shortName") or "").strip()


def _starting_goalkeeper(starters: list[dict[str, Any]]) -> str | None:
    for row in starters:
        position = row.get("position") or {}
        abbreviation = str(position.get("abbreviation") or "").strip().upper()
        name = str(position.get("name") or position.get("displayName") or "").strip().lower()
        if abbreviation == "G" or name == "goalkeeper":
            return _player_name(row) or None
    return None


def parse_near_start_context(payload: dict[str, Any]) -> dict[str, Any]:
    header = payload.get("header") or {}
    competition = ((header.get("competitions") or [{}])[0])
    status_type = ((competition.get("status") or {}).get("type") or {})
    state = str(status_type.get("state") or "").strip().lower()
    home = _side_roster(payload, "home")
    away = _side_roster(payload, "away")
    home_starters = _starter_rows(home)
    away_starters = _starter_rows(away)
    lineups_present = bool(home.get("roster") or away.get("roster"))
    lineup_confirmed = state == "pre" and len(home_starters) == 11 and len(away_starters) == 11
    lineup_status = "CONFIRMED" if lineup_confirmed else ("PENDING" if lineups_present else "UNKNOWN")
    goalkeeper_home = _starting_goalkeeper(home_starters)
    goalkeeper_away = _starting_goalkeeper(away_starters)
    goalkeeper_confirmed = lineup_confirmed and bool(goalkeeper_home and goalkeeper_away)
    goalkeeper_status = "CONFIRMED" if goalkeeper_confirmed else ("PENDING" if lineups_present else "UNKNOWN")

    # Soccer summary currently exposes no complete injury/suspension report.
    # Presence of an unverified section is retained in raw evidence, but never
    # promoted to a complete availability gate by this worker.
    availability_status = "PENDING_HUMAN_VERIFICATION" if "injuries" in payload else "SOURCE_NOT_PROVIDED"
    return {
        "lineup_status": lineup_status,
        "goalkeeper_status": goalkeeper_status,
        "availability_status": availability_status,
        "home_lineup": [_player_name(row) for row in home_starters if _player_name(row)],
        "away_lineup": [_player_name(row) for row in away_starters if _player_name(row)],
        "formation_home": home.get("formation") or None,
        "formation_away": away.get("formation") or None,
        "goalkeeper_home": goalkeeper_home,
        "goalkeeper_away": goalkeeper_away,
        "player_availability_manual_verified": False,
        "unavailable_players": [],
    }


def fetch_target(url: str, api_key: str, date: str, match_id: str, timeout: int) -> dict[str, Any] | None:
    headers = {"X-Internal-API-Key": api_key, "X-API-Key": api_key}
    params = {"date": date, "min_minutes": 5, "max_minutes": 90}
    if match_id:
        params["match_id"] = match_id
    response = requests.get(url, params=params, headers=headers, timeout=timeout)
    response.raise_for_status()
    return response.json().get("target")


def fetch_official_context(url: str, api_key: str, match_id: str, timeout: int) -> dict[str, Any]:
    headers = {"X-Internal-API-Key": api_key, "X-API-Key": api_key}
    response = requests.post(
        url,
        json={"match_id": match_id, "dry_run": False, "max_cache_age_minutes": 5},
        headers=headers,
        timeout=timeout,
    )
    response.raise_for_status()
    return response.json()


def import_formal_context(url: str, api_key: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    response = requests.post(
        url,
        json=payload,
        headers={"Content-Type": "application/json", "X-Internal-API-Key": api_key, "X-API-Key": api_key},
        timeout=timeout,
    )
    response.raise_for_status()
    return response.json()


def validate_summary_identity(payload: dict[str, Any], target: dict[str, Any], provider_slug: str) -> dict[str, Any]:
    header = payload.get("header") or {}
    context = event_context(header, provider_slug, allow_post_kickoff=False)
    if context["event_id"] != str(target["provider_event_id"]):
        raise RuntimeError("ESPN_SUMMARY_EVENT_ID_MISMATCH")
    if normalize_team(context["home"]["name"]) != normalize_team(target["home_team"]):
        raise RuntimeError("ESPN_SUMMARY_HOME_TEAM_MISMATCH")
    if normalize_team(context["away"]["name"]) != normalize_team(target["away_team"]):
        raise RuntimeError("ESPN_SUMMARY_AWAY_TEAM_MISMATCH")
    expected_kickoff = str(target["kickoff"])
    if abs((context["kickoff"] - datetime.fromisoformat(expected_kickoff.replace("Z", "+00:00"))).total_seconds()) > 60:
        raise RuntimeError("ESPN_SUMMARY_KICKOFF_MISMATCH")
    return context


def build_draft(target: dict[str, Any], payload: dict[str, Any], source_url: str, captured_at: Any) -> dict[str, Any]:
    provider_raw_sha = sha256_text(canonical_json(payload))
    league_slug = "nwsl" if str(target["league_slug"]) == "football-observed-nwsl" else str(target["league_slug"])
    provider_slug = league_provider_slugs(league_slug)[0]
    context = validate_summary_identity(payload, target, provider_slug)
    parsed = parse_near_start_context(payload)
    normalized_event = {
        "source": "espn",
        "source_event_id": context["event_id"],
        "sport": "soccer",
        "league": context["league_name"],
        "competition": context["league_slug"],
        "starts_at": iso_z(context["kickoff"]),
        "status": "scheduled",
        "home": context["home"],
        "away": context["away"],
        "detail_level": "near_start_context",
        "observed_at": iso_z(captured_at),
    }
    data = {
        "provider": "espn_site_api",
        "provider_event_id": context["event_id"],
        "competition": context["league_slug"],
        "scheduled_kickoff": iso_z(context["kickoff"]),
        "provider_raw_sha256": provider_raw_sha,
        "normalized_event": normalized_event,
        **parsed,
    }
    evidence_payload = {
        "capture_type": "near_start_context",
        "captured_at": iso_z(captured_at),
        "data": data,
        "source_url": source_url,
    }
    evidence_canonical = canonical_json(evidence_payload)
    evidence_sha = sha256_text(evidence_canonical)
    return {
        "schema_version": "sports-data-hub.source-capture-draft.v1",
        "workflow_state": "PENDING_HUMAN_VERIFICATION",
        "auto_post": False,
        "match_id": str(target["match_id"]),
        "source_name": "espn_manual_verified",
        "source_url": source_url,
        "bookmaker": None,
        "captured_at": iso_z(captured_at),
        "verified_by": None,
        "evidence_id": evidence_sha[:32],
        "evidence_sha256": evidence_sha,
        "evidence_canonical_json": evidence_canonical,
        "capture_type": "near_start_context",
        "sport": "soccer",
        "source_event_id": context["event_id"],
        "match_fingerprint": sha256_text(
            f"{context['home']['name']}|{context['away']['name']}|{iso_z(context['kickoff'])}"
        )[:32],
        "data": data,
        "guardrails": {
            "picks_created": 0,
            "real_candidate": 0,
            "real_money_enabled": False,
            "kelly_enabled": False,
            "telegram_auto_enabled": False,
            "autopost_enabled": False,
            "human_verification_required": True,
            "kill_switch": True,
        },
    }


def build_official_draft(target: dict[str, Any], capture: dict[str, Any]) -> dict[str, Any]:
    if not capture.get("capture_ready"):
        raise RuntimeError("API_FOOTBALL_OFFICIAL_CONTEXT_NOT_READY")
    if str(capture.get("match_id") or "") != str(target["match_id"]):
        raise RuntimeError("API_FOOTBALL_MATCH_ID_MISMATCH")
    if normalize_team(capture.get("home_team")) != normalize_team(target["home_team"]):
        raise RuntimeError("API_FOOTBALL_HOME_TEAM_MISMATCH")
    if normalize_team(capture.get("away_team")) != normalize_team(target["away_team"]):
        raise RuntimeError("API_FOOTBALL_AWAY_TEAM_MISMATCH")
    provider_raw_sha = str(capture.get("provider_raw_sha256") or "").strip().lower()
    availability_sha = str(capture.get("availability_provider_raw_sha256") or "").strip().lower()
    if len(provider_raw_sha) != 64 or len(availability_sha) != 64:
        raise RuntimeError("API_FOOTBALL_PROVIDER_RAW_SHA256_REQUIRED")
    captured_at = datetime.fromisoformat(str(capture["captured_at"]).replace("Z", "+00:00"))
    kickoff = datetime.fromisoformat(str(capture["kickoff"]).replace("Z", "+00:00"))
    source_url = str(capture["source_url"])
    normalized_event = {
        "source": "api_football",
        "source_event_id": str(capture["provider_event_id"]),
        "sport": "soccer",
        "league": str(capture.get("league_slug") or target["league_slug"]),
        "competition": str(capture.get("league_slug") or target["league_slug"]),
        "starts_at": iso_z(kickoff),
        "status": "scheduled",
        "home": {"name": str(capture["home_team"])},
        "away": {"name": str(capture["away_team"])},
        "detail_level": "near_start_context",
        "observed_at": iso_z(captured_at),
    }
    data = {
        "provider": "api_football",
        "provider_event_id": str(capture["provider_event_id"]),
        "competition": str(capture.get("league_slug") or target["league_slug"]),
        "scheduled_kickoff": iso_z(kickoff),
        "provider_raw_sha256": provider_raw_sha,
        "availability_provider": "api_football",
        "availability_provider_raw_sha256": availability_sha,
        "availability_source_url": source_url,
        "normalized_event": normalized_event,
        "lineup_status": capture.get("lineup_status") or "UNKNOWN",
        "goalkeeper_status": capture.get("goalkeeper_status") or "UNKNOWN",
        "availability_status": capture.get("availability_status") or "SOURCE_UNAVAILABLE",
        "home_lineup": capture.get("home_lineup") or [],
        "away_lineup": capture.get("away_lineup") or [],
        "formation_home": capture.get("formation_home"),
        "formation_away": capture.get("formation_away"),
        "goalkeeper_home": capture.get("goalkeeper_home"),
        "goalkeeper_away": capture.get("goalkeeper_away"),
        "player_availability_manual_verified": False,
        "unavailable_players": capture.get("unavailable_players") or [],
        "injuries": capture.get("injuries") or [],
        "suspensions": capture.get("suspensions") or [],
        "availability_details": capture.get("availability_details") or [],
        "source_integrity": capture.get("source_integrity") or {},
    }
    evidence_payload = {
        "capture_type": "near_start_context",
        "captured_at": iso_z(captured_at),
        "data": data,
        "source_url": source_url,
    }
    evidence_canonical = canonical_json(evidence_payload)
    evidence_sha = sha256_text(evidence_canonical)
    return {
        "schema_version": "sports-data-hub.source-capture-draft.v1",
        "workflow_state": "PENDING_HUMAN_VERIFICATION",
        "auto_post": False,
        "match_id": str(target["match_id"]),
        "source_name": "official_league_manual_verified",
        "source_url": source_url,
        "bookmaker": None,
        "captured_at": iso_z(captured_at),
        "verified_by": None,
        "evidence_id": evidence_sha[:32],
        "evidence_sha256": evidence_sha,
        "evidence_canonical_json": evidence_canonical,
        "capture_type": "near_start_context",
        "sport": "soccer",
        "source_event_id": str(capture["provider_event_id"]),
        "match_fingerprint": sha256_text(
            f"{capture['home_team']}|{capture['away_team']}|{iso_z(kickoff)}"
        )[:32],
        "data": data,
        "guardrails": {
            "picks_created": 0,
            "real_candidate": 0,
            "real_money_enabled": False,
            "kelly_enabled": False,
            "telegram_auto_enabled": False,
            "autopost_enabled": False,
            "human_verification_required": True,
            "kill_switch": True,
        },
    }


def persist_draft(draft: dict[str, Any], payload: dict[str, Any], output_root: Path) -> tuple[Path, bool]:
    date_part = str(draft["captured_at"])[:10]
    output_dir = output_root / date_part
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_hash = str(draft["data"]["provider_raw_sha256"])
    match_id = str(draft["match_id"])
    provider = str(draft["data"].get("provider") or "near_start").replace("-", "_")
    draft_path = output_dir / f"{provider}_context__{match_id}__{raw_hash}.json"
    if draft_path.exists():
        return draft_path, False
    raw_path = output_dir / f"{provider}_context__{match_id}__{raw_hash}__source_response.json"
    draft_path.write_text(json.dumps(draft, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    raw_path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    return draft_path, True


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture ESPN soccer near-start evidence for human review.")
    parser.add_argument("--date", required=True)
    parser.add_argument("--match-id", default="")
    parser.add_argument("--api-key", default=os.environ.get("INTERNAL_API_KEY", ""))
    parser.add_argument(
        "--target-api-url",
        default="http://127.0.0.1:4000/api/v1/internal/analytics/football/near-start-capture/target",
    )
    parser.add_argument(
        "--official-context-api-url",
        default="http://127.0.0.1:4000/api/v1/internal/analytics/football/near-start-capture/official-context",
    )
    parser.add_argument(
        "--formal-context-import-url",
        default="http://127.0.0.1:4000/api/v1/internal/analytics/football/provider-near-start-capture",
    )
    parser.add_argument(
        "--output-root",
        default=str(Path(__file__).resolve().parents[1] / "uploads" / "source-captures" / "scraper-inbox"),
    )
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not args.api_key:
        raise RuntimeError("INTERNAL_API_KEY_REQUIRED")

    target = fetch_target(args.target_api_url, args.api_key, args.date, args.match_id, args.timeout)
    if not target:
        print(json.dumps({"system_status": "FOOTBALL_NEAR_START_CAPTURE_NO_TARGET", "draft_created": False}))
        return 0
    provider_name = str(target.get("provider_name") or "").lower().replace("_", "-")
    formal_payload: dict[str, Any]
    if "api-football" in provider_name:
        official_capture = fetch_official_context(
            args.official_context_api_url, args.api_key, str(target["match_id"]), args.timeout
        )
        if not official_capture.get("capture_ready"):
            print(json.dumps({
                "system_status": official_capture.get("system_status") or "FOOTBALL_OFFICIAL_NEAR_START_SOURCE_UNAVAILABLE",
                "match_id": target["match_id"],
                "draft_created": False,
                "auto_import": False,
                "picks_created": 0,
                "real_candidate": 0,
            }, ensure_ascii=True))
            return 0
        payload = official_capture.get("raw_payload") or {}
        draft = build_official_draft(target, official_capture)
        formal_payload = official_capture
    else:
        league_slug = "nwsl" if str(target["league_slug"]) == "football-observed-nwsl" else str(target["league_slug"])
        provider_slug = league_provider_slugs(league_slug)[0]
        source_url = f"{SUMMARY_ROOT}/{provider_slug}/summary?event={target['provider_event_id']}"
        payload = fetch_json(source_url, args.timeout)
        captured_at = utc_now()
        draft = build_draft(target, payload, source_url, captured_at)
        formal_payload = {
            "match_id": str(target["match_id"]),
            "captured_at": iso_z(captured_at),
            "source_url": source_url,
            **draft["data"],
        }
    draft_path = None
    created = False
    if not args.dry_run:
        draft_path, created = persist_draft(draft, payload, Path(args.output_root))
    provider_import = None
    if not args.dry_run:
        provider_import = import_formal_context(
            args.formal_context_import_url,
            args.api_key,
            formal_payload,
            args.timeout,
        )
    print(json.dumps({
        "system_status": "FOOTBALL_NEAR_START_CAPTURE_DRAFT_READY",
        "match_id": target["match_id"],
        "match": f"{target['home_team']} vs {target['away_team']}",
        "kickoff": target["kickoff"],
        "provider_event_id": target["provider_event_id"],
        "draft_created": created,
        "draft_path": str(draft_path.resolve()) if draft_path else None,
        "evidence_id": draft["evidence_id"],
        "provider_raw_sha256": draft["data"]["provider_raw_sha256"],
        "lineup_status": draft["data"]["lineup_status"],
        "goalkeeper_status": draft["data"]["goalkeeper_status"],
        "availability_status": draft["data"]["availability_status"],
        "auto_import": bool(provider_import),
        "provider_import": provider_import,
        "picks_created": 0,
        "real_candidate": 0,
    }, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"system_status": "FOOTBALL_NEAR_START_CAPTURE_FAILED", "error": str(error)}))
        raise SystemExit(1)
