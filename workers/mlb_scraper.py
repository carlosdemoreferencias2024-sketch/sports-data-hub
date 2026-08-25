import argparse
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from batch_scraper import ScrapedMatch, parse_fixture, post_batch
from normalizer import normalize_alias


def env_flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def normalize_backfill_date(value: str | None) -> str | None:
    if not value:
        return None

    clean = value.strip().replace("-", "")
    if not re.fullmatch(r"\d{8}", clean):
        raise ValueError("BACKFILL_DATE must use YYYYMMDD or YYYY-MM-DD")

    return clean


def backfill_date_range(days: int) -> list[str]:
    if days < 1:
        raise ValueError("--backfill-days must be greater than zero")

    today = datetime.now(timezone.utc).date()
    return [(today - timedelta(days=offset)).strftime("%Y%m%d") for offset in range(1, days + 1)]


def today_date_key() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d")


def normalize_exact_timestamp(value: str) -> str | None:
    try:
        if value.isdigit():
            epoch = int(value)
            if epoch > 10_000_000_000:
                epoch /= 1000
            parsed = datetime.fromtimestamp(epoch, tz=timezone.utc)
        else:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                return None
            parsed = parsed.astimezone(timezone.utc)
        return parsed.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    except (ValueError, OverflowError):
        return None


def embedded_event_dates(soup) -> dict[str, str]:
    marker = "window['__espnfitt__']="
    script_text = next(
        (
            script.string or script.get_text()
            for script in soup.find_all("script")
            if marker in (script.string or script.get_text() or "")
        ),
        "",
    )
    if not script_text:
        return {}
    try:
        start = script_text.index(marker) + len(marker)
        payload, _ = json.JSONDecoder().raw_decode(script_text[start:])
    except (ValueError, json.JSONDecodeError):
        return {}

    scoreboard = payload.get("page", {}).get("content", {}).get("scoreboard", {})
    events = list(scoreboard.get("evts") or [])
    for group in scoreboard.get("gmsByLeague") or []:
        events.extend(group.get("evts") or [])

    dates: dict[str, str] = {}
    for event in events:
        event_id = str(event.get("id") or "").strip()
        event_date = normalize_exact_timestamp(str(event.get("date") or "").strip())
        if event_id and event_date:
            dates[event_id] = event_date
    return dates


def exact_match_date(node, event_dates: dict[str, str] | None = None) -> str | None:
    event_id = str(node.get("id") or "").strip()
    if not event_id:
        scoreboard = node.find_parent("section", class_="Scoreboard")
        event_id = str(scoreboard.get("id") or "").strip() if scoreboard else ""
    if event_dates and event_id in event_dates:
        return event_dates[event_id]

    candidates: list[str] = []
    for selector in ["time[datetime]", "[data-date]", "[data-start-date]", "[data-start-time]"]:
        for item in node.select(selector):
            for attribute in ["datetime", "data-date", "data-start-date", "data-start-time"]:
                value = item.get(attribute)
                if value:
                    candidates.append(str(value).strip())
    for attribute in ["data-date", "data-start-date", "data-start-time"]:
        value = node.get(attribute)
        if value:
            candidates.append(str(value).strip())
    for value in candidates:
        parsed = normalize_exact_timestamp(value)
        if parsed:
            return parsed
    return None


def url_for_backfill(url: str, backfill_date: str | None) -> str:
    if not backfill_date:
        return url

    trimmed = url.rstrip("/")
    if "/fecha/" in trimmed:
        return re.sub(r"/fecha/\d{8}", f"/fecha/{backfill_date}", trimmed)

    return f"{trimmed}/_/fecha/{backfill_date}"


def parse_int_score(value: str | None) -> int | None:
    if value is None:
        return None

    clean = value.strip()
    return int(clean) if clean.isdigit() else None


def american_to_decimal(value: int) -> float:
    if value > 0:
        return round(1 + (value / 100), 2)
    return round(1 + (100 / abs(value)), 2)


def parse_odds_text(value: str | None) -> tuple[float | None, float | None]:
    if not value:
        return None, None

    clean = value.replace("−", "-").replace("–", "-")
    decimal_values = [float(item) for item in re.findall(r"(?<![+-])\b[1-9]\d?\.\d{2}\b", clean)]
    if len(decimal_values) >= 2:
        return decimal_values[0], decimal_values[1]

    american_values = [int(item) for item in re.findall(r"(?<!\d)[+-]\d{3,4}\b", clean)]
    if len(american_values) >= 2:
        return american_to_decimal(american_values[0]), american_to_decimal(american_values[1])

    return None, None


def text_or_none(node) -> str | None:
    if node is None:
        return None
    text = node.get_text(" ", strip=True)
    return text or None


def first_text(node, selectors: list[str]) -> str | None:
    for selector in selectors:
        found = node.select_one(selector)
        text = text_or_none(found)
        if text:
            return text
    return None


def parse_odds(node) -> tuple[float | None, float | None]:
    try:
        text = first_text(
            node,
            [
                ".Scorecell__Odds",
                ".ScoreCell__Odds",
                ".Scoreboard__Odds",
                ".Odds",
                "[class*='Odds']",
                "[class*='Line']",
            ],
        )
        return parse_odds_text(text)
    except Exception as exc:
        print(json.dumps({"level": "warn", "event": "mlb_odds_parse_failed", "message": str(exc)}), flush=True)
        return None, None


def normalize_status(score_cell_classes: set[str], period: str | None) -> str:
    normalized = normalize_alias(period or "")
    if any(token in normalized for token in ["rain", "postponed", "pospuesto"]):
        return "postponed"

    if "ScoreboardScoreCell--post" in score_cell_classes:
        return "finished"
    if "ScoreboardScoreCell--in" in score_cell_classes:
        return "live"
    if "ScoreboardScoreCell--pre" in score_cell_classes:
        return "scheduled"

    if normalized in {"final", "finalizado", "terminado"}:
        return "finished"
    if "vivo" in normalized or "inning" in normalized or "entrada" in normalized:
        return "live"
    return "scheduled"


def make_source_match_id(home_alias: str, away_alias: str, match_date: str, status: str = "scheduled") -> str:
    home_slug = normalize_alias(home_alias).replace(" ", "-")
    away_slug = normalize_alias(away_alias).replace(" ", "-")
    # Keep the provider id stable across scheduled/live/finished transitions.
    # Without the date, a finished backfill used a different id and created a
    # duplicate match for the same MLB game.
    return f"espn-mlb-{match_date[:10]}-{home_slug}-{away_slug}"


def line_score(node) -> int | None:
    values = [item.get_text(" ", strip=True) for item in node.select(".ScoreboardScoreCell__Value")]
    return parse_int_score(values[0]) if values else None


def parse_scoreboard(node, event_dates: dict[str, str] | None = None) -> ScrapedMatch | None:
    match_date = exact_match_date(node, event_dates)
    if not match_date:
        return None
    side_nodes = {
        "home": node.select_one(".ScoreboardScoreCell__Item--home"),
        "away": node.select_one(".ScoreboardScoreCell__Item--away"),
    }
    if not side_nodes["home"] or not side_nodes["away"]:
        return None

    home_alias = first_text(side_nodes["home"], [".ScoreCell__TeamName", ".ScoreCell__Team", "a"])
    away_alias = first_text(side_nodes["away"], [".ScoreCell__TeamName", ".ScoreCell__Team", "a"])
    if not home_alias or not away_alias:
        return None

    score_cell = node.select_one(".ScoreboardScoreCell")
    score_cell_classes = set(score_cell.get("class", [])) if score_cell else set()
    period = first_text(node, [".ScoreboardScoreCell__Note", ".Scoreboard__Callouts", ".Scoreboard__Column--2"])
    if not period:
        if "ScoreboardScoreCell--post" in score_cell_classes:
            period = "Final"
        elif "ScoreboardScoreCell--in" in score_cell_classes:
            period = "En Vivo"
        else:
            period = "Juego"

    status = normalize_status(score_cell_classes, period)
    home_score = line_score(side_nodes["home"])
    away_score = line_score(side_nodes["away"])
    if status == "finished" and (home_score is None or away_score is None):
        status = "postponed"
    home_odds, away_odds = parse_odds(node)

    return ScrapedMatch(
        source_match_id=make_source_match_id(home_alias, away_alias, match_date, status),
        league_slug="mlb",
        match_date=match_date,
        status=status,
        home_alias=home_alias,
        away_alias=away_alias,
        home_score=home_score,
        away_score=away_score,
        period=period,
        home_odds=home_odds,
        away_odds=away_odds,
    )


def fetch_espn_mlb(url: str, backfill_date: str | None = None) -> list[ScrapedMatch]:
    import requests
    from bs4 import BeautifulSoup

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
    }

    target_url = url_for_backfill(url, backfill_date)
    print(
        json.dumps(
            {
                "event": "espn_mlb_fetch_start",
                "url": target_url,
                "backfill_date": backfill_date,
                "time": datetime.now().isoformat(),
            }
        ),
        flush=True,
    )
    response = requests.get(target_url, headers=headers, timeout=12)
    if response.status_code != 200:
        print(json.dumps({"level": "warn", "event": "espn_mlb_fetch_failed", "status_code": response.status_code}), flush=True)
        return []

    soup = BeautifulSoup(response.content, "html.parser")
    event_dates = embedded_event_dates(soup)
    scoreboards = soup.select("section.Scoreboard")
    if not scoreboards:
        print(json.dumps({"level": "warn", "event": "mlb_scoreboards_not_detected"}), flush=True)
        return []

    matches: list[ScrapedMatch] = []
    for node in scoreboards:
        try:
            match = parse_scoreboard(node, event_dates)
            if match:
                matches.append(match)
        except Exception as exc:
            print(json.dumps({"level": "warn", "event": "mlb_game_parse_failed", "message": str(exc)}), flush=True)

    deduped: dict[str, ScrapedMatch] = {}
    for match in matches:
        deduped[match.source_match_id] = match

    return list(deduped.values())


def load_matches(fixture_path: str, source_mode: str, espn_url: str, backfill_date: str | None) -> list[ScrapedMatch]:
    if source_mode == "espn":
        return fetch_espn_mlb(espn_url, backfill_date)
    return parse_fixture(Path(fixture_path).read_text(encoding="utf-8"))


def run_once(
    fixture_path: str,
    source_slug: str,
    dry_run: bool,
    shadow_mode: bool,
    source_mode: str,
    espn_url: str,
    backfill_date: str | None,
) -> dict[str, object]:
    matches = load_matches(fixture_path, source_mode, espn_url, backfill_date)
    match_dicts = [match.__dict__ for match in matches]

    if dry_run or shadow_mode:
        return {
            "mode": "shadow" if shadow_mode else "dry-run",
            "source_mode": source_mode,
            "backfill_date": backfill_date,
            "detected": len(match_dicts),
            "matches": match_dicts,
        }

    if not matches:
        return {
            "processed": 0,
            "created": 0,
            "updated": 0,
            "errors": 0,
            "warnings": ["no_matches_detected"],
        }

    api_url = os.environ.get("BATCH_INGESTION_URL") or os.environ.get("API_URL")
    if not api_url:
        raise RuntimeError("BATCH_INGESTION_URL or API_URL is required for MLB batch ingestion")

    return post_batch(matches, source_slug, api_url, os.environ.get("INTERNAL_API_KEY"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", default=os.environ.get("MLB_FIXTURE_PATH", "fixtures/sample_scoreboard.html"))
    parser.add_argument("--source", default=os.environ.get("MLB_SOURCE_SLUG", "sample-local"))
    parser.add_argument("--source-mode", choices=["fixture", "espn"], default=os.environ.get("MLB_SOURCE_MODE", "fixture"))
    parser.add_argument("--espn-url", default=os.environ.get("ESPN_MLB_RESULTS_URL", "https://www.espn.com.mx/beisbol/mlb/resultados"))
    parser.add_argument("--backfill-date", default=os.environ.get("BACKFILL_DATE") or os.environ.get("MLB_BACKFILL_DATE"))
    parser.add_argument("--backfill-days", type=int, default=int(os.environ.get("BACKFILL_DAYS") or os.environ.get("MLB_BACKFILL_DAYS") or "0"))
    parser.add_argument("--backfill-delay", type=float, default=float(os.environ.get("BACKFILL_DELAY_SECONDS") or os.environ.get("MLB_BACKFILL_DELAY_SECONDS") or "2"))
    parser.add_argument("--interval", type=int, default=int(os.environ.get("MLB_SCRAPER_INTERVAL_SECONDS", "60")))
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--shadow-mode", action="store_true", default=env_flag("MLB_SHADOW_MODE", False))
    args = parser.parse_args()
    backfill_date = normalize_backfill_date(args.backfill_date)
    if args.backfill_days and backfill_date:
        raise ValueError("Use either --backfill-date or --backfill-days, not both")

    print(
        json.dumps(
            {
                "event": "mlb_scraper_started",
                "source_mode": args.source_mode,
                "shadow_mode": args.shadow_mode,
                "source_slug": args.source,
                "backfill_date": backfill_date,
            }
        ),
        flush=True,
    )

    if args.backfill_days:
        dates = backfill_date_range(args.backfill_days)
        print(
            json.dumps(
                {
                    "event": "mlb_auto_backfill_started",
                    "days": args.backfill_days,
                    "dates": dates,
                    "delay_seconds": args.backfill_delay,
                }
            ),
            flush=True,
        )

        results = []
        for index, target_date in enumerate(dates, start=1):
            print(json.dumps({"event": "mlb_auto_backfill_day_started", "index": index, "date": target_date}), flush=True)
            try:
                result = run_once(
                    args.fixture,
                    args.source,
                    args.dry_run,
                    args.shadow_mode,
                    args.source_mode,
                    args.espn_url,
                    target_date,
                )
                results.append({"date": target_date, "result": result})
                print(json.dumps({"event": "mlb_auto_backfill_day_completed", "date": target_date, "result": result}, indent=2), flush=True)
            except Exception as exc:
                error = {"date": target_date, "status": "error", "message": str(exc)}
                results.append(error)
                print(json.dumps({"event": "mlb_auto_backfill_day_failed", **error}), flush=True)

            if index < len(dates):
                time.sleep(args.backfill_delay)

        print(json.dumps({"event": "mlb_auto_backfill_completed", "results": results}, indent=2), flush=True)
        return

    while True:
        try:
            result = run_once(
                args.fixture,
                args.source,
                args.dry_run,
                args.shadow_mode,
                args.source_mode,
                args.espn_url,
                backfill_date,
            )
            print(json.dumps(result, indent=2), flush=True)
        except Exception as exc:
            print(json.dumps({"status": "error", "message": str(exc)}), flush=True)

        if not args.loop:
            break

        time.sleep(args.interval)


if __name__ == "__main__":
    main()
