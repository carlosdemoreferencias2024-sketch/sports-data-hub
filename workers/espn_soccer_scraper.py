from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone

import requests


ESPN_LEAGUES = {
    "mls": "usa.1",
    "liga-mx": "mex.1",
    "fifa-world-cup-2026": "fifa.world",
    "nwsl": "usa.nwsl",
    "brasileirao-serie-a": "bra.1",
    "argentina-primera-division": "arg.1",
    "uefa-champions-league": "uefa.champions",
    "europa-league": "uefa.europa",
    "conference-league": "uefa.europa.conf",
    "leagues-cup": "concacaf.leagues.cup",
    "copa-libertadores": "conmebol.libertadores",
    "copa-sudamericana": "conmebol.sudamericana",
    "premier-league": "eng.1",
    "la-liga": "esp.1",
    "serie-a": "ita.1",
    "bundesliga": "ger.1",
    "ligue-1": "fra.1",
}
SITE_ROOT = "https://site.api.espn.com/apis/site/v2/sports/soccer"
TEAM_CANONICAL_ALIASES = {
    "atleticoparanaense": "athleticoparanaense",
    "athleticopr": "athleticoparanaense",
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_team(value: object) -> str:
    decomposed = unicodedata.normalize("NFKD", str(value or ""))
    ascii_value = "".join(character for character in decomposed if not unicodedata.combining(character))
    return re.sub(r"[^a-z0-9]", "", ascii_value.lower())


def canonical_team(value: object) -> str:
    normalized = normalize_team(value)
    return TEAM_CANONICAL_ALIASES.get(normalized, normalized)


def team_match_score(expected: str, team: dict) -> int:
    target = canonical_team(expected)
    actuals = {
        canonical_team(value)
        for value in [team.get("name"), *(team.get("aliases") or [])]
        if canonical_team(value)
    }
    abbreviation = normalize_team(team.get("abbreviation"))
    if not target or not actuals:
        return 0
    if target in actuals:
        return 100

    score = 0
    if any(target in actual or actual in target for actual in actuals):
        score = max(score, 40)
    if len(abbreviation) >= 2 and target.startswith(abbreviation):
        score = max(score, 25)
    return score


def team_name_matches(expected: str, team: dict) -> bool:
    return team_match_score(expected, team) > 0


def parse_datetime(value: object) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def parse_score(value: object) -> int | None:
    if isinstance(value, dict):
        value = value.get("value") or value.get("displayValue")
    try:
        return int(float(str(value)))
    except (TypeError, ValueError):
        return None


def american_number(value: object) -> int:
    if isinstance(value, dict):
        value = value.get("odds") or value.get("american") or value.get("value")
    text = str(value or "").strip().replace("+", "")
    if not re.fullmatch(r"-?\d+", text):
        raise RuntimeError("MARKET_PRICE_INVALID")
    result = int(text)
    if -100 < result < 100:
        raise RuntimeError("MARKET_PRICE_INVALID")
    return result


def american_to_decimal(value: int) -> float:
    if value >= 100:
        return round(1 + value / 100, 6)
    if value <= -100:
        return round(1 + 100 / abs(value), 6)
    raise RuntimeError("MARKET_PRICE_INVALID")


def fetch_json(url: str, timeout: int) -> dict:
    response = requests.get(url, timeout=timeout, headers={"Accept": "application/json"})
    response.raise_for_status()
    return response.json()


def competition_for(event: dict) -> dict:
    rows = event.get("competitions") or []
    return rows[0] if rows else {}


def side(competition: dict, home_away: str) -> dict:
    return next((row for row in competition.get("competitors") or [] if row.get("homeAway") == home_away), {})


def team_context(row: dict) -> dict:
    team = row.get("team") or {}
    aliases = [
        str(team.get(field) or "").strip()
        for field in ("displayName", "shortDisplayName", "name", "location", "nickname")
    ]
    return {
        "id": str(team.get("id") or row.get("id") or ""),
        "name": str(team.get("displayName") or team.get("name") or team.get("location") or "").strip(),
        "abbreviation": str(team.get("abbreviation") or "").strip(),
        "aliases": list(dict.fromkeys(alias for alias in aliases if alias)),
    }


def event_context(event: dict, league_slug: str, allow_post_kickoff: bool = False) -> dict:
    competition = competition_for(event)
    home = team_context(side(competition, "home"))
    away = team_context(side(competition, "away"))
    kickoff_raw = competition.get("date") or event.get("date")
    if not home["id"] or not away["id"] or not home["name"] or not away["name"] or not kickoff_raw:
        raise RuntimeError("EVENT_IDENTITY_INCOMPLETE")
    status_type = (competition.get("status") or event.get("status") or {}).get("type") or {}
    state = str(status_type.get("state") or "").lower()
    if not allow_post_kickoff and (state != "pre" or bool(status_type.get("completed"))):
        raise RuntimeError(f"POST_KICKOFF_AUDIT_ONLY: state={state or 'unknown'}")
    return {
        "event_id": str(event.get("id") or competition.get("id") or ""),
        "league_slug": league_slug,
        "league_name": str((event.get("league") or {}).get("name") or league_slug),
        "home": home,
        "away": away,
        "kickoff": parse_datetime(kickoff_raw),
        "competition": competition,
        "status": "scheduled",
    }


def scoreboard_url(league_slug: str, date_key: str) -> str:
    return f"{SITE_ROOT}/{league_slug}/scoreboard?dates={date_key}&limit=100"


def league_provider_slugs(league_slug: str | None) -> list[str]:
    if not league_slug:
        return list(dict.fromkeys(ESPN_LEAGUES.values()))

    normalized = str(league_slug).strip().lower()
    if normalized in ESPN_LEAGUES:
        return [ESPN_LEAGUES[normalized]]
    if normalized in ESPN_LEAGUES.values():
        return [normalized]
    raise RuntimeError(f"ESPN_LEAGUE_UNSUPPORTED: {league_slug}")


def discover_event(
    date_key: str,
    expected_home: str,
    expected_away: str,
    timeout: int,
    league_slug: str | None = None,
    ambiguity_margin: int = 30,
    allow_post_kickoff: bool = False,
) -> tuple[dict, dict, str]:
    candidates_by_identity: dict[str, dict] = {}
    for provider_slug in league_provider_slugs(league_slug):
        url = scoreboard_url(provider_slug, date_key)
        payload = fetch_json(url, timeout)
        for event in payload.get("events") or []:
            try:
                context = event_context(event, provider_slug, allow_post_kickoff=allow_post_kickoff)
            except RuntimeError:
                continue

            home_score = team_match_score(expected_home, context["home"])
            away_score = team_match_score(expected_away, context["away"])
            if home_score == 0 or away_score == 0:
                continue

            identity = context["event_id"] or "|".join((
                provider_slug,
                normalize_team(context["home"]["name"]),
                normalize_team(context["away"]["name"]),
                iso_z(context["kickoff"]),
            ))
            candidate = {
                "score": home_score + away_score,
                "event": event,
                "payload": payload,
                "url": url,
            }
            current = candidates_by_identity.get(identity)
            if current is None or candidate["score"] > current["score"]:
                candidates_by_identity[identity] = candidate

    candidates = sorted(candidates_by_identity.values(), key=lambda row: row["score"], reverse=True)
    if not candidates:
        raise RuntimeError("ESPN_EVENT_NOT_FOUND")

    best = candidates[0]
    best_score = int(best["score"])
    second_score = int(candidates[1]["score"]) if len(candidates) > 1 else 0
    tied_at_top = sum(1 for candidate in candidates if candidate["score"] == best_score)

    if best_score == 200 and tied_at_top == 1:
        return best["event"], best["payload"], best["url"]
    if best_score >= 80 and tied_at_top == 1 and best_score - second_score >= ambiguity_margin:
        return best["event"], best["payload"], best["url"]
    raise RuntimeError("ESPN_EVENT_NOT_FOUND_OR_AMBIGUOUS")


def moneyline_market(event: dict, bookmaker: str) -> dict:
    competition = competition_for(event)
    selected = next((row for row in competition.get("odds") or [] if str((row.get("provider") or {}).get("name") or "").lower() == bookmaker.lower()), None)
    if selected is None:
        raise RuntimeError("MARKET_BOOKMAKER_MISSING")
    market = selected.get("moneyline") or {}
    values: dict[str, int] = {}
    for selection in ("home", "draw", "away"):
        row = market.get(selection) or {}
        current = row.get("close") or row.get("current") or row
        values[selection] = american_number(current)
    return {
        "bookmaker": str((selected.get("provider") or {}).get("name") or bookmaker),
        "provider_id": str((selected.get("provider") or {}).get("id") or ""),
        "home_american": values["home"],
        "draw_american": values["draw"],
        "away_american": values["away"],
        "home_decimal": american_to_decimal(values["home"]),
        "draw_decimal": american_to_decimal(values["draw"]),
        "away_decimal": american_to_decimal(values["away"]),
    }


def find_browsers(explicit: str | None) -> list[Path]:
    candidates = [
        explicit,
        os.environ.get("CHROME_PATH"),
        shutil.which("msedge.exe"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        shutil.which("chrome.exe"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ]
    browsers: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        key = str(path.resolve()).casefold() if path.is_file() else str(path).casefold()
        if path.is_file() and key not in seen:
            seen.add(key)
            browsers.append(path)
    if browsers:
        return browsers
    raise RuntimeError("CHROME_EXECUTABLE_NOT_FOUND")


def capture_screenshot(browsers: list[Path], url: str, output: Path, timeout: int) -> None:
    errors: list[str] = []
    for browser in browsers:
        for headless_mode in ("--headless=new", "--headless"):
            output.unlink(missing_ok=True)
            with tempfile.TemporaryDirectory(prefix="sdh-soccer-browser-") as profile:
                command = [
                    str(browser), headless_mode, "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
                    "--disable-background-networking", "--disable-component-update", "--disable-extensions",
                    "--disable-sync", "--no-first-run", "--no-default-browser-check",
                    "--force-device-scale-factor=0.75", "--window-size=1920,5000",
                    f"--user-data-dir={profile}", f"--screenshot={output}", url,
                ]
                try:
                    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
                except subprocess.TimeoutExpired:
                    errors.append(f"{browser.name}:{headless_mode}:timeout")
                    continue
            if result.returncode == 0 and output.is_file() and output.stat().st_size >= 1000:
                return
            message = (result.stderr or result.stdout or "empty screenshot").strip()
            errors.append(f"{browser.name}:{headless_mode}:exit={result.returncode}:{message[-200:]}")
    raise RuntimeError(f"SCREENSHOT_CAPTURE_FAILED: {' | '.join(errors)[-1000:]}")


def write_market_render(path: Path, source_url: str, context: dict, market: dict, provider_raw_sha: str, rendered_at: str) -> None:
    rows = "".join(
        f"<tr><td>{selection.title()}</td><td>{market[f'{selection}_american']:+d}</td><td>{market[f'{selection}_decimal']:.6f}</td></tr>"
        for selection in ("home", "draw", "away")
    )
    values = {
        "source_url": html.escape(source_url),
        "event_id": html.escape(context["event_id"]),
        "competition": html.escape(context["league_slug"]),
        "home": html.escape(context["home"]["name"]),
        "away": html.escape(context["away"]["name"]),
        "kickoff": html.escape(iso_z(context["kickoff"])),
        "bookmaker": html.escape(market["bookmaker"]),
        "rendered_at": html.escape(rendered_at),
        "provider_raw_sha": html.escape(provider_raw_sha),
    }
    document = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sports Data Hub source capture</title>
<style>
body {{ font-family: Arial, sans-serif; margin: 36px; color: #111; }}
h1 {{ font-size: 28px; margin: 0 0 24px; }}
.meta {{ display: grid; grid-template-columns: 180px 1fr; gap: 8px 16px; max-width: 1200px; }}
.label {{ font-weight: 700; }}
table {{ border-collapse: collapse; margin-top: 28px; min-width: 620px; }}
th, td {{ border: 1px solid #777; padding: 10px 14px; text-align: left; }}
th {{ background: #eee; }}
.hash, .url {{ font-family: Consolas, monospace; overflow-wrap: anywhere; }}
.notice {{ margin-top: 28px; padding: 12px; border-left: 5px solid #b7791f; background: #fff8e1; max-width: 900px; }}
</style></head><body>
<h1>ESPN public odds capture</h1>
<div class="meta">
<div class="label">Source URL</div><div class="url">{values['source_url']}</div>
<div class="label">Provider event</div><div>{values['event_id']}</div>
<div class="label">Competition</div><div>{values['competition']}</div>
<div class="label">Match</div><div>{values['away']} @ {values['home']}</div>
<div class="label">Kickoff UTC</div><div>{values['kickoff']}</div>
<div class="label">Bookmaker</div><div>{values['bookmaker']}</div>
<div class="label">Observed UTC</div><div>{values['rendered_at']}</div>
<div class="label">Raw JSON SHA-256</div><div class="hash">{values['provider_raw_sha']}</div>
</div>
<table><thead><tr><th>Selection</th><th>American</th><th>Decimal</th></tr></thead><tbody>{rows}</tbody></table>
<div class="notice">Machine-rendered from the second HTTP payload. Human verification is required before import or ticket registration.</div>
</body></html>"""
    path.write_text(document, encoding="utf-8")


def write_raw_evidence(value: object, root: Path, label: str) -> tuple[str, str]:
    raw = canonical_json(value)
    digest = sha256_text(raw)
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{label}-{digest[:16]}.json"
    if not path.exists():
        path.write_text(raw, encoding="utf-8")
    return digest, str(path.resolve())


def schedule_url(league_slug: str, team_id: str, season: int) -> str:
    return f"{SITE_ROOT}/{league_slug}/teams/{team_id}/schedule?season={season}"


def completed_history_events(context: dict, timeout: int) -> tuple[list[dict], list[dict]]:
    events: dict[str, dict] = {}
    captures: list[dict] = []
    for team in (context["home"], context["away"]):
        url = schedule_url(context["league_slug"], team["id"], context["kickoff"].year)
        payload = fetch_json(url, timeout)
        captures.append({"url": url, "payload": payload})
        for event in payload.get("events") or []:
            competition = competition_for(event)
            status_type = (competition.get("status") or {}).get("type") or {}
            played_at_raw = competition.get("date") or event.get("date")
            if not played_at_raw or not bool(status_type.get("completed")):
                continue
            if parse_datetime(played_at_raw) >= context["kickoff"]:
                continue
            event_id = str(event.get("id") or competition.get("id") or "")
            if event_id:
                events[event_id] = event
    return list(events.values()), captures


def build_history_rows(context: dict, events: list[dict], captures: list[dict], evidence_root: Path) -> tuple[list[dict], list[dict]]:
    captured_at = iso_z(utc_now())
    capture_sha, capture_path = write_raw_evidence(captures, evidence_root, f"history-{context['event_id']}")
    matches: list[dict] = []
    team_stats: list[dict] = []
    canonical_names = {
        context["home"]["id"]: context.get("expected_home") or context["home"]["name"],
        context["away"]["id"]: context.get("expected_away") or context["away"]["name"],
    }
    for event in sorted(events, key=lambda row: str(competition_for(row).get("date") or row.get("date") or "")):
        competition = competition_for(event)
        home_row = side(competition, "home")
        away_row = side(competition, "away")
        home = team_context(home_row)
        away = team_context(away_row)
        home["name"] = canonical_names.get(home["id"], home["name"])
        away["name"] = canonical_names.get(away["id"], away["name"])
        home_score = parse_score(home_row.get("score"))
        away_score = parse_score(away_row.get("score"))
        kickoff = str(competition.get("date") or event.get("date") or "")
        event_id = str(event.get("id") or competition.get("id") or "")
        if not event_id or not kickoff or home_score is None or away_score is None:
            continue
        raw = {
            "provider": "espn_site_api",
            "provider_event_id": event_id,
            "provider_raw_sha256": capture_sha,
            "provider_capture_path": capture_path,
            "source_url": schedule_url(context["league_slug"], context["home"]["id"], context["kickoff"].year),
            "captured_at": captured_at,
            "capture_mode": "LIVE_FORWARD_HISTORICAL_BACKFILL",
            "no_post_event_market_data_used": True,
            "market_inputs_used": False,
        }
        match_id = f"espn-soccer-history-{event_id}"
        result = "DRAW" if home_score == away_score else "HOME" if home_score > away_score else "AWAY"
        matches.append({
            "match_id": match_id,
            "provider_match_id": event_id,
            "canonical_match_id": match_id,
            "sport": "soccer",
            "league_id": context["league_slug"],
            "competition_id": context["league_slug"],
            "season": str((event.get("season") or {}).get("year") or context["kickoff"].year),
            "match_date": kickoff,
            "kickoff": kickoff,
            "home_team_id": home["id"],
            "away_team_id": away["id"],
            "home_team_name": home["name"],
            "away_team_name": away["name"],
            "status": "FINAL",
            "home_score": home_score,
            "away_score": away_score,
            "result": result,
            "competition_type": "official",
            "match_importance": "official",
            "is_official": True,
            "is_friendly": False,
            "venue": (competition.get("venue") or {}).get("fullName"),
            "neutral_venue": bool(competition.get("neutralSite")),
            "source": "espn_soccer_site_api",
            "source_confidence_score": 90,
            "source_observed_at": captured_at,
            "raw_data": raw,
        })
        for is_home, team, opponent, goals_for, goals_against in (
            (True, home, away, home_score, away_score),
            (False, away, home, away_score, home_score),
        ):
            team_stats.append({
                "match_id": match_id,
                "sport": "soccer",
                "league_id": context["league_slug"],
                "season": str((event.get("season") or {}).get("year") or context["kickoff"].year),
                "team_id": team["id"],
                "team_name": team["name"],
                "opponent_team_id": opponent["id"],
                "opponent_team": opponent["name"],
                "is_home": is_home,
                "is_neutral": bool(competition.get("neutralSite")),
                "result": "W" if goals_for > goals_against else "D" if goals_for == goals_against else "L",
                "points_for": goals_for,
                "points_against": goals_against,
                "won": goals_for > goals_against,
                "drew": goals_for == goals_against,
                "lost": goals_for < goals_against,
                "source": "espn_soccer_site_api",
                "source_confidence_score": 90,
                "raw_data": raw,
            })
    return matches, team_stats


def post_history(matches: list[dict], team_stats: list[dict], api_url: str, api_key: str, timeout: int) -> dict:
    if not api_key:
        raise RuntimeError("INTERNAL_API_KEY_REQUIRED")
    response = requests.post(
        api_url,
        json={"dry_run": False, "matches": matches, "team_match_stats": team_stats},
        headers={"Content-Type": "application/json", "X-Internal-API-Key": api_key, "X-API-Key": api_key},
        timeout=timeout,
    )
    response.raise_for_status()
    return response.json()


def market_capture(args: argparse.Namespace, event: dict, initial_payload: dict, source_url: str, context: dict) -> dict:
    now = utc_now()
    minutes = (context["kickoff"] - now).total_seconds() / 60
    if args.snapshot_type == "current" and not 20 <= minutes <= 1440:
        raise RuntimeError(f"OUTSIDE_CURRENT_WINDOW: minutes_to_kickoff={minutes:.1f}")
    if args.snapshot_type == "closing" and not 3 <= minutes <= 10:
        raise RuntimeError(f"OUTSIDE_CLOSING_WINDOW: minutes_to_kickoff={minutes:.1f}")
    market_before = moneyline_market(event, args.bookmaker)
    stamp = utc_now()
    output_dir = Path(args.output_root) / stamp.strftime("%Y-%m-%d") / stamp.strftime("%H%M%S")
    output_dir.mkdir(parents=True, exist_ok=True)
    screenshot_path = output_dir / f"espn_soccer__{context['event_id']}__{args.snapshot_type}_odds.png"
    payload_after = fetch_json(source_url, args.timeout)
    event_after = next((row for row in payload_after.get("events") or [] if str(row.get("id")) == context["event_id"]), None)
    if event_after is None:
        raise RuntimeError("EVENT_DISAPPEARED_DURING_CAPTURE")
    market_after = moneyline_market(event_after, args.bookmaker)
    price_fields = ("home_american", "draw_american", "away_american", "bookmaker")
    if any(market_before[key] != market_after[key] for key in price_fields):
        raise RuntimeError("MARKET_MOVED_DURING_CAPTURE")
    provider_raw_sha = sha256_text(canonical_json(payload_after))
    render_path = output_dir / f"espn_soccer__{context['event_id']}__{args.snapshot_type}_odds.html"
    write_market_render(render_path, source_url, context, market_after, provider_raw_sha, iso_z(stamp))
    capture_screenshot(find_browsers(args.chrome_path), render_path.resolve().as_uri(), screenshot_path, args.browser_timeout)
    captured_at = utc_now()
    screenshot_sha = sha256_file(screenshot_path)
    odds_rows = [
        {"market_type": "moneyline_3way", "selection": side_name, "american_odds": market_after[f"{side_name}_american"], "decimal_odds": market_after[f"{side_name}_decimal"], "odds_format": "decimal"}
        for side_name in ("home", "draw", "away")
    ]
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
        "odds": odds_rows,
        "detail_level": "market",
        "observed_at": iso_z(captured_at),
    }
    capture_type = "closing_odds" if args.snapshot_type == "closing" else "current_odds"
    data = {
        "provider": "espn_public_odds",
        "provider_event_id": context["event_id"],
        "competition": context["league_slug"],
        "scheduled_kickoff": iso_z(context["kickoff"]),
        "status": "scheduled",
        "market": "moneyline_3way",
        "snapshot_type": "closing" if args.snapshot_type == "closing" else "entry",
        "bookmaker": market_after["bookmaker"],
        "odds_timestamp": iso_z(captured_at),
        "odds": odds_rows,
        "screenshot_sha256": screenshot_sha,
        "provider_raw_sha256": provider_raw_sha,
        "screenshot_render_mode": "LOCAL_VERIFIABLE_SOURCE_RENDER",
        "source_render_path": render_path.name,
        "normalized_event": normalized_event,
    }
    evidence_payload = {
        "capture_type": capture_type,
        "captured_at": iso_z(captured_at),
        "data": data,
        "source_url": source_url,
        "screenshot_sha256": screenshot_sha,
    }
    evidence_canonical = canonical_json(evidence_payload)
    evidence_sha = sha256_text(evidence_canonical)
    draft = {
        "schema_version": "sports-data-hub.source-capture-draft.v1",
        "workflow_state": "PENDING_HUMAN_VERIFICATION",
        "auto_post": False,
        "match_id": args.match_id,
        "source_name": "sportsbook_manual_verified",
        "source_url": source_url,
        "bookmaker": market_after["bookmaker"],
        "captured_at": iso_z(captured_at),
        "verified_by": None,
        "evidence_id": evidence_sha[:32],
        "evidence_sha256": evidence_sha,
        "evidence_canonical_json": evidence_canonical,
        "screenshot_path": screenshot_path.name,
        "screenshot_sha256": screenshot_sha,
        "capture_type": capture_type,
        "sport": "soccer",
        "source_event_id": context["event_id"],
        "match_fingerprint": sha256_text(f"{context['home']['name']}|{context['away']['name']}|{iso_z(context['kickoff'])}")[:32],
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
    draft_path = output_dir / f"espn__{context['event_id']}__{evidence_sha[:32]}.json"
    draft_path.write_text(json.dumps(draft, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    (output_dir / f"espn__{context['event_id']}__source_response.json").write_text(json.dumps(payload_after, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    return {
        "status": "PENDING_HUMAN_VERIFICATION",
        "draft_path": str(draft_path.resolve()),
        "screenshot_path": str(screenshot_path.resolve()),
        "screenshot_sha256": screenshot_sha,
        "evidence_id": evidence_sha[:32],
        "captured_at": iso_z(captured_at),
        "minutes_to_kickoff": round((context["kickoff"] - captured_at).total_seconds() / 60, 1),
        **market_after,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="ESPN soccer history and 1X2 evidence scraper.")
    parser.add_argument("--date", required=True)
    parser.add_argument("--match-id", required=True)
    parser.add_argument("--expected-home", required=True)
    parser.add_argument("--expected-away", required=True)
    parser.add_argument("--league-slug", default="")
    parser.add_argument("--bookmaker", default="DraftKings")
    parser.add_argument("--snapshot-type", choices=["current", "closing"], default="current")
    parser.add_argument("--capture-market", action="store_true")
    parser.add_argument("--apply-history", action="store_true")
    parser.add_argument("--api-key", default=os.environ.get("INTERNAL_API_KEY", ""))
    parser.add_argument("--history-api-url", default="http://127.0.0.1:4000/api/v1/internal/analytics/ingest-historical-matches")
    parser.add_argument("--output-root", default=str(Path(__file__).resolve().parents[1] / "uploads" / "source-captures" / "scraper-inbox"))
    parser.add_argument("--evidence-root", default=str(Path(__file__).resolve().parents[1] / "uploads" / "provider-evidence" / "football"))
    parser.add_argument("--chrome-path", default="")
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--browser-timeout", type=int, default=45)
    args = parser.parse_args()

    date_key = args.date.replace("-", "")
    try:
        event, scoreboard, source_url = discover_event(
            date_key,
            args.expected_home,
            args.expected_away,
            args.timeout,
            args.league_slug or None,
        )
    except RuntimeError as exc:
        if str(exc) not in {"ESPN_EVENT_NOT_FOUND", "ESPN_EVENT_NOT_FOUND_OR_AMBIGUOUS"}:
            raise
        print(json.dumps({
            "system_status": "ESPN_SOCCER_NO_MATCHING_EVENT",
            "match_id": args.match_id,
            "league_slug": args.league_slug or None,
            "expected_home": args.expected_home,
            "expected_away": args.expected_away,
            "decision": "NO_PICK",
            "reason": str(exc),
            "history_applied": False,
            "market_capture": None,
            "guardrails": {
                "paper_shadow_only": True,
                "picks_created": 0,
                "real_candidate": 0,
                "real_money_enabled": False,
                "kelly_enabled": False,
                "telegram_auto_enabled": False,
                "autopost_enabled": False,
                "kill_switch": True,
            },
        }, indent=2))
        return 0
    context = event_context(event, next(slug for slug in ESPN_LEAGUES.values() if f"/{slug}/" in source_url))
    if team_match_score(args.expected_home, context["home"]) == 0 or team_match_score(args.expected_away, context["away"]) == 0:
        raise RuntimeError("EVENT_TEAM_MISMATCH")
    context["expected_home"] = args.expected_home
    context["expected_away"] = args.expected_away
    events, captures = completed_history_events(context, args.timeout)
    matches, team_stats = build_history_rows(context, events, captures, Path(args.evidence_root))
    history = post_history(matches, team_stats, args.history_api_url, args.api_key, args.timeout) if args.apply_history else None
    market = market_capture(args, event, scoreboard, source_url, context) if args.capture_market else None
    print(json.dumps({
        "system_status": "ESPN_SOCCER_SCRAPER_OK",
        "match_id": args.match_id,
        "event_id": context["event_id"],
        "league_slug": context["league_slug"],
        "home": context["home"]["name"],
        "away": context["away"]["name"],
        "kickoff": iso_z(context["kickoff"]),
        "history_matches": len(matches),
        "history_team_rows": len(team_stats),
        "history_applied": bool(args.apply_history),
        "history_ingestion": history,
        "market_capture": market,
        "guardrails": {
            "paper_shadow_only": True,
            "picks_created": 0,
            "real_candidate": 0,
            "real_money_enabled": False,
            "kelly_enabled": False,
            "telegram_auto_enabled": False,
            "autopost_enabled": False,
            "kill_switch": True,
        },
    }, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"system_status": "ESPN_SOCCER_SCRAPER_FAILED", "error": str(exc), "picks_created": 0, "real_candidate": 0}), file=sys.stderr)
        raise SystemExit(1)
