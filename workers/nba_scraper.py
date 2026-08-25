import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests


SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary"
SCHEDULE_LOOKBACK_DAYS = 6


def canonical_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def sha256_json(value: object) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_datetime(value: object) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


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


def event_team_ids(event: dict) -> set[str]:
    competition = (event.get("competitions") or [{}])[0]
    return {
        str((row.get("team") or {}).get("id") or row.get("id") or "")
        for row in competition.get("competitors") or []
        if str((row.get("team") or {}).get("id") or row.get("id") or "")
    }


def injury_rows(summary: dict) -> tuple[list[dict], set[str]]:
    rows: list[dict] = []
    report_team_ids: set[str] = set()
    for team_group in summary.get("injuries") or []:
        team = team_group.get("team") or {}
        team_id = str(team.get("id") or "")
        if team_id:
            report_team_ids.add(team_id)
        for item in team_group.get("injuries") or []:
            athlete = item.get("athlete") or {}
            position = athlete.get("position") or {}
            details = item.get("details") or {}
            fantasy_status = details.get("fantasyStatus") or {}
            status_type = item.get("type") or {}
            rows.append({
                "team_id": team_id,
                "team": team.get("displayName"),
                "athlete_id": str(athlete.get("id") or ""),
                "player": athlete.get("displayName") or athlete.get("fullName"),
                "position": position.get("abbreviation"),
                "status": item.get("status") or status_type.get("description"),
                "status_code": status_type.get("abbreviation"),
                "fantasy_status": fantasy_status.get("abbreviation"),
                "injury": details.get("type"),
                "detail": details.get("detail"),
                "side": details.get("side"),
                "return_date": details.get("returnDate"),
                "updated_at": item.get("date"),
            })
    return rows, report_team_ids


def official_rest_designations(injuries: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for injury in injuries:
        text = " ".join(str(injury.get(key) or "") for key in ("status", "injury", "detail")).lower()
        if "rest" in text:
            rows.append({
                "team_id": injury.get("team_id"),
                "team": injury.get("team"),
                "athlete_id": injury.get("athlete_id"),
                "player": injury.get("player"),
                "designation": "REST",
                "source_status": injury.get("status"),
                "updated_at": injury.get("updated_at"),
            })
    return rows


def starting_lineups(summary: dict) -> dict[str, list[dict]]:
    lineups: dict[str, list[dict]] = {}
    for team_group in (summary.get("boxscore") or {}).get("players") or []:
        team = team_group.get("team") or {}
        team_id = str(team.get("id") or "")
        if not team_id:
            continue
        starters: dict[str, dict] = {}
        for stat_group in team_group.get("statistics") or []:
            for item in stat_group.get("athletes") or []:
                if item.get("starter") is not True:
                    continue
                athlete = item.get("athlete") or {}
                athlete_id = str(athlete.get("id") or "")
                if not athlete_id:
                    continue
                starters[athlete_id] = {
                    "athlete_id": athlete_id,
                    "player": athlete.get("displayName"),
                    "position": (athlete.get("position") or {}).get("abbreviation"),
                    "starter": True,
                }
        lineups[team_id] = sorted(starters.values(), key=lambda row: str(row.get("athlete_id")))
    return lineups


def team_load_context(team_id: str, kickoff: datetime, events: list[dict]) -> dict:
    prior: list[tuple[datetime, str]] = []
    for candidate in events:
        candidate_id = str(candidate.get("id") or "")
        candidate_kickoff = parse_datetime(candidate.get("date"))
        if not candidate_id or candidate_kickoff is None or candidate_kickoff >= kickoff:
            continue
        if team_id in event_team_ids(candidate):
            prior.append((candidate_kickoff, candidate_id))
    prior.sort(reverse=True)
    latest = prior[0] if prior else None
    hours_since_previous = round((kickoff - latest[0]).total_seconds() / 3600, 3) if latest else None
    recent_96h = [row for row in prior if (kickoff - row[0]).total_seconds() <= 96 * 3600]
    recent_144h = [row for row in prior if (kickoff - row[0]).total_seconds() <= 144 * 3600]
    return {
        "team_id": team_id,
        "previous_event_id": latest[1] if latest else None,
        "previous_game_at": latest[0].isoformat().replace("+00:00", "Z") if latest else None,
        "hours_since_previous_game": hours_since_previous,
        "rest_days": max(0, int(hours_since_previous // 24) - 1) if hours_since_previous is not None else None,
        "back_to_back": hours_since_previous is not None and hours_since_previous < 36,
        "third_game_in_four_days": len(recent_96h) >= 2,
        "fourth_game_in_six_days": len(recent_144h) >= 3,
        "prior_games_last_96h": len(recent_96h),
        "prior_games_last_144h": len(recent_144h),
        "derivation": "espn_scoreboard_schedule_v1",
        "official_designation": False,
    }


def load_management_context(event: dict, schedule_events: list[dict], injuries: list[dict]) -> dict:
    competition = (event.get("competitions") or [{}])[0]
    kickoff = parse_datetime(competition.get("date") or event.get("date"))
    home = side(competition, "home")
    away = side(competition, "away")
    home_id = str((home.get("team") or {}).get("id") or home.get("id") or "")
    away_id = str((away.get("team") or {}).get("id") or away.get("id") or "")
    if kickoff is None or not home_id or not away_id:
        return {"complete": False, "missing_reason": "invalid_kickoff_or_team_identity"}
    return {
        "complete": True,
        "schedule_lookback_days": SCHEDULE_LOOKBACK_DAYS,
        "home": team_load_context(home_id, kickoff, schedule_events),
        "away": team_load_context(away_id, kickoff, schedule_events),
        "official_rest_designations": official_rest_designations(injuries),
        "interpretation": "schedule-derived workload risk; not an official player availability designation",
    }


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
            "model_input": False,
        })
    return observations


def build_match(
    event: dict,
    summary: dict | None,
    evidence: dict,
    schedule_events: list[dict],
    near_start_capture: bool,
    summary_error: str | None = None,
) -> dict | None:
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
    match_status = normalize_status(status_type)
    captured_at = utc_now().isoformat().replace("+00:00", "Z")
    injuries, injury_report_team_ids = injury_rows(summary or {})
    lineups = starting_lineups(summary or {})
    home_id = str(home_team.get("id") or home.get("id") or "")
    away_id = str(away_team.get("id") or away.get("id") or "")
    home_lineup = lineups.get(home_id, [])
    away_lineup = lineups.get(away_id, [])
    injury_report_present = bool(summary is not None and {home_id, away_id}.issubset(injury_report_team_ids))
    starting_lineups_confirmed = len(home_lineup) == 5 and len(away_lineup) == 5
    load_context = load_management_context(event, schedule_events, injuries)
    missing: list[str] = []
    if not injury_report_present:
        missing.append("injury_report")
    if not starting_lineups_confirmed:
        missing.append("official_starting_lineups")
    if not load_context.get("complete"):
        missing.append("load_management_context")
    if summary_error:
        missing.append("summary_capture")

    raw_data = {
        "source_match_id": f"espn-nba-{event_id}",
        "provider": "espn_site_api",
        "provider_event_id": event_id,
        "source_url": evidence.get("source_url") or f"{SCOREBOARD_URL}?dates={kickoff[:10].replace('-', '')}",
        "summary_url": f"{SUMMARY_URL}?event={event_id}" if near_start_capture else None,
        "match_date": kickoff,
        "observed_at": captured_at,
        "captured_at": captured_at,
        "provider_raw_sha256": evidence["sha256"],
        "provider_capture_path": evidence["path"],
        "season": event.get("season") or {},
        "venue": competition.get("venue") or {},
        "near_start_capture": near_start_capture,
        "summary_capture_error": summary_error,
        "injury_report_present": injury_report_present,
        "injury_context": injuries,
        "home_injuries": [row for row in injuries if row.get("team_id") == home_id],
        "away_injuries": [row for row in injuries if row.get("team_id") == away_id],
        "home_lineup": home_lineup,
        "away_lineup": away_lineup,
        "home_lineup_confirmed": len(home_lineup) == 5,
        "away_lineup_confirmed": len(away_lineup) == 5,
        "starting_lineups_confirmed": starting_lineups_confirmed,
        "lineup_ready": starting_lineups_confirmed,
        "load_management_context": load_context,
        "load_management_context_complete": bool(load_context.get("complete")),
        "team_context_complete": injury_report_present and bool(load_context.get("complete")),
        "nba_context_complete": len(missing) == 0 and match_status == "scheduled",
        "nba_context_missing": sorted(set(missing)),
        "market_observation_audit_only": audit_market_observation(event),
        "market_inputs_used": False,
        "real_candidate": 0,
        "real_money_enabled": False,
        "kelly_enabled": False,
        "telegram_auto_enabled": False,
        "autopost_enabled": False,
        "kill_switch": True,
    }
    return {
        "source_slug": "espn-nba",
        "source_match_id": f"espn-nba-{event_id}",
        "league_slug": "nba",
        "match_date": kickoff,
        "status": match_status,
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
    response = requests.get(
        url,
        params=params,
        timeout=timeout,
        headers={"Accept": "application/json"},
    )
    response.raise_for_status()
    return response.json()


def fetch_scoreboards(dates: list[datetime], evidence_dir: Path, timeout: int) -> tuple[dict[str, dict], list[dict], list[dict]]:
    payloads: dict[str, dict] = {}
    all_events: dict[str, dict] = {}
    evidence_refs: list[dict] = []
    for item in dates:
        date_key = item.strftime("%Y%m%d")
        payload = fetch_json(SCOREBOARD_URL, {"dates": date_key, "limit": 100}, timeout)
        payloads[date_key] = payload
        evidence = write_evidence(payload, evidence_dir, f"scoreboard-{date_key}")
        evidence_refs.append({"date": date_key, **evidence})
        for event in payload.get("events") or []:
            event_id = str(event.get("id") or "")
            if event_id:
                all_events[event_id] = event
    return payloads, list(all_events.values()), evidence_refs


def collect(
    target_dates: list[datetime],
    payloads: dict[str, dict],
    schedule_events: list[dict],
    schedule_evidence: list[dict],
    near_start: bool,
    evidence_dir: Path,
    timeout: int,
) -> list[dict]:
    matches: list[dict] = []
    now = utc_now()
    for item in target_dates:
        date_key = item.strftime("%Y%m%d")
        for event in (payloads.get(date_key) or {}).get("events") or []:
            event_id = str(event.get("id") or "")
            kickoff = parse_datetime(event.get("date"))
            minutes = (kickoff - now).total_seconds() / 60 if kickoff else 999999
            should_fetch_summary = near_start and 0 < minutes <= 180
            summary = None
            summary_error = None
            if should_fetch_summary:
                try:
                    summary = fetch_json(SUMMARY_URL, {"event": event_id}, timeout)
                except Exception as exc:
                    summary_error = f"{type(exc).__name__}: {exc}"
            combined = {
                "scoreboard_event": event,
                "summary": summary,
                "summary_error": summary_error,
                "schedule_scoreboard_evidence": schedule_evidence,
            }
            evidence = write_evidence(combined, evidence_dir, f"event-{event_id}")
            evidence["source_url"] = f"{SUMMARY_URL}?event={event_id}" if should_fetch_summary else f"{SCOREBOARD_URL}?dates={date_key}"
            match = build_match(
                event,
                summary,
                evidence,
                schedule_events,
                should_fetch_summary,
                summary_error,
            )
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
    parser.add_argument("--evidence-dir", default=os.environ.get("NBA_EVIDENCE_DIR", "evidence/nba"))
    parser.add_argument("--timeout", type=int, default=20)
    args = parser.parse_args()

    base_date = datetime.strptime(args.date.replace("-", ""), "%Y%m%d")
    target_dates = [base_date]
    if args.include_tomorrow:
        target_dates.append(base_date + timedelta(days=1))
    fetch_dates = [base_date - timedelta(days=days) for days in range(SCHEDULE_LOOKBACK_DAYS, 0, -1)] + target_dates
    deduped_dates = {item.strftime("%Y%m%d"): item for item in fetch_dates}
    evidence_dir = Path(args.evidence_dir)
    payloads, schedule_events, schedule_evidence = fetch_scoreboards(list(deduped_dates.values()), evidence_dir, args.timeout)
    matches = collect(target_dates, payloads, schedule_events, schedule_evidence, args.near_start, evidence_dir, args.timeout)
    rows = list({row["source_match_id"]: row for row in matches}.values())

    if args.dry_run:
        print(json.dumps({
            "mode": "dry-run",
            "dates": [item.date().isoformat() for item in target_dates],
            "near_start": args.near_start,
            "detected": len(rows),
            "matches": rows,
        }, indent=2))
        return 0
    if not args.api_key:
        raise RuntimeError("INTERNAL_API_KEY is required")
    result = post_batch(rows, args.api_url, args.api_key, args.timeout) if rows else {"processed": 0, "warnings": ["no_nba_events"]}
    print(json.dumps({
        "system_status": "NBA_PROVIDER_CAPTURE_SAFE_V1",
        "dates": [item.date().isoformat() for item in target_dates],
        "near_start": args.near_start,
        "result": result,
    }, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"system_status": "NBA_PROVIDER_CAPTURE_FAILED", "error": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
