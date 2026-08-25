import argparse
import hashlib
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests


SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"


def canonical_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def sha256_json(value: object) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def parse_score(value: object) -> int | None:
    try:
        return int(float(str(value)))
    except (TypeError, ValueError):
        return None


def fetch_year(year: int, timeout: int) -> list[dict]:
    response = requests.get(
        SCOREBOARD_URL,
        params={"dates": str(year), "limit": 1000},
        timeout=timeout,
        headers={"Accept": "application/json"},
    )
    response.raise_for_status()
    payload = response.json()
    return payload.get("events") or []


def competition_for(event: dict) -> dict:
    rows = event.get("competitions") or []
    return rows[0] if rows else {}


def side(competition: dict, home_away: str) -> dict:
    return next((row for row in competition.get("competitors") or [] if row.get("homeAway") == home_away), {})


def completed_event(event: dict, minimum_season: int, cutoff: datetime) -> bool:
    competition = competition_for(event)
    status_type = (competition.get("status") or event.get("status") or {}).get("type") or {}
    try:
        played_at = datetime.fromisoformat(str(competition.get("date") or event.get("date")).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    season_year = int((event.get("season") or {}).get("year") or 0)
    return bool(status_type.get("completed")) and season_year >= minimum_season and played_at < cutoff


def season_kind(event: dict) -> str:
    season = event.get("season") or {}
    slug = str(season.get("slug") or "").lower()
    season_type = int(season.get("type") or 0)
    if season_type == 1 or slug == "preseason":
        return "preseason"
    if season_type == 3 or "post" in slug:
        return "postseason"
    return "regular"


def write_evidence(event: dict, evidence_dir: Path) -> tuple[str, str]:
    evidence_dir.mkdir(parents=True, exist_ok=True)
    digest = sha256_json(event)
    event_id = str(event.get("id") or "unknown")
    path = evidence_dir / f"history-{event_id}-{digest[:16]}.json"
    if not path.exists():
        path.write_bytes(canonical_bytes(event))
    return digest, str(path.resolve())


def elo_transition(home_rating: float, away_rating: float, home_score: int, away_score: int, kind: str) -> tuple[float, float]:
    home_advantage = 15.0 if kind == "preseason" else 45.0
    expected_home = 1.0 / (1.0 + 10.0 ** (-((home_rating + home_advantage - away_rating) / 400.0)))
    actual_home = 1.0 if home_score > away_score else 0.0 if home_score < away_score else 0.5
    base_k = 10.0 if kind == "preseason" else 24.0 if kind == "postseason" else 20.0
    margin_multiplier = min(2.25, 1.0 + math.log1p(abs(home_score - away_score)) / 4.0)
    change = base_k * margin_multiplier * (actual_home - expected_home)
    return home_rating + change, away_rating - change


def build_rows(events: list[dict], evidence_dir: Path, captured_at: str) -> tuple[list[dict], list[dict]]:
    matches: list[dict] = []
    team_stats: list[dict] = []
    ratings: dict[str, float] = {}
    last_played: dict[str, datetime] = {}

    for event in sorted(events, key=lambda row: str(competition_for(row).get("date") or row.get("date") or "")):
        competition = competition_for(event)
        home = side(competition, "home")
        away = side(competition, "away")
        home_team = home.get("team") or {}
        away_team = away.get("team") or {}
        event_id = str(event.get("id") or competition.get("id") or "").strip()
        home_id = str(home_team.get("id") or "").strip()
        away_id = str(away_team.get("id") or "").strip()
        home_name = str(home_team.get("displayName") or "").strip()
        away_name = str(away_team.get("displayName") or "").strip()
        home_score = parse_score(home.get("score"))
        away_score = parse_score(away.get("score"))
        kickoff = str(competition.get("date") or event.get("date") or "").strip()
        if not all([event_id, home_id, away_id, home_name, away_name, kickoff]) or home_score is None or away_score is None:
            continue

        played_at = datetime.fromisoformat(kickoff.replace("Z", "+00:00"))
        kind = season_kind(event)
        home_elo_before = ratings.get(home_id, 1500.0)
        away_elo_before = ratings.get(away_id, 1500.0)
        home_elo_after, away_elo_after = elo_transition(
            home_elo_before, away_elo_before, home_score, away_score, kind
        )
        ratings[home_id] = home_elo_after
        ratings[away_id] = away_elo_after
        evidence_sha, evidence_path = write_evidence(event, evidence_dir)
        match_id = f"espn-nfl-history-{event_id}"
        season = str((event.get("season") or {}).get("year") or "")
        source_url = f"{SCOREBOARD_URL}?dates={played_at.year}&limit=1000"
        venue = competition.get("venue") or {}
        result = "DRAW" if home_score == away_score else "HOME" if home_score > away_score else "AWAY"
        raw_common = {
            "provider": "espn_site_api",
            "provider_event_id": event_id,
            "provider_raw_sha256": evidence_sha,
            "provider_capture_path": evidence_path,
            "source_url": source_url,
            "captured_at": captured_at,
            "capture_mode": "LIVE_FORWARD_HISTORICAL_BACKFILL",
            "no_post_event_market_data_used": True,
            "market_inputs_used": False,
            "season": event.get("season") or {},
            "week": event.get("week") or {},
        }
        matches.append({
            "match_id": match_id,
            "provider_match_id": event_id,
            "canonical_match_id": match_id,
            "sport": "american_football",
            "league_id": "nfl",
            "competition_id": "nfl",
            "season": season,
            "match_date": kickoff,
            "kickoff": kickoff,
            "home_team_id": home_id,
            "away_team_id": away_id,
            "home_team_name": home_name,
            "away_team_name": away_name,
            "status": "FINAL",
            "home_score": home_score,
            "away_score": away_score,
            "result": result,
            "competition_type": kind,
            "match_importance": "preseason" if kind == "preseason" else "playoffs" if kind == "postseason" else "regular",
            "is_official": kind != "preseason",
            "is_preseason": kind == "preseason",
            "venue": venue.get("fullName"),
            "neutral_venue": bool(competition.get("neutralSite")),
            "attendance": competition.get("attendance"),
            "rotation_risk": "high" if kind == "preseason" else "normal",
            "source": "espn_nfl_site_api",
            "source_confidence_score": 95,
            "source_observed_at": captured_at,
            "raw_data": raw_common,
        })

        for is_home, team_id, team_name, opponent_id, opponent_name, points_for, points_against, elo_before, elo_after, opponent_elo in [
            (True, home_id, home_name, away_id, away_name, home_score, away_score, home_elo_before, home_elo_after, away_elo_before),
            (False, away_id, away_name, home_id, home_name, away_score, home_score, away_elo_before, away_elo_after, home_elo_before),
        ]:
            prior = last_played.get(team_id)
            rest_days = (played_at - prior).total_seconds() / 86400.0 if prior else None
            won = points_for > points_against
            drew = points_for == points_against
            team_stats.append({
                "match_id": match_id,
                "sport": "american_football",
                "league_id": "nfl",
                "season": season,
                "team_id": team_id,
                "team_name": team_name,
                "opponent_team_id": opponent_id,
                "opponent_team": opponent_name,
                "is_home": is_home,
                "is_neutral": bool(competition.get("neutralSite")),
                "result": "W" if won else "D" if drew else "L",
                "points_for": points_for,
                "points_against": points_against,
                "rest_days": round(rest_days, 3) if rest_days is not None else None,
                "won": won,
                "drew": drew,
                "lost": not won and not drew,
                "source": "espn_nfl_site_api",
                "source_confidence_score": 95,
                "raw_data": {
                    **raw_common,
                    "is_preseason": kind == "preseason",
                    "team_elo_before": round(elo_before, 6),
                    "team_elo_after": round(elo_after, 6),
                    "opponent_elo_before": round(opponent_elo, 6),
                    "elo_calculation_version": "nfl_result_elo_v1",
                },
            })
        last_played[home_id] = played_at
        last_played[away_id] = played_at
    return matches, team_stats


def post_chunks(matches: list[dict], team_stats: list[dict], api_url: str, api_key: str, timeout: int, chunk_size: int) -> list[dict]:
    stats_by_match: dict[str, list[dict]] = {}
    for row in team_stats:
        stats_by_match.setdefault(str(row["match_id"]), []).append(row)
    headers = {"Content-Type": "application/json", "X-Internal-API-Key": api_key, "X-API-Key": api_key}
    results: list[dict] = []
    for index in range(0, len(matches), chunk_size):
        match_chunk = matches[index:index + chunk_size]
        ids = {str(row["match_id"]) for row in match_chunk}
        stats_chunk = [row for match_id in ids for row in stats_by_match.get(match_id, [])]
        response = requests.post(
            api_url,
            json={"dry_run": False, "matches": match_chunk, "team_match_stats": stats_chunk},
            headers=headers,
            timeout=timeout,
        )
        response.raise_for_status()
        results.append(response.json())
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--years", default="2025,2026")
    parser.add_argument("--minimum-season", type=int, default=2025)
    parser.add_argument("--cutoff", default=datetime.now(timezone.utc).isoformat())
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--api-url", default=os.environ.get(
        "NFL_HISTORY_INGESTION_URL",
        "http://127.0.0.1:4000/api/v1/internal/analytics/ingest-historical-matches",
    ))
    parser.add_argument("--api-key", default=os.environ.get("INTERNAL_API_KEY", ""))
    parser.add_argument("--evidence-dir", default=os.environ.get("NFL_HISTORY_EVIDENCE_DIR", "evidence/nfl-history"))
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--chunk-size", type=int, default=40)
    args = parser.parse_args()

    cutoff = datetime.fromisoformat(args.cutoff.replace("Z", "+00:00"))
    captured_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    events: dict[str, dict] = {}
    for year in [int(item.strip()) for item in args.years.split(",") if item.strip()]:
        for event in fetch_year(year, args.timeout):
            event_id = str(event.get("id") or "")
            if event_id and completed_event(event, args.minimum_season, cutoff):
                events[event_id] = event
    matches, team_stats = build_rows(list(events.values()), Path(args.evidence_dir), captured_at)
    summary = {
        "system_status": "NFL_HISTORY_BACKFILL_DRY_RUN" if args.dry_run else "NFL_HISTORY_BACKFILL_APPLIED",
        "captured_at": captured_at,
        "cutoff": cutoff.isoformat(),
        "events": len(events),
        "matches": len(matches),
        "team_match_stats": len(team_stats),
        "market_inputs_used": False,
        "evidence_dir": str(Path(args.evidence_dir).resolve()),
    }
    if args.dry_run:
        summary["sample"] = matches[:2]
        print(json.dumps(summary, indent=2))
        return 0
    if not args.api_key:
        raise RuntimeError("INTERNAL_API_KEY is required")
    summary["ingestion"] = post_chunks(matches, team_stats, args.api_url, args.api_key, args.timeout, args.chunk_size)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"system_status": "NFL_HISTORY_BACKFILL_FAILED", "error": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
