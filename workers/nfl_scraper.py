import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests


SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary"


def canonical_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def sha256_json(value: object) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def parse_score(value: object) -> int | None:
    try:
        return int(float(str(value)))
    except (TypeError, ValueError):
        return None


def normalize_status(status_type: dict) -> str:
    state = str(status_type.get("state") or "").lower()
    name = str(status_type.get("name") or "").upper()
    if "POSTPONED" in name:
        return "postponed"
    if "CANCELED" in name or "CANCELLED" in name:
        return "cancelled"
    if bool(status_type.get("completed")) or state == "post":
        return "finished"
    if state == "in":
        return "live"
    return "scheduled"


def side(competition: dict, home_away: str) -> dict:
    return next((row for row in competition.get("competitors") or [] if row.get("homeAway") == home_away), {})


def injury_rows(summary: dict) -> list[dict]:
    rows: list[dict] = []
    for team_group in summary.get("injuries") or []:
        team = team_group.get("team") or {}
        for item in team_group.get("injuries") or []:
            athlete = item.get("athlete") or {}
            position = athlete.get("position") or {}
            details = item.get("details") or {}
            rows.append({
                "team_id": str(team.get("id") or ""),
                "team": team.get("displayName"),
                "athlete_id": str(athlete.get("id") or ""),
                "player": athlete.get("displayName"),
                "position": position.get("abbreviation"),
                "status": item.get("status"),
                "injury": details.get("type"),
                "updated_at": item.get("date"),
            })
    return rows


def audit_market_observation(event: dict) -> list[dict]:
    observations: list[dict] = []
    competition = (event.get("competitions") or [{}])[0]
    for market in competition.get("odds") or []:
        provider = market.get("provider") or {}
        moneyline = market.get("moneyline") or {}
        observations.append({
            "provider": provider.get("displayName") or provider.get("name"),
            "details": market.get("details"),
            "home_moneyline": ((moneyline.get("home") or {}).get("close") or {}).get("odds"),
            "away_moneyline": ((moneyline.get("away") or {}).get("close") or {}).get("odds"),
            "spread": market.get("spread"),
            "total": market.get("overUnder"),
            "audit_only": True,
            "formal_entry_evidence": False,
        })
    return observations


def build_match(event: dict, summary: dict | None, evidence: dict) -> dict | None:
    competitions = event.get("competitions") or []
    if not competitions:
        return None
    competition = competitions[0]
    home = side(competition, "home")
    away = side(competition, "away")
    home_team = home.get("team") or {}
    away_team = away.get("team") or {}
    event_id = str(event.get("id") or competition.get("id") or "").strip()
    kickoff = str(competition.get("date") or event.get("date") or "").strip()
    if not event_id or not kickoff or not home_team.get("displayName") or not away_team.get("displayName"):
        return None

    status_type = (competition.get("status") or event.get("status") or {}).get("type") or {}
    injuries = injury_rows(summary or {})
    venue = competition.get("venue") or {}
    weather = event.get("weather") or (summary or {}).get("gameInfo", {}).get("weather") or {}
    missing = ["official_inactives", "starting_quarterbacks"]
    if not injuries:
        missing.append("injury_context")
    if not weather and not venue.get("indoor"):
        missing.append("weather_context")
    raw_data = {
        "source_match_id": f"espn-nfl-{event_id}",
        "provider": "espn_site_api",
        "provider_event_id": event_id,
        "source_url": evidence.get("source_url") or f"{SCOREBOARD_URL}?dates={kickoff[:10].replace('-', '')}",
        "summary_url": f"{SUMMARY_URL}?event={event_id}" if summary is not None else None,
        "match_date": kickoff,
        "observed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "provider_raw_sha256": evidence["sha256"],
        "provider_capture_path": evidence["path"],
        "season": event.get("season") or {},
        "week": event.get("week") or {},
        "venue": venue,
        "weather_context": weather,
        "injury_context": injuries,
        "official_inactives": [],
        "official_inactives_confirmed": False,
        "starting_quarterback_home": None,
        "starting_quarterback_away": None,
        "starting_quarterbacks_confirmed": False,
        "nfl_context_complete": False,
        "nfl_context_missing": missing,
        "market_observation_audit_only": audit_market_observation(event),
        "real_candidate": 0,
        "real_money_enabled": False,
        "kelly_enabled": False,
        "telegram_auto_enabled": False,
        "autopost_enabled": False,
    }
    return {
        "source_slug": "espn-nfl",
        "source_match_id": f"espn-nfl-{event_id}",
        "league_slug": "nfl",
        "match_date": kickoff,
        "status": normalize_status(status_type),
        "home_alias": str(home_team.get("displayName")),
        "away_alias": str(away_team.get("displayName")),
        "home_score": parse_score(home.get("score")),
        "away_score": parse_score(away.get("score")),
        "period": (competition.get("status") or {}).get("type", {}).get("detail"),
        "raw_data": raw_data,
    }


def write_evidence(payload: object, evidence_dir: Path, label: str) -> dict:
    evidence_dir.mkdir(parents=True, exist_ok=True)
    digest = sha256_json(payload)
    path = evidence_dir / f"{label}-{digest[:16]}.json"
    if not path.exists():
        path.write_bytes(canonical_bytes(payload))
    return {"sha256": digest, "path": str(path.resolve())}


def fetch_json(url: str, params: dict, timeout: int) -> dict:
    response = requests.get(url, params=params, timeout=timeout, headers={"Accept": "application/json"})
    response.raise_for_status()
    return response.json()


def collect(date_key: str, near_start: bool, evidence_dir: Path, timeout: int) -> list[dict]:
    scoreboard = fetch_json(SCOREBOARD_URL, {"dates": date_key}, timeout)
    scoreboard_evidence = write_evidence(scoreboard, evidence_dir, f"scoreboard-{date_key}")
    scoreboard_evidence["source_url"] = f"{SCOREBOARD_URL}?dates={date_key}"
    matches: list[dict] = []
    for event in scoreboard.get("events") or []:
        summary = None
        evidence = scoreboard_evidence
        kickoff_raw = str(event.get("date") or "")
        try:
            kickoff = datetime.fromisoformat(kickoff_raw.replace("Z", "+00:00"))
            minutes = (kickoff - datetime.now(timezone.utc)).total_seconds() / 60
        except ValueError:
            minutes = 999999
        if near_start and -5 <= minutes <= 180:
            event_id = str(event.get("id") or "")
            summary = fetch_json(SUMMARY_URL, {"event": event_id}, timeout)
            combined = {"scoreboard_event": event, "summary": summary}
            evidence = write_evidence(combined, evidence_dir, f"event-{event_id}")
            evidence["source_url"] = f"{SUMMARY_URL}?event={event_id}"
        match = build_match(event, summary, evidence)
        if match:
            matches.append(match)
    return matches


def post_batch(matches: list[dict], api_url: str, api_key: str, timeout: int) -> dict:
    headers = {"Content-Type": "application/json", "X-Internal-API-Key": api_key, "X-API-Key": api_key}
    response = requests.post(api_url, json={"matches": matches}, headers=headers, timeout=timeout)
    response.raise_for_status()
    return response.json()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=datetime.now().strftime("%Y%m%d"))
    parser.add_argument("--include-tomorrow", action="store_true")
    parser.add_argument("--near-start", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--api-url", default=os.environ.get("BATCH_INGESTION_URL", "http://127.0.0.1:4000/api/v1/internal/matches/batch"))
    parser.add_argument("--api-key", default=os.environ.get("INTERNAL_API_KEY", ""))
    parser.add_argument("--evidence-dir", default=os.environ.get("NFL_EVIDENCE_DIR", "evidence/nfl"))
    parser.add_argument("--timeout", type=int, default=20)
    args = parser.parse_args()
    base_date = datetime.strptime(args.date.replace("-", ""), "%Y%m%d").date()
    dates = [base_date]
    if args.include_tomorrow:
        dates.append(base_date + timedelta(days=1))
    matches: list[dict] = []
    for item in dates:
        matches.extend(collect(item.strftime("%Y%m%d"), args.near_start, Path(args.evidence_dir), args.timeout))
    deduped = {row["source_match_id"]: row for row in matches}
    rows = list(deduped.values())
    if args.dry_run:
        print(json.dumps({"mode": "dry-run", "detected": len(rows), "matches": rows}, indent=2))
        return 0
    if not args.api_key:
        raise RuntimeError("INTERNAL_API_KEY is required")
    result = post_batch(rows, args.api_url, args.api_key, args.timeout) if rows else {"processed": 0, "warnings": ["no_nfl_events"]}
    print(json.dumps({"system_status": "NFL_PROVIDER_CAPTURE_SAFE_V1", "dates": [d.isoformat() for d in dates], "near_start": args.near_start, "result": result}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"system_status": "NFL_PROVIDER_CAPTURE_FAILED", "error": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
