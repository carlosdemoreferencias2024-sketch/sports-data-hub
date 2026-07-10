import argparse
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from batch_scraper import ScrapedMatch, ingest, parse_fixture, post_batch
from normalizer import normalize_alias


@dataclass(frozen=True)
class LeagueConfig:
    league_slug: str
    source_slug: str
    heading: str
    url: str


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


def match_date_for(backfill_date: str | None) -> str:
    if not backfill_date:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    return f"{backfill_date[:4]}-{backfill_date[4:6]}-{backfill_date[6:8]}T12:00:00Z"


def url_for_backfill(url: str, backfill_date: str | None) -> str:
    if not backfill_date:
        return url

    trimmed = url.rstrip("/")
    if "/fecha/" in trimmed:
        return re.sub(r"/fecha/\d{8}", f"/fecha/{backfill_date}", trimmed)

    return f"{trimmed}/fecha/{backfill_date}"


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


def score_pair_from_text(value: str | None) -> tuple[int | None, int | None]:
    if not value:
        return None, None

    parts = [part.strip() for part in value.replace("–", "-").split("-")]
    if len(parts) != 2:
        return None, None

    return parse_int_score(parts[0]), parse_int_score(parts[1])


def normalize_status(period: str | None) -> str:
    if not period:
        return "scheduled"

    normalized = normalize_alias(period)
    if normalized in {"ft", "final", "finalizado", "terminado"}:
        return "finished"
    if "'" in period or "min" in normalized or "tiempo" in normalized or "half" in normalized:
        return "live"
    return "scheduled"


def make_source_match_id(league_slug: str, home_alias: str, away_alias: str, match_date: str, status: str = "scheduled") -> str:
    home_slug = normalize_alias(home_alias).replace(" ", "-")
    away_slug = normalize_alias(away_alias).replace(" ", "-")
    if status in {"scheduled", "live"}:
        return f"espn-{league_slug}-event-{home_slug}-{away_slug}"
    return f"espn-{league_slug}-{match_date[:10]}-{home_slug}-{away_slug}"


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
        print(json.dumps({"level": "warn", "event": "soccer_odds_parse_failed", "message": str(exc)}), flush=True)
        return None, None


def candidate_game_nodes(block):
    selectors = [
        "article",
        ".Scoreboard",
        ".scoreboard",
        ".event",
        ".Event",
        ".game",
        ".Game",
        "tbody tr",
        ".Table__TR",
    ]
    seen: set[int] = set()
    nodes = []

    for selector in selectors:
        for node in block.select(selector):
            marker = id(node)
            if marker not in seen:
                seen.add(marker)
                nodes.append(node)

    return nodes


def parse_game_node(node, match_date: str, league_slug: str) -> ScrapedMatch | None:
    team_selectors = [
        ".ScoreCell__TeamName",
        ".ScoreCell__Name",
        ".team-name",
        ".TeamName",
        ".Table__Team",
        ".team",
        "span",
    ]
    score_selectors = [
        ".ScoreCell__Score",
        ".score",
        ".Score",
        ".Table__TD--score",
    ]
    period_selectors = [
        ".Scoreboard__Clock",
        ".game-status",
        ".status",
        ".GameStatus",
        ".period",
    ]

    side_nodes = {
        "home": node.select_one(".ScoreboardScoreCell__Item--home"),
        "away": node.select_one(".ScoreboardScoreCell__Item--away"),
    }
    if side_nodes["home"] and side_nodes["away"]:
        home_alias = first_text(side_nodes["home"], [".ScoreCell__TeamName", ".ScoreCell__Team", ".team-name", "a"])
        away_alias = first_text(side_nodes["away"], [".ScoreCell__TeamName", ".ScoreCell__Team", ".team-name", "a"])
        home_score = parse_int_score(first_text(side_nodes["home"], [".ScoreCell__Score", ".score"]))
        away_score = parse_int_score(first_text(side_nodes["away"], [".ScoreCell__Score", ".score"]))

        if home_alias and away_alias:
            score_cell = node.select_one(".ScoreboardScoreCell")
            score_cell_classes = set(score_cell.get("class", [])) if score_cell else set()
            period = first_text(node, [".ScoreboardScoreCell__Note", ".Scoreboard__Clock", ".game-status", ".status"])
            if not period:
                if "ScoreboardScoreCell--post" in score_cell_classes:
                    period = "Final"
                elif "ScoreboardScoreCell--pre" in score_cell_classes:
                    period = "Previa"
                else:
                    period = "Live"
            status = "finished" if "ScoreboardScoreCell--post" in score_cell_classes else normalize_status(period)
            home_odds, away_odds = parse_odds(node)

            return ScrapedMatch(
                source_match_id=make_source_match_id(league_slug, home_alias, away_alias, match_date, status),
                league_slug=league_slug,
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

    team_texts: list[str] = []
    for selector in team_selectors:
        team_texts = [item.get_text(" ", strip=True) for item in node.select(selector) if item.get_text(" ", strip=True)]
        if len(team_texts) >= 2:
            break

    if len(team_texts) < 2:
        return None

    score_texts: list[str] = []
    for selector in score_selectors:
        score_texts = [item.get_text(" ", strip=True) for item in node.select(selector) if item.get_text(" ", strip=True)]
        if score_texts:
            break

    home_score: int | None = None
    away_score: int | None = None
    if len(score_texts) >= 2:
        away_score = parse_int_score(score_texts[0])
        home_score = parse_int_score(score_texts[1])
    elif len(score_texts) == 1:
        away_score, home_score = score_pair_from_text(score_texts[0])

    away_alias = team_texts[0]
    home_alias = team_texts[1]
    period = first_text(node, period_selectors) or "Previa"
    home_odds, away_odds = parse_odds(node)

    status = normalize_status(period)

    return ScrapedMatch(
        source_match_id=make_source_match_id(league_slug, home_alias, away_alias, match_date, status),
        league_slug=league_slug,
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


def find_league_blocks(soup, heading_text: str):
    blocks = []
    heading_norm = normalize_alias(heading_text)
    headings = soup.find_all(string=lambda value: bool(value and heading_norm in normalize_alias(value)))

    for heading in headings:
        node = heading.parent
        for _ in range(6):
            if node is None:
                break
            class_text = " ".join(node.get("class", [])) if hasattr(node, "get") else ""
            if node.name in {"section", "article", "div"} and (
                "competition" in class_text.lower()
                or "scoreboard" in class_text.lower()
                or "card" in class_text.lower()
            ):
                blocks.append(node)
                break
            node = node.parent

    return blocks


def fetch_espn_league(config: LeagueConfig, backfill_date: str | None = None) -> list[ScrapedMatch]:
    import requests
    from bs4 import BeautifulSoup

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
    }

    target_url = url_for_backfill(config.url, backfill_date)
    print(
        json.dumps(
            {
                "event": "espn_fetch_start",
                "league_slug": config.league_slug,
                "source_slug": config.source_slug,
                "url": target_url,
                "backfill_date": backfill_date,
                "time": datetime.now().isoformat(),
            }
        ),
        flush=True,
    )
    response = requests.get(target_url, headers=headers, timeout=12)
    if response.status_code != 200:
        print(json.dumps({"level": "warn", "event": "espn_fetch_failed", "status_code": response.status_code}), flush=True)
        return []

    soup = BeautifulSoup(response.content, "html.parser")
    blocks = find_league_blocks(soup, config.heading)
    if not blocks:
        print(
            json.dumps(
                {
                    "level": "warn",
                    "event": "soccer_league_blocks_missing",
                    "league_slug": config.league_slug,
                    "heading": config.heading,
                }
            ),
            flush=True,
        )
        blocks = soup.select("section.Scoreboard")

    match_date = match_date_for(backfill_date)
    matches: list[ScrapedMatch] = []

    for block in blocks:
        for node in candidate_game_nodes(block):
            try:
                match = parse_game_node(node, match_date, config.league_slug)
                if match:
                    matches.append(match)
            except Exception as exc:
                print(json.dumps({"level": "warn", "event": "game_parse_failed", "message": str(exc)}), flush=True)

    if not matches:
        for node in soup.select("section.Scoreboard"):
            try:
                match = parse_game_node(node, match_date, config.league_slug)
                if match:
                    matches.append(match)
            except Exception as exc:
                print(json.dumps({"level": "warn", "event": "scoreboard_parse_failed", "message": str(exc)}), flush=True)

    deduped: dict[str, ScrapedMatch] = {}
    for match in matches:
        deduped[match.source_match_id] = match

    if not deduped:
        print(json.dumps({"level": "warn", "event": "soccer_matches_not_detected", "league_slug": config.league_slug}), flush=True)

    return list(deduped.values())


def parse_league_configs(raw_value: str | None, default_source: str, default_url: str) -> list[LeagueConfig]:
    if not raw_value:
        return [LeagueConfig("liga-mx", default_source, "Liga MX", default_url)]

    configs: list[LeagueConfig] = []
    for index, item in enumerate(raw_value.split(";"), start=1):
        clean = item.strip()
        if not clean:
            continue

        parts = [part.strip() for part in clean.split("|", 3)]
        if len(parts) != 4 or not all(parts):
            raise ValueError(
                "SOCCER_LEAGUE_CONFIGS entries must use league_slug|source_slug|heading|url "
                f"(bad entry #{index}: {clean!r})"
            )
        configs.append(LeagueConfig(parts[0], parts[1], parts[2], parts[3]))

    if not configs:
        raise ValueError("SOCCER_LEAGUE_CONFIGS did not include any valid league configs")
    return configs


def load_match_groups(
    fixture_path: str,
    source_mode: str,
    source_slug: str,
    espn_url: str,
    league_configs: list[LeagueConfig],
    backfill_date: str | None,
) -> dict[str, list[ScrapedMatch]]:
    if source_mode == "espn":
        groups: dict[str, list[ScrapedMatch]] = {}
        for config in league_configs:
            matches = fetch_espn_league(config, backfill_date)
            if matches:
                groups.setdefault(config.source_slug, []).extend(matches)
        return groups
    return {source_slug: parse_fixture(Path(fixture_path).read_text(encoding="utf-8"))}


def merge_group_results(results: list[dict[str, object]]) -> dict[str, object]:
    totals: dict[str, object] = {
        "processed": 0,
        "created": 0,
        "updated": 0,
        "errors": 0,
        "warnings": [],
        "groups": results,
    }
    for result in results:
        for key in ("processed", "created", "updated", "errors"):
            if isinstance(result.get(key), int):
                totals[key] = int(totals[key]) + int(result[key])
        if isinstance(result.get("warnings"), list):
            totals["warnings"] = [*totals["warnings"], *result["warnings"]]  # type: ignore[index]
    return totals


def run_once(
    fixture_path: str,
    source_slug: str,
    dry_run: bool,
    shadow_mode: bool,
    source_mode: str,
    espn_url: str,
    league_configs: list[LeagueConfig],
    backfill_date: str | None,
) -> dict[str, int] | list[dict[str, object]]:
    match_groups = load_match_groups(fixture_path, source_mode, source_slug, espn_url, league_configs, backfill_date)
    matches = [match for group in match_groups.values() for match in group]
    match_dicts = [match.__dict__ for match in matches]

    if dry_run or shadow_mode:
        return {
            "mode": "shadow" if shadow_mode else "dry-run",
            "source_mode": source_mode,
            "backfill_date": backfill_date,
            "detected": len(match_dicts),
            "leagues": sorted({match.league_slug for match in matches}),
            "sources": sorted(match_groups.keys()),
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
    if api_url:
        results = []
        for group_source_slug, group_matches in match_groups.items():
            result = post_batch(group_matches, group_source_slug, api_url, os.environ.get("INTERNAL_API_KEY"))
            if isinstance(result, dict):
                result["source_slug"] = group_source_slug
                result["league_slugs"] = sorted({match.league_slug for match in group_matches})
            results.append(result)
        return merge_group_results(results)

    database_url = os.environ["DATABASE_URL"]
    results = []
    for group_source_slug, group_matches in match_groups.items():
        result = ingest(group_matches, group_source_slug, database_url)
        result["source_slug"] = group_source_slug
        result["league_slugs"] = sorted({match.league_slug for match in group_matches})
        results.append(result)
    return merge_group_results(results)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", default=os.environ.get("SOCCER_FIXTURE_PATH", "fixtures/soccer_scoreboard.html"))
    parser.add_argument("--source", default=os.environ.get("SOCCER_SOURCE_SLUG", "sample-soccer-local"))
    parser.add_argument("--source-mode", choices=["fixture", "espn"], default=os.environ.get("SOCCER_SOURCE_MODE", "fixture"))
    parser.add_argument(
        "--espn-url",
        default=os.environ.get("ESPN_SOCCER_RESULTS_URL", "https://www.espn.com.mx/futbol/resultados/_/liga/mex.1"),
    )
    parser.add_argument(
        "--league-configs",
        default=os.environ.get("SOCCER_LEAGUE_CONFIGS"),
        help="Semicolon list: league_slug|source_slug|heading|url",
    )
    parser.add_argument("--backfill-date", default=os.environ.get("BACKFILL_DATE") or os.environ.get("SOCCER_BACKFILL_DATE"))
    parser.add_argument("--backfill-days", type=int, default=int(os.environ.get("BACKFILL_DAYS") or os.environ.get("SOCCER_BACKFILL_DAYS") or "0"))
    parser.add_argument("--backfill-delay", type=float, default=float(os.environ.get("BACKFILL_DELAY_SECONDS") or os.environ.get("SOCCER_BACKFILL_DELAY_SECONDS") or "2"))
    parser.add_argument("--interval", type=int, default=int(os.environ.get("SOCCER_SCRAPER_INTERVAL_SECONDS", "60")))
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--shadow-mode", action="store_true", default=env_flag("SHADOW_MODE", False))
    args = parser.parse_args()
    backfill_date = normalize_backfill_date(args.backfill_date)
    if args.backfill_days and backfill_date:
        raise ValueError("Use either --backfill-date or --backfill-days, not both")
    league_configs = parse_league_configs(args.league_configs, args.source, args.espn_url)

    print(
        json.dumps(
            {
                "event": "soccer_scraper_started",
                "source_mode": args.source_mode,
                "shadow_mode": args.shadow_mode,
                "source_slug": args.source,
                "league_configs": [config.__dict__ for config in league_configs],
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
                    "event": "soccer_auto_backfill_started",
                    "days": args.backfill_days,
                    "dates": dates,
                    "delay_seconds": args.backfill_delay,
                }
            ),
            flush=True,
        )

        results = []
        for index, target_date in enumerate(dates, start=1):
            print(json.dumps({"event": "soccer_auto_backfill_day_started", "index": index, "date": target_date}), flush=True)
            try:
                result = run_once(
                    args.fixture,
                    args.source,
                    args.dry_run,
                    args.shadow_mode,
                    args.source_mode,
                    args.espn_url,
                    league_configs,
                    target_date,
                )
                results.append({"date": target_date, "result": result})
                print(json.dumps({"event": "soccer_auto_backfill_day_completed", "date": target_date, "result": result}, indent=2), flush=True)
            except Exception as exc:
                error = {"date": target_date, "status": "error", "message": str(exc)}
                results.append(error)
                print(json.dumps({"event": "soccer_auto_backfill_day_failed", **error}), flush=True)

            if index < len(dates):
                time.sleep(args.backfill_delay)

        print(json.dumps({"event": "soccer_auto_backfill_completed", "results": results}, indent=2), flush=True)
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
                league_configs,
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
