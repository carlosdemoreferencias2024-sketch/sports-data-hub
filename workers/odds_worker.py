import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import requests

from base_worker import get_hub_match_id, post_quotes, post_raw_provider_events, request_json


HUB_BASE_URL = os.getenv("HUB_BASE_URL", "http://engine-node:3000").rstrip("/")
HUB_QUOTES_URL = f"{HUB_BASE_URL}/api/v1/internal/quotes"
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "")
ODDS_SOURCE_URL = os.getenv("ODDS_SOURCE_URL", "").strip()
ODDS_SOURCE_MODE = os.getenv("ODDS_SOURCE_MODE", "generic").strip().lower()
ODDS_SOURCE_DETAIL_URL = os.getenv("ODDS_SOURCE_DETAIL_URL", "").strip()
ODDS_SOURCE_PROVIDER = os.getenv("ODDS_SOURCE_PROVIDER", "external_odds").strip()
ODDS_SOURCE_API_KEY = os.getenv("ODDS_SOURCE_API_KEY", "").strip()
ODDS_SOURCE_API_KEY_HEADER = os.getenv("ODDS_SOURCE_API_KEY_HEADER", "Authorization").strip()
ODDS_SOURCE_HOST = os.getenv("ODDS_SOURCE_HOST", "").strip()
ODDS_SOURCE_HOST_HEADER = os.getenv("ODDS_SOURCE_HOST_HEADER", "x-rapidapi-host").strip()
ODDS_SOURCE_SKIP_ESPORTS = os.getenv("ODDS_SOURCE_SKIP_ESPORTS", "true").strip().lower() in {
    "1",
    "true",
    "yes",
}
ODDS_SOURCE_ALLOW_REVERSED_MATCH = os.getenv(
    "ODDS_SOURCE_ALLOW_REVERSED_MATCH", "false"
).strip().lower() in {"1", "true", "yes"}
ODDS_SOURCE_ALLOW_DISCOVERY_MATCH = os.getenv(
    "ODDS_SOURCE_ALLOW_DISCOVERY_MATCH", "false"
).strip().lower() in {"1", "true", "yes"}
ODDS_SOURCE_MAX_PAGES = max(1, int(os.getenv("ODDS_SOURCE_MAX_PAGES", "5")))
ODDS_SOURCE_MAX_DETAIL_REQUESTS = max(1, int(os.getenv("ODDS_SOURCE_MAX_DETAIL_REQUESTS", "50")))
ODDS_SOURCE_DETAIL_DELAY_SECONDS = max(
    0.0, float(os.getenv("ODDS_SOURCE_DETAIL_DELAY_SECONDS", "1.0"))
)
ODDS_WORKER_INTERVAL_SECONDS = max(30, int(os.getenv("ODDS_WORKER_INTERVAL_SECONDS", "300")))
ODDS_WORKER_HEALTH_PORT = int(os.getenv("ODDS_WORKER_HEALTH_PORT", "8080"))
ODDS_WORKER_STALE_SECONDS = int(os.getenv("ODDS_WORKER_STALE_SECONDS", "600"))
REQUEST_TIMEOUT_SECONDS = float(os.getenv("ODDS_WORKER_REQUEST_TIMEOUT_SECONDS", "20"))

STATE: dict[str, Any] = {
    "status": "idle" if not ODDS_SOURCE_URL else "starting",
    "last_cycle_at": None,
    "last_success_at": None,
    "last_quote_at": None,
    "cycles": 0,
    "source_rows": 0,
    "matched": 0,
    "inserted": 0,
    "unchanged": 0,
    "unmatched": 0,
    "unmapped": 0,
    "raw_events_reported": 0,
    "detail_errors": 0,
    "error": None,
}

TEAM_ALIASES = {
    "aridiamondbacks": "arizonadiamondbacks",
    "atlbraves": "atlantabraves",
    "chicubs": "chicagocubs",
    "houastros": "houstonastros",
    "kcroyals": "kansascityroyals",
    "ladodgers": "losangelesdodgers",
    "mintwins": "minnesotatwins",
    "pitpirates": "pittsburghpirates",
    "torbluejays": "torontobluejays",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def seconds_since(value: str | None) -> int | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return max(0, int((datetime.now(timezone.utc) - parsed).total_seconds()))
    except (TypeError, ValueError):
        return None


def health_snapshot() -> dict[str, Any]:
    snapshot = dict(STATE)
    snapshot["last_success_age_seconds"] = seconds_since(STATE.get("last_success_at"))
    snapshot["last_quote_age_seconds"] = seconds_since(STATE.get("last_quote_at"))
    if ODDS_SOURCE_URL and STATE["status"] == "ok":
        quote_age = snapshot["last_quote_age_seconds"]
        if quote_age is None or quote_age > ODDS_WORKER_STALE_SECONDS:
            snapshot["status"] = "stale"
            snapshot["error"] = f"Sin cuotas nuevas durante mas de {ODDS_WORKER_STALE_SECONDS}s"
    return snapshot


def normalize(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def normalize_team(value: Any) -> str:
    normalized = normalize(value)
    return TEAM_ALIASES.get(normalized, normalized)


def hub_headers() -> dict[str, str]:
    return {"X-Internal-API-Key": INTERNAL_API_KEY} if INTERNAL_API_KEY else {}


def source_headers() -> dict[str, str]:
    headers: dict[str, str] = {}
    if ODDS_SOURCE_API_KEY:
        value = ODDS_SOURCE_API_KEY
        if ODDS_SOURCE_API_KEY_HEADER.lower() == "authorization" and not value.lower().startswith(("bearer ", "basic ")):
            value = f"Bearer {value}"
        headers[ODDS_SOURCE_API_KEY_HEADER] = value
    if ODDS_SOURCE_HOST:
        headers[ODDS_SOURCE_HOST_HEADER] = ODDS_SOURCE_HOST
    return headers


def extract_rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("quotes", "items", "events", "response", "results", "data"):
        rows = payload.get(key)
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    return []


def fetch_hub_matches() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for status in ("scheduled", "live"):
        payload = request_json(
            "GET",
            f"{HUB_BASE_URL}/api/v1/matches",
            params={"status": status, "limit": 200},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        rows.extend(payload if isinstance(payload, list) else payload.get("items", []))
    return rows


def match_key(row: dict[str, Any]) -> tuple[str, str, str] | None:
    league = row.get("league_slug") or row.get("league")
    home = row.get("home_team")
    away = row.get("away_team")
    if home is None or away is None:
        for competitor in row.get("competitors") or []:
            side = str(competitor.get("home_away") or "").lower()
            if side == "home":
                home = competitor.get("team_name") or competitor.get("team_slug")
            elif side == "away":
                away = competitor.get("team_name") or competitor.get("team_slug")
    if not league or not home or not away:
        return None
    return normalize(league), normalize_team(home), normalize_team(away)


def team_pair_key(row: dict[str, Any]) -> tuple[str, str] | None:
    home = row.get("home_team")
    away = row.get("away_team")
    if home is None or away is None:
        for competitor in row.get("competitors") or []:
            side = str(competitor.get("home_away") or "").lower()
            if side == "home":
                home = competitor.get("team_name") or competitor.get("team_slug")
            elif side == "away":
                away = competitor.get("team_name") or competitor.get("team_slug")
    if not home or not away:
        return None
    return normalize_team(home), normalize_team(away)


def build_match_indexes(
    matches: list[dict[str, Any]],
) -> tuple[dict[str, str], dict[tuple[str, str, str], str], dict[tuple[str, str], str]]:
    by_id: dict[str, str] = {}
    by_teams: dict[tuple[str, str, str], str] = {}
    by_team_pair: dict[tuple[str, str], str] = {}
    duplicate_team_keys: set[tuple[str, str, str]] = set()
    duplicate_team_pairs: set[tuple[str, str]] = set()
    for match in matches:
        match_id = str(match.get("id") or "")
        if not match_id:
            continue
        by_id[match_id] = match_id
        key = match_key(match)
        if key:
            if key in by_teams:
                duplicate_team_keys.add(key)
            else:
                by_teams[key] = match_id
        pair_key = team_pair_key(match)
        if not pair_key:
            continue
        if pair_key in by_team_pair:
            duplicate_team_pairs.add(pair_key)
        else:
            by_team_pair[pair_key] = match_id
    for key in duplicate_team_keys:
        by_teams.pop(key, None)
    for key in duplicate_team_pairs:
        by_team_pair.pop(key, None)
    return by_id, by_teams, by_team_pair


def as_price(value: Any) -> float | None:
    if value is None or value == "":
        return None
    price = float(value)
    return round(price, 4) if price > 1 else None


def normalize_quote(
    row: dict[str, Any],
    by_id: dict[str, str],
    by_teams: dict[tuple[str, str, str], str],
    by_team_pair: dict[tuple[str, str], str],
) -> dict[str, Any] | None:
    supplied_id = str(row.get("hub_match_id") or row.get("match_id") or "")
    match_id = by_id.get(supplied_id)
    if not match_id:
        key = match_key(row)
        match_id = by_teams.get(key) if key else None
    if not match_id:
        pair_key = team_pair_key(row)
        match_id = by_team_pair.get(pair_key) if pair_key else None
    if not match_id:
        return None

    home_odds = as_price(row.get("home_odds"))
    away_odds = as_price(row.get("away_odds"))
    draw_odds = as_price(row.get("draw_odds"))
    if home_odds is None and away_odds is None and draw_odds is None:
        return None

    return {
        "match_id": match_id,
        "provider_name": str(row.get("provider_name") or ODDS_SOURCE_PROVIDER),
        "market_type": str(row.get("market_type") or "moneyline_2way"),
        "home_odds": home_odds,
        "away_odds": away_odds,
        "draw_odds": draw_odds,
        "captured_at": row.get("captured_at") or utc_now(),
        "raw_data": row,
    }


def betsapi_upcoming_row(row: dict[str, Any]) -> dict[str, Any]:
    league = row.get("league") or {}
    home = row.get("home") or {}
    away = row.get("away") or {}
    return {
        "external_id": str(row.get("id") or ""),
        "league": league.get("name") if isinstance(league, dict) else league,
        "home_team": home.get("name") if isinstance(home, dict) else home,
        "away_team": away.get("name") if isinstance(away, dict) else away,
        "kickoff": epoch_to_iso(row.get("time")),
        "raw_data": row,
    }


def is_esports(row: dict[str, Any]) -> bool:
    text = " ".join(
        str(row.get(key) or "") for key in ("league", "home_team", "away_team")
    ).lower()
    return any(token in text for token in ("esoccer", "ebasketball", "efootball", " esports"))


def epoch_to_iso(value: Any) -> str:
    try:
        return datetime.fromtimestamp(float(value), timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError):
        return utc_now()


def parse_betsapi_prematch(
    payload: Any,
    upcoming: dict[str, Any],
    match_id: str,
    reversed_match: bool,
) -> dict[str, Any] | None:
    results = extract_rows(payload)
    if not results:
        return None
    result = results[0]
    main = result.get("main") or {}
    markets = main.get("sp") or {}
    full_time = markets.get("full_time_result") or {}
    if not full_time:
        for market_key, market in markets.items():
            market_label = normalize(f"{market_key} {market.get('name') if isinstance(market, dict) else ''}")
            if any(
                token in market_label
                for token in ("moneyline", "towin", "matchwinner", "gameresult", "winner")
            ):
                full_time = market
                break
    prices: dict[str, float | None] = {"1": None, "2": None, "draw": None}
    for item in full_time.get("odds") or []:
        name = str(item.get("name") or "").strip().lower()
        header = str(item.get("header") or "").strip().lower()
        normalized_name = normalize_team(name)
        normalized_header = normalize_team(header)
        home_name = normalize_team(upcoming.get("home_team"))
        away_name = normalize_team(upcoming.get("away_team"))
        if name == "draw" or header == "draw":
            key = "draw"
        elif name in {"1", "home"} or header in {"1", "home"} or normalized_name == home_name or normalized_header == home_name:
            key = "1"
        elif name in {"2", "away"} or header in {"2", "away"} or normalized_name == away_name or normalized_header == away_name:
            key = "2"
        else:
            key = ""
        if key in prices:
            prices[key] = as_price(item.get("odds"))
    market_odds = full_time.get("odds") or []
    if prices["1"] is None and prices["2"] is None and len(market_odds) == 2:
        prices["1"] = as_price(market_odds[0].get("odds"))
        prices["2"] = as_price(market_odds[1].get("odds"))
    if not any(prices.values()):
        return None
    if reversed_match:
        prices["1"], prices["2"] = prices["2"], prices["1"]
    return {
        "match_id": match_id,
        "provider_name": ODDS_SOURCE_PROVIDER,
        "market_type": "moneyline_3way" if prices["draw"] is not None else "moneyline_2way",
        "home_odds": prices["1"],
        "away_odds": prices["2"],
        "draw_odds": prices["draw"],
        "captured_at": epoch_to_iso(main.get("updated_at")),
        "raw_data": {
            "upcoming": upcoming.get("raw_data"),
            "full_time_result": full_time,
            "home_away_swapped_to_match_hub": reversed_match,
        },
    }


def fetch_betsapi_quotes(
    by_teams: dict[tuple[str, str, str], str],
    by_team_pair: dict[tuple[str, str], str],
) -> tuple[list[dict[str, Any]], int, int, int]:
    upcoming_rows: list[dict[str, Any]] = []
    for page in range(1, ODDS_SOURCE_MAX_PAGES + 1):
        payload = request_json(
            "GET",
            ODDS_SOURCE_URL,
            params={"page": page},
            headers=source_headers(),
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        page_rows = extract_rows(payload)
        upcoming_rows.extend(betsapi_upcoming_row(row) for row in page_rows)
        pager = payload.get("pager") if isinstance(payload, dict) else None
        if not page_rows:
            break
        if isinstance(pager, dict):
            total = int(pager.get("total") or 0)
            per_page = int(pager.get("per_page") or len(page_rows) or 1)
            if page * per_page >= total:
                break
    quotes: list[dict[str, Any]] = []
    matched = 0
    detail_requests = 0
    detail_errors = 0
    unmapped = 0
    raw_events: list[dict[str, Any]] = []
    detail_url = ODDS_SOURCE_DETAIL_URL or ODDS_SOURCE_URL.replace(
        "/v1/bet365/upcoming", "/v3/bet365/prematch"
    )
    for upcoming in upcoming_rows:
        if ODDS_SOURCE_SKIP_ESPORTS and is_esports(upcoming):
            continue
        external_id = str(upcoming.get("external_id") or "")
        match_id = get_hub_match_id(
            HUB_BASE_URL,
            hub_headers(),
            ODDS_SOURCE_PROVIDER,
            external_id,
        ) if external_id else None
        reversed_match = False
        if not match_id and ODDS_SOURCE_ALLOW_DISCOVERY_MATCH:
            key = match_key(upcoming)
            match_id = by_teams.get(key) if key else None
            if not match_id:
                pair_key = team_pair_key(upcoming)
                match_id = by_team_pair.get(pair_key) if pair_key else None
            if not match_id and ODDS_SOURCE_ALLOW_REVERSED_MATCH:
                pair_key = team_pair_key(upcoming)
                reversed_pair = (pair_key[1], pair_key[0]) if pair_key else None
                match_id = by_team_pair.get(reversed_pair) if reversed_pair else None
                reversed_match = bool(match_id)
        if not match_id:
            unmapped += 1
            external_id = str(upcoming.get("external_id") or "")
            if external_id:
                raw_events.append(
                    {
                        "provider_name": ODDS_SOURCE_PROVIDER,
                        "provider_event_id": external_id,
                        "league_name": upcoming.get("league"),
                        "home_team_name": upcoming.get("home_team"),
                        "away_team_name": upcoming.get("away_team"),
                        "kickoff": upcoming.get("kickoff") or utc_now(),
                        "raw_data": upcoming.get("raw_data") or upcoming,
                    }
                )
            continue
        matched += 1
        if detail_requests >= ODDS_SOURCE_MAX_DETAIL_REQUESTS:
            continue
        if not external_id:
            continue
        detail_requests += 1
        if ODDS_SOURCE_DETAIL_DELAY_SECONDS:
            time.sleep(ODDS_SOURCE_DETAIL_DELAY_SECONDS)
        try:
            detail_payload = request_json(
                "GET",
                detail_url,
                params={"FI": external_id},
                headers=source_headers(),
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            quote = parse_betsapi_prematch(detail_payload, upcoming, match_id, reversed_match)
        except requests.RequestException:
            detail_errors += 1
            continue
        if quote:
            quotes.append(quote)
    STATE["unmapped"] = unmapped
    raw_result = post_raw_provider_events(HUB_BASE_URL, hub_headers(), raw_events)
    STATE["raw_events_reported"] = int(raw_result.get("inserted") or 0) + int(
        raw_result.get("updated") or 0
    )
    return quotes, len(upcoming_rows), matched, detail_errors


def run_cycle() -> None:
    STATE["cycles"] += 1
    STATE["last_cycle_at"] = utc_now()
    if not ODDS_SOURCE_URL:
        STATE["status"] = "idle"
        STATE["error"] = "ODDS_SOURCE_URL no configurado"
        return

    try:
        matches = fetch_hub_matches()
        by_id, by_teams, by_team_pair = build_match_indexes(matches)
        if ODDS_SOURCE_MODE == "betsapi_bet365":
            quotes, source_count, matched_count, detail_errors = fetch_betsapi_quotes(
                by_teams, by_team_pair
            )
        else:
            source_payload = request_json(
                "GET",
                ODDS_SOURCE_URL,
                headers=source_headers(),
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            source_rows = extract_rows(source_payload)
            quotes = [
                quote
                for row in source_rows
                if (quote := normalize_quote(row, by_id, by_teams, by_team_pair)) is not None
            ]
            source_count = len(source_rows)
            matched_count = len(quotes)
            detail_errors = 0
        STATE["source_rows"] = source_count
        STATE["matched"] = matched_count
        STATE["unmatched"] = source_count - matched_count
        STATE["detail_errors"] = detail_errors

        inserted = 0
        unchanged = 0
        if quotes:
            result = post_quotes(HUB_QUOTES_URL, hub_headers(), quotes)
            inserted = int(result.get("inserted") or 0)
            unchanged = int(result.get("unchanged") or 0)

        STATE["inserted"] = inserted
        STATE["unchanged"] = unchanged
        STATE["last_success_at"] = utc_now()
        if quotes:
            STATE["last_quote_at"] = utc_now()
        STATE["status"] = "ok"
        STATE["error"] = None
        print(json.dumps({"event": "odds_worker_cycle", **STATE}, ensure_ascii=False), flush=True)
    except Exception as exc:
        STATE["status"] = "degraded"
        STATE["error"] = str(exc)
        print(json.dumps({"event": "odds_worker_error", **STATE}, ensure_ascii=False), flush=True)


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_response(404)
            self.end_headers()
            return
        snapshot = health_snapshot()
        payload = json.dumps(snapshot).encode("utf-8")
        self.send_response(200 if snapshot["status"] in {"ok", "idle", "starting"} else 503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        return


def serve_health() -> None:
    ThreadingHTTPServer(("0.0.0.0", ODDS_WORKER_HEALTH_PORT), HealthHandler).serve_forever()


def main() -> None:
    threading.Thread(target=serve_health, daemon=True).start()
    while True:
        run_cycle()
        time.sleep(ODDS_WORKER_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
