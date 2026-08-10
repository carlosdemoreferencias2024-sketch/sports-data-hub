import argparse
import csv
import json
import time
import urllib.parse
import urllib.request
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any


MLB_API_BASE = "https://statsapi.mlb.com/api/v1"


def _get_json(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    query = urllib.parse.urlencode(params or {})
    url = f"{MLB_API_BASE}/{path.lstrip('/')}"
    if query:
        url = f"{url}?{query}"
    with urllib.request.urlopen(url, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def _norm(value: Any) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _date_from_kickoff(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("kickoff is required")
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).date().isoformat()


def _parse_kickoff(value: str) -> datetime:
    raw = str(value or "").strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _season_from_kickoff(value: str) -> str:
    return _date_from_kickoff(value).split("-")[0]


def _stat(data: dict[str, Any], key: str) -> str:
    stats = data.get("stats") or [{}]
    splits = stats[0].get("splits", [])
    if not splits:
        return ""
    value = splits[0].get("stat", {}).get(key, "")
    return "" if value is None else str(value)


def _team_stats(team_id: int, season: str) -> dict[str, str]:
    hitting = _get_json(f"teams/{team_id}/stats", {"stats": "season", "group": "hitting", "season": season})
    relief = _get_json(
        f"teams/{team_id}/stats",
        {"stats": "statSplits", "group": "pitching", "season": season, "sitCodes": "rp"},
    )
    return {
        "ops": _stat(hitting, "ops"),
        "bullpen_era": _stat(relief, "era"),
    }


def _pitcher_stats(person_id: int, season: str) -> dict[str, str]:
    data = _get_json(f"people/{person_id}/stats", {"stats": "season", "group": "pitching", "season": season})
    return {
        "era": _stat(data, "era"),
        "whip": _stat(data, "whip"),
    }


def _schedule_by_date(date: str) -> list[dict[str, Any]]:
    data = _get_json(
        "schedule",
        {
            "sportId": 1,
            "date": date,
            "hydrate": "probablePitcher,team",
        },
    )
    dates = data.get("dates", [])
    if not dates:
        return []
    return dates[0].get("games", [])


def _boxscore(game_pk: int) -> dict[str, Any]:
    return _get_json(f"game/{game_pk}/boxscore")


def _find_game(games: list[dict[str, Any]], home_team: str, away_team: str) -> dict[str, Any] | None:
    target_home = _norm(home_team)
    target_away = _norm(away_team)
    for game in games:
        home = game.get("teams", {}).get("home", {}).get("team", {}).get("name", "")
        away = game.get("teams", {}).get("away", {}).get("team", {}).get("name", "")
        if _norm(home) == target_home and _norm(away) == target_away:
            return game
    for game in games:
        home = game.get("teams", {}).get("home", {}).get("team", {}).get("name", "")
        away = game.get("teams", {}).get("away", {}).get("team", {}).get("name", "")
        if target_home in _norm(home) or _norm(home) in target_home:
            if target_away in _norm(away) or _norm(away) in target_away:
                return game
    return None


def _player_name(boxscore: dict[str, Any], side: str, person_id: str) -> str:
    players = boxscore.get("teams", {}).get(side, {}).get("players", {})
    player = players.get(f"ID{person_id}") or {}
    return str(player.get("person", {}).get("fullName") or "")


def _batting_order(boxscore: dict[str, Any], side: str) -> list[dict[str, str]]:
    team = boxscore.get("teams", {}).get(side, {})
    order = team.get("battingOrder") or []
    rows: list[dict[str, str]] = []
    for index, person_id in enumerate(order[:9], start=1):
        rows.append({"slot": str(index), "player_id": str(person_id), "name": _player_name(boxscore, side, str(person_id))})
    return rows


def _official_lineup_context(boxscore: dict[str, Any], side: str) -> dict[str, str]:
    order = _batting_order(boxscore, side)
    if len(order) >= 9:
        return {
            "lineup_confirmed": "true",
            "lineup_status": "CONFIRMED",
            "batting_order": json.dumps(order, ensure_ascii=False),
            "scratches_checked": "true",
        }
    return {
        "lineup_confirmed": "false",
        "lineup_status": "PENDING",
        "batting_order": "",
        "scratches_checked": "false",
    }


def _lineup_order_complete(context: dict[str, str]) -> bool:
    if context.get("lineup_status") != "CONFIRMED":
        return False
    try:
        return len(json.loads(context.get("batting_order") or "[]")) >= 9
    except json.JSONDecodeError:
        return False


def _combined_lineup_status(home_context: dict[str, str], away_context: dict[str, str]) -> str:
    home_complete = _lineup_order_complete(home_context)
    away_complete = _lineup_order_complete(away_context)
    if home_complete and away_complete:
        return "LINEUP_CONFIRMED_BOTH"
    if home_complete:
        return "LINEUP_CONFIRMED_HOME"
    if away_complete:
        return "LINEUP_CONFIRMED_AWAY"
    if home_context.get("lineup_status") == "PARTIAL" or away_context.get("lineup_status") == "PARTIAL":
        return "LINEUP_PARTIAL"
    if home_context.get("lineup_status") == "PENDING" or away_context.get("lineup_status") == "PENDING":
        return "LINEUP_PENDING"
    return "LINEUP_UNKNOWN"


def _pending_lineup_context() -> dict[str, str]:
    return {
        "lineup_confirmed": "false",
        "lineup_status": "PENDING",
        "batting_order": "",
        "scratches_checked": "false",
    }


def _baseball_innings_to_outs(value: Any) -> int:
    raw = str(value or "0").strip()
    if not raw:
        return 0
    whole, _, frac = raw.partition(".")
    try:
        outs = int(whole) * 3
        if frac:
            outs += int(frac[:1])
        return outs
    except ValueError:
        return 0


def _bullpen_usage_from_boxscore(boxscore: dict[str, Any], side: str) -> dict[str, Any]:
    team = boxscore.get("teams", {}).get(side, {})
    players = team.get("players", {}) or {}
    relief_outs = 0
    relievers_used = 0
    high_pitch_relief_arms = 0
    for player in players.values():
        pitching = player.get("stats", {}).get("pitching", {}) or {}
        if not pitching:
            continue
        games_started = str(pitching.get("gamesStarted", "0"))
        if games_started == "1":
            continue
        outs = _baseball_innings_to_outs(pitching.get("inningsPitched"))
        if outs <= 0:
            continue
        relievers_used += 1
        relief_outs += outs
        pitches = int(str(pitching.get("pitchesThrown", 0) or 0))
        if pitches >= 20:
            high_pitch_relief_arms += 1
    return {
        "relief_outs": relief_outs,
        "relief_innings": round(relief_outs / 3, 2),
        "relievers_used": relievers_used,
        "high_pitch_relief_arms": high_pitch_relief_arms,
    }


def _team_game_side(game: dict[str, Any], team_id: int) -> str | None:
    teams = game.get("teams", {})
    if int(teams.get("home", {}).get("team", {}).get("id", 0) or 0) == team_id:
        return "home"
    if int(teams.get("away", {}).get("team", {}).get("id", 0) or 0) == team_id:
        return "away"
    return None


def _is_final_game(game: dict[str, Any]) -> bool:
    abstract_state = str(game.get("status", {}).get("abstractGameState", "")).lower()
    detailed = str(game.get("status", {}).get("detailedState", "")).lower()
    return abstract_state == "final" or "final" in detailed


def _team_recent_context(
    team_id: int,
    game_date: date,
    schedule_cache: dict[str, list[dict[str, Any]]],
    boxscore_cache: dict[int, dict[str, Any]],
    sleep_seconds: float,
) -> dict[str, str]:
    relief_outs = 0
    relievers_used = 0
    high_pitch_relief_arms = 0
    previous_game_date: date | None = None
    games_today = 0

    today_key = game_date.isoformat()
    if today_key not in schedule_cache:
        schedule_cache[today_key] = _schedule_by_date(today_key)
        time.sleep(sleep_seconds)
    for today_game in schedule_cache.get(today_key, []):
        if _team_game_side(today_game, team_id):
            games_today += 1

    for offset in range(1, 4):
        day = game_date - timedelta(days=offset)
        key = day.isoformat()
        if key not in schedule_cache:
            schedule_cache[key] = _schedule_by_date(key)
            time.sleep(sleep_seconds)
        for game in schedule_cache.get(key, []):
            side = _team_game_side(game, team_id)
            if not side or not _is_final_game(game):
                continue
            if previous_game_date is None:
                previous_game_date = day
            game_pk = int(game.get("gamePk"))
            if game_pk not in boxscore_cache:
                boxscore_cache[game_pk] = _boxscore(game_pk)
                time.sleep(sleep_seconds)
            usage = _bullpen_usage_from_boxscore(boxscore_cache[game_pk], side)
            relief_outs += int(usage["relief_outs"])
            relievers_used += int(usage["relievers_used"])
            high_pitch_relief_arms += int(usage["high_pitch_relief_arms"])

    bullpen_innings = round(relief_outs / 3, 2)
    fatigue_score = min(100, round((bullpen_innings * 9) + (high_pitch_relief_arms * 8) + max(0, relievers_used - 6) * 3))
    days_rest = "" if previous_game_date is None else str((game_date - previous_game_date).days - 1)
    return {
        "bullpen_last_72h_innings": str(bullpen_innings),
        "bullpen_last_72h_relievers_used": str(relievers_used),
        "bullpen_high_pitch_arms_last_72h": str(high_pitch_relief_arms),
        "bullpen_fatigue_score": str(fatigue_score),
        "bullpen_context_fresh": "true",
        "rest_days": days_rest,
        "doubleheader_status": "DOUBLEHEADER" if games_today > 1 else "NONE",
        "travel_rest_context_complete": "true" if days_rest != "" else "false",
    }


def _missing_feature_context(row: dict[str, str]) -> list[str]:
    missing: list[str] = []
    if not row.get("probable_pitcher_home"):
        missing.append("probable_pitcher_home")
    if not row.get("probable_pitcher_away"):
        missing.append("probable_pitcher_away")
    if not row.get("home_era") or not row.get("home_whip"):
        missing.append("home_pitcher_stats")
    if not row.get("away_era") or not row.get("away_whip"):
        missing.append("away_pitcher_stats")
    if not row.get("home_ops"):
        missing.append("home_ops")
    if not row.get("away_ops"):
        missing.append("away_ops")
    if not row.get("home_bullpen_era"):
        missing.append("home_bullpen_era")
    if not row.get("away_bullpen_era"):
        missing.append("away_bullpen_era")
    if row.get("lineup_status") != "LINEUP_CONFIRMED_BOTH":
        missing.append("lineup_context")
    if row.get("batting_order_complete") != "true":
        missing.append("batting_order_complete")
    if row.get("post_kickoff_observation") == "true":
        missing.append("post_kickoff_audit_only")
    if row.get("home_bullpen_context_fresh") != "true" or row.get("away_bullpen_context_fresh") != "true":
        missing.append("bullpen_last_72h")
    if row.get("travel_rest_context_complete") != "true":
        missing.append("travel_rest")
    return missing


def fill_csv(input_path: str, output_path: str, sleep_seconds: float, allow_partial: bool) -> dict[str, Any]:
    input_file = Path(input_path)
    output_file = Path(output_path)
    rows: list[dict[str, str]] = []
    schedule_cache: dict[str, list[dict[str, Any]]] = {}
    boxscore_cache: dict[int, dict[str, Any]] = {}
    team_cache: dict[tuple[int, str], dict[str, str]] = {}
    pitcher_cache: dict[tuple[int, str], dict[str, str]] = {}
    filled = 0
    skipped = 0
    errors: list[dict[str, Any]] = []

    with input_file.open(newline="", encoding="utf-8") as file:
        reader = csv.DictReader(file)
        fieldnames = list(reader.fieldnames or [])
        for extra_field in (
            "feature_completeness",
            "missing_context",
            "mlb_game_pk",
            "home_pitcher_id",
            "away_pitcher_id",
            "home_pitcher_status",
            "away_pitcher_status",
            "pitcher_team_mapping_valid",
            "lineup_status",
            "batting_order_complete",
            "home_lineup_confirmed",
            "home_lineup_status",
            "home_batting_order_complete",
            "away_lineup_status",
            "away_lineup_confirmed",
            "away_batting_order_complete",
            "home_batting_order",
            "away_batting_order",
            "home_scratches_checked",
            "away_scratches_checked",
            "home_rest_days",
            "away_rest_days",
            "home_bullpen_last_72h_innings",
            "away_bullpen_last_72h_innings",
            "home_bullpen_last_72h_relievers_used",
            "away_bullpen_last_72h_relievers_used",
            "home_bullpen_high_pitch_arms_last_72h",
            "away_bullpen_high_pitch_arms_last_72h",
            "home_bullpen_fatigue_score",
            "away_bullpen_fatigue_score",
            "home_bullpen_context_fresh",
            "away_bullpen_context_fresh",
            "doubleheader_status",
            "travel_rest_context_complete",
            "near_start_window",
            "scheduled_start",
            "original_scheduled_start",
            "official_game_date",
            "kickoff_drift_minutes",
            "kickoff_corrected_from_provider",
            "provider_observed_at",
            "ingested_at",
            "actual_first_pitch",
            "minutes_before_start",
            "post_kickoff_observation",
            "audit_only_context",
            "source_confidence_score",
            "source",
            "source_url",
            "verified_at",
        ):
            if extra_field not in fieldnames:
                fieldnames.append(extra_field)
        for line_number, row in enumerate(reader, start=2):
            try:
                kickoff = _parse_kickoff(row.get("kickoff", ""))
                original_kickoff = kickoff
                date = kickoff.date().isoformat()
                season = _season_from_kickoff(row.get("kickoff", ""))
                if date not in schedule_cache:
                    schedule_cache[date] = _schedule_by_date(date)
                    time.sleep(sleep_seconds)
                game = _find_game(schedule_cache[date], row.get("home_team", ""), row.get("away_team", ""))
                if not game:
                    skipped += 1
                    errors.append({"line": line_number, "reason": "mlb_game_not_found", "match": f"{row.get('home_team')} vs {row.get('away_team')}"})
                    rows.append(row)
                    continue

                official_game_date = str(game.get("gameDate") or "").strip()
                kickoff_drift_minutes = 0.0
                if official_game_date:
                    official_kickoff = _parse_kickoff(official_game_date)
                    kickoff_drift_minutes = round((official_kickoff - original_kickoff).total_seconds() / 60, 2)
                    kickoff = official_kickoff
                    date = kickoff.date().isoformat()
                    season = str(kickoff.year)

                home = game["teams"]["home"]
                away = game["teams"]["away"]
                home_team_id = int(home["team"]["id"])
                away_team_id = int(away["team"]["id"])
                game_pk = int(game.get("gamePk"))
                boxscore = {}
                try:
                    boxscore = _boxscore(game_pk)
                    time.sleep(sleep_seconds)
                except Exception:
                    boxscore = {}
                home_team_stats = team_cache.setdefault((home_team_id, season), _team_stats(home_team_id, season))
                time.sleep(sleep_seconds)
                away_team_stats = team_cache.setdefault((away_team_id, season), _team_stats(away_team_id, season))
                time.sleep(sleep_seconds)

                home_pitcher = home.get("probablePitcher") or {}
                away_pitcher = away.get("probablePitcher") or {}
                home_pitching = {"era": "", "whip": ""}
                away_pitching = {"era": "", "whip": ""}

                if home_pitcher.get("id"):
                    home_pitcher_id = int(home_pitcher["id"])
                    home_pitching = pitcher_cache.setdefault((home_pitcher_id, season), _pitcher_stats(home_pitcher_id, season))
                    time.sleep(sleep_seconds)
                if away_pitcher.get("id"):
                    away_pitcher_id = int(away_pitcher["id"])
                    away_pitching = pitcher_cache.setdefault((away_pitcher_id, season), _pitcher_stats(away_pitcher_id, season))
                    time.sleep(sleep_seconds)

                observed_at = datetime.now(UTC)
                minutes_before_start = round((kickoff - observed_at).total_seconds() / 60, 2)
                post_kickoff_observation = minutes_before_start < 0
                home_lineup = _official_lineup_context(boxscore, "home") if boxscore else _official_lineup_context({}, "home")
                away_lineup = _official_lineup_context(boxscore, "away") if boxscore else _official_lineup_context({}, "away")
                if post_kickoff_observation:
                    # Post-start boxscores are useful for audit, but cannot alter pregame confirmation.
                    home_lineup = _pending_lineup_context()
                    away_lineup = _pending_lineup_context()
                home_recent = _team_recent_context(home_team_id, kickoff.date(), schedule_cache, boxscore_cache, sleep_seconds)
                away_recent = _team_recent_context(away_team_id, kickoff.date(), schedule_cache, boxscore_cache, sleep_seconds)
                hours_to_kickoff = minutes_before_start / 60
                if hours_to_kickoff <= 1:
                    near_start_window = "FINAL_60_MIN"
                elif hours_to_kickoff <= 3:
                    near_start_window = "THREE_TO_ONE_HOURS"
                elif hours_to_kickoff <= 6:
                    near_start_window = "SIX_TO_THREE_HOURS"
                else:
                    near_start_window = "EARLY"

                pitcher_mapping_valid = bool(home_pitcher.get("id") and away_pitcher.get("id"))
                lineup_status = _combined_lineup_status(home_lineup, away_lineup)
                home_batting_complete = _lineup_order_complete(home_lineup)
                away_batting_complete = _lineup_order_complete(away_lineup)
                batting_order_complete = home_batting_complete and away_batting_complete
                source_confidence_score = 70
                if pitcher_mapping_valid:
                    source_confidence_score += 10
                if home_recent["bullpen_context_fresh"] == "true" and away_recent["bullpen_context_fresh"] == "true":
                    source_confidence_score += 5
                if home_recent["travel_rest_context_complete"] == "true" and away_recent["travel_rest_context_complete"] == "true":
                    source_confidence_score += 5
                if lineup_status == "LINEUP_CONFIRMED_BOTH":
                    source_confidence_score += 10
                if post_kickoff_observation:
                    source_confidence_score = min(source_confidence_score, 70)
                source_confidence_score = min(source_confidence_score, 95)
                row["probable_pitcher_home"] = home_pitcher.get("fullName", "")
                row["probable_pitcher_away"] = away_pitcher.get("fullName", "")
                row["home_pitcher_id"] = str(home_pitcher.get("id") or "")
                row["away_pitcher_id"] = str(away_pitcher.get("id") or "")
                row["home_pitcher_status"] = "PROBABLE" if home_pitcher.get("id") else "UNKNOWN"
                row["away_pitcher_status"] = "PROBABLE" if away_pitcher.get("id") else "UNKNOWN"
                row["pitcher_team_mapping_valid"] = "true" if pitcher_mapping_valid else "false"
                row["home_era"] = home_pitching["era"]
                row["home_whip"] = home_pitching["whip"]
                row["home_ops"] = home_team_stats["ops"]
                row["home_bullpen_era"] = home_team_stats["bullpen_era"]
                row["lineup_status"] = lineup_status
                row["batting_order_complete"] = "true" if batting_order_complete else "false"
                row["home_lineup_confirmed"] = home_lineup["lineup_confirmed"]
                row["home_lineup_status"] = home_lineup["lineup_status"]
                row["home_batting_order_complete"] = "true" if home_batting_complete else "false"
                row["home_batting_order"] = home_lineup["batting_order"]
                row["home_scratches_checked"] = home_lineup["scratches_checked"]
                row["home_bullpen_last_72h_innings"] = home_recent["bullpen_last_72h_innings"]
                row["home_bullpen_last_72h_relievers_used"] = home_recent["bullpen_last_72h_relievers_used"]
                row["home_bullpen_high_pitch_arms_last_72h"] = home_recent["bullpen_high_pitch_arms_last_72h"]
                row["home_bullpen_fatigue_score"] = home_recent["bullpen_fatigue_score"]
                row["home_bullpen_context_fresh"] = home_recent["bullpen_context_fresh"]
                row["home_rest_days"] = home_recent["rest_days"]
                row["away_era"] = away_pitching["era"]
                row["away_whip"] = away_pitching["whip"]
                row["away_ops"] = away_team_stats["ops"]
                row["away_bullpen_era"] = away_team_stats["bullpen_era"]
                row["away_lineup_confirmed"] = away_lineup["lineup_confirmed"]
                row["away_lineup_status"] = away_lineup["lineup_status"]
                row["away_batting_order_complete"] = "true" if away_batting_complete else "false"
                row["away_batting_order"] = away_lineup["batting_order"]
                row["away_scratches_checked"] = away_lineup["scratches_checked"]
                row["away_bullpen_last_72h_innings"] = away_recent["bullpen_last_72h_innings"]
                row["away_bullpen_last_72h_relievers_used"] = away_recent["bullpen_last_72h_relievers_used"]
                row["away_bullpen_high_pitch_arms_last_72h"] = away_recent["bullpen_high_pitch_arms_last_72h"]
                row["away_bullpen_fatigue_score"] = away_recent["bullpen_fatigue_score"]
                row["away_bullpen_context_fresh"] = away_recent["bullpen_context_fresh"]
                row["away_rest_days"] = away_recent["rest_days"]
                row["mlb_game_pk"] = str(game_pk)
                row["doubleheader_status"] = "DOUBLEHEADER" if "DOUBLEHEADER" in {home_recent["doubleheader_status"], away_recent["doubleheader_status"]} else "NONE"
                row["travel_rest_context_complete"] = "true" if home_recent["travel_rest_context_complete"] == "true" and away_recent["travel_rest_context_complete"] == "true" else "false"
                row["near_start_window"] = near_start_window
                row["scheduled_start"] = kickoff.isoformat()
                row["original_scheduled_start"] = original_kickoff.isoformat()
                row["official_game_date"] = kickoff.isoformat()
                row["kickoff_drift_minutes"] = str(kickoff_drift_minutes)
                row["kickoff_corrected_from_provider"] = "true" if abs(kickoff_drift_minutes) > 5 else "false"
                row["provider_observed_at"] = observed_at.isoformat()
                row["ingested_at"] = observed_at.isoformat()
                row["actual_first_pitch"] = ""
                row["minutes_before_start"] = str(minutes_before_start)
                row["post_kickoff_observation"] = "true" if post_kickoff_observation else "false"
                row["audit_only_context"] = "true" if post_kickoff_observation else "false"
                row["source_confidence_score"] = str(source_confidence_score)
                row["source"] = "mlb_stats_api"
                row["source_url"] = f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&date={date}&hydrate=probablePitcher,team"
                row["verified_at"] = observed_at.isoformat()
                missing_context = _missing_feature_context(row)
                row["feature_completeness"] = "complete" if not missing_context else "partial"
                row["missing_context"] = ";".join(missing_context)
                if missing_context and not allow_partial:
                    skipped += 1
                    errors.append(
                        {
                            "line": line_number,
                            "reason": "probable_pitcher_missing",
                            "match": f"{row.get('home_team')} vs {row.get('away_team')}",
                            "missing_context": missing_context,
                        }
                    )
                    rows.append(row)
                    continue

                filled += 1
                rows.append(row)
            except Exception as exc:
                skipped += 1
                errors.append({"line": line_number, "reason": type(exc).__name__, "detail": str(exc)})
                rows.append(row)

    with output_file.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    return {
        "input": str(input_file),
        "output": str(output_file),
        "filled": filled,
        "skipped": skipped,
        "errors": errors[:20],
        "source": "mlb_stats_api",
        "allow_partial": allow_partial,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Fill MLB matchup feature CSV with real MLB Stats API pitcher/team data.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--sleep-seconds", type=float, default=0.05)
    parser.add_argument("--allow-partial", action="store_true", help="Write verified partial team context when probable pitchers are incomplete.")
    args = parser.parse_args()
    print(json.dumps(fill_csv(args.input, args.output, args.sleep_seconds, args.allow_partial), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
