import argparse
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from base_worker import request_json, utc_now


HUB_BASE_URL = os.getenv("HUB_BASE_URL", "http://engine-node:3000").rstrip("/")
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "").strip()
INTERVAL_SECONDS = max(300, int(os.getenv("SPORTS_CONTEXT_INCREMENTAL_INTERVAL_SECONDS", "900")))
HEALTH_PORT = int(os.getenv("SPORTS_CONTEXT_INCREMENTAL_HEALTH_PORT", "8081"))
DRY_RUN = os.getenv("SPORTS_CONTEXT_INCREMENTAL_DRY_RUN", "true").strip().lower() not in {"0", "false", "no"}
NEAR_KICKOFF = os.getenv("SPORTS_CONTEXT_INCREMENTAL_NEAR_KICKOFF", "true").strip().lower() not in {"0", "false", "no"}
LOOKAHEAD_HOURS = max(1, int(os.getenv("SPORTS_CONTEXT_INCREMENTAL_LOOKAHEAD_HOURS", "6")))
LOOKBACK_MINUTES = max(0, int(os.getenv("SPORTS_CONTEXT_INCREMENTAL_LOOKBACK_MINUTES", "30")))
MAX_MATCHES = max(1, int(os.getenv("SPORTS_CONTEXT_INCREMENTAL_MAX_MATCHES", "20")))
MAX_API_REQUESTS = max(0, int(os.getenv("SPORTS_CONTEXT_INCREMENTAL_MAX_API_REQUESTS", "10")))
SKIP_IF_KICKOFF_PASSED = os.getenv("SPORTS_CONTEXT_INCREMENTAL_SKIP_IF_KICKOFF_PASSED", "true").strip().lower() not in {
    "0",
    "false",
    "no",
}
ONLY_REBUILD_WHEN_CHANGED = os.getenv("SPORTS_CONTEXT_INCREMENTAL_ONLY_REBUILD_WHEN_CHANGED", "false").strip().lower() in {
    "1",
    "true",
    "yes",
}
INCLUDE_OBSERVATION_ONLY = os.getenv("SPORTS_CONTEXT_INCREMENTAL_INCLUDE_OBSERVATION_ONLY", "false").strip().lower() in {
    "1",
    "true",
    "yes",
}
TARGET_STATUSES = {
    item.strip().upper()
    for item in os.getenv(
        "SPORTS_CONTEXT_INCREMENTAL_TARGET_STATUSES",
        "PARTIAL_CONTEXT_REVIEW,CONTEXT_GAPS,FOOTBALL_CONTEXT_GAPS,BLOCK_CONFIRMATION",
    ).split(",")
    if item.strip()
}
CONSENSUS_DATA_TYPES = [
    item.strip()
    for item in os.getenv(
        "SPORTS_CONTEXT_INCREMENTAL_CONSENSUS_TYPES",
        "fixture,kickoff,lineup,injuries,team_stats,player_stats",
    ).split(",")
    if item.strip()
]

HEADERS = {
    "X-API-Key": INTERNAL_API_KEY,
    "X-Internal-API-Key": INTERNAL_API_KEY,
}

STATE: dict[str, Any] = {
    "status": "starting",
    "last_cycle_at": None,
    "dry_run": DRY_RUN,
    "near_kickoff": NEAR_KICKOFF,
    "matches_seen": 0,
    "matches_scanned": 0,
    "matches_in_window": 0,
    "targets": 0,
    "api_requests": 0,
    "cache_hits": 0,
    "observations_inserted": 0,
    "observations_unchanged": 0,
    "football_hydrated": 0,
    "consensus_built": 0,
    "consensus_skipped": 0,
    "status_promotions": 0,
    "status_demotions": 0,
    "provider_errors": 0,
    "status_changes": [],
    "guardrails_ok": True,
    "error": None,
}


def parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def local_date(offset_days: int = 0) -> str:
    # Dashboard dates are local-ish YYYY-MM-DD. A UTC date plus tomorrow is enough for near-kickoff coverage.
    return (datetime.now(timezone.utc) + timedelta(days=offset_days)).date().isoformat()


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def safe_upper(value: Any) -> str:
    return str(value or "").strip().upper()


def guardrails_ok(response: Any) -> bool:
    if not isinstance(response, dict):
        return True
    guardrails = response.get("guardrails") if isinstance(response.get("guardrails"), dict) else response
    return (
        int(guardrails.get("real_candidate_count") or 0) == 0
        and not bool(guardrails.get("real_money_enabled") or False)
        and not bool(guardrails.get("kelly_enabled") or False)
        and not bool(guardrails.get("telegram_auto_enabled") or False)
    )


def get(path: str) -> dict[str, Any]:
    if not INTERNAL_API_KEY:
        raise RuntimeError("INTERNAL_API_KEY no configurado")
    result = request_json("GET", f"{HUB_BASE_URL}{path}", headers=HEADERS)
    return result if isinstance(result, dict) else {}


def post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not INTERNAL_API_KEY:
        raise RuntimeError("INTERNAL_API_KEY no configurado")
    result = request_json("POST", f"{HUB_BASE_URL}{path}", headers=HEADERS, payload=payload)
    return result if isinstance(result, dict) else {}


def is_active_match(match: dict[str, Any]) -> bool:
    status = str(match.get("status") or "").lower()
    inactive_markers = ("final", "finished", "complete", "cancel", "postpon", "abandon")
    return not any(marker in status for marker in inactive_markers)


def in_near_kickoff_window(match: dict[str, Any]) -> bool:
    if not NEAR_KICKOFF:
        return True
    start_time = parse_time(match.get("start_time"))
    if start_time is None:
        return True
    now = datetime.now(timezone.utc)
    if SKIP_IF_KICKOFF_PASSED and start_time < now:
        return False
    return now - timedelta(minutes=LOOKBACK_MINUTES) <= start_time <= now + timedelta(hours=LOOKAHEAD_HOURS)


def context_statuses(match: dict[str, Any]) -> set[str]:
    detail = match.get("detail") if isinstance(match.get("detail"), dict) else {}
    intelligence = match.get("intelligence") if isinstance(match.get("intelligence"), dict) else {}
    pick_chain = match.get("pick_chain") if isinstance(match.get("pick_chain"), dict) else {}
    return {
        safe_upper(match.get("final_chain_status")),
        safe_upper(match.get("final_status")),
        safe_upper(match.get("intelligence_status")),
        safe_upper(match.get("player_intelligence_status")),
        safe_upper(detail.get("team_intelligence_status")),
        safe_upper(detail.get("player_intelligence_status")),
        safe_upper(detail.get("matchup_status")),
        safe_upper(intelligence.get("status")),
        safe_upper(pick_chain.get("matchup_status")),
    }


def should_target(match: dict[str, Any]) -> bool:
    if not match.get("match_id") or not is_active_match(match) or not in_near_kickoff_window(match):
        return False
    statuses = context_statuses(match)
    if statuses & TARGET_STATUSES:
        return True
    if INCLUDE_OBSERVATION_ONLY and "OBSERVATION_ONLY" in statuses:
        return True
    return False


def unique_targets(matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    targets: list[dict[str, Any]] = []
    for match in matches:
        match_id = str(match.get("match_id") or "")
        if not match_id or match_id in seen:
            continue
        seen.add(match_id)
        targets.append(match)
    return targets[:MAX_MATCHES]


def load_match_center() -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for date in {local_date(0), local_date(1)}:
        response = get(f"/api/v1/internal/analytics/match-center?date={date}&fallback_recent=true&only_active=true")
        STATE["guardrails_ok"] = STATE["guardrails_ok"] and guardrails_ok(response)
        matches.extend(row for row in as_list(response.get("matches")) if isinstance(row, dict))
    return matches


def target_summary(match: dict[str, Any]) -> dict[str, Any]:
    return {
        "match_id": match.get("match_id"),
        "sport": match.get("sport"),
        "league_id": match.get("league_id"),
        "match": f"{match.get('home_team') or 'Home'} vs {match.get('away_team') or 'Away'}",
        "start_time": match.get("start_time"),
        "status": match.get("status"),
        "context_statuses": sorted(status for status in context_statuses(match) if status),
    }


def hydrate_football(targets: list[dict[str, Any]]) -> None:
    football_targets = [target for target in targets if str(target.get("sport") or "").lower() in {"soccer", "football"}]
    if not football_targets:
        return
    league_ids = sorted({str(target.get("league_id") or "") for target in football_targets if target.get("league_id")})
    match_ids = sorted({str(target.get("match_id") or "") for target in football_targets if target.get("match_id")})
    payload = {
        "dry_run": DRY_RUN,
        "league_ids": league_ids,
        "match_ids": match_ids,
        "priority_only": False,
        "include_lineups": True,
        "include_injuries": True,
        "include_team_stats": True,
        "include_player_stats": True,
        "max_api_requests": MAX_API_REQUESTS,
    }
    response = post("/api/v1/internal/analytics/hydrate-football-intelligence", payload)
    STATE["guardrails_ok"] = STATE["guardrails_ok"] and guardrails_ok(response)
    STATE["football_hydrated"] += int(response.get("target_count") or 0)
    STATE["cache_hits"] += int(response.get("cached_hits") or 0)
    STATE["api_requests"] += int(response.get("would_fetch") or 0) + int(response.get("fetched") or 0)
    STATE["provider_errors"] += int(response.get("errors") or 0)
    for row in as_list(response.get("rows")):
        if not isinstance(row, dict):
            continue
        hydration = row.get("hydration") if isinstance(row.get("hydration"), dict) else {}
        STATE["observations_inserted"] += int(hydration.get("inserted") or hydration.get("observations_inserted") or 0)
        STATE["observations_unchanged"] += int(
            hydration.get("unchanged") or hydration.get("duplicates") or hydration.get("skipped") or 0
        )
    print(
        json.dumps(
            {
                "event": "incremental_football_hydrate",
                "dry_run": DRY_RUN,
                "target_count": response.get("target_count"),
                "would_fetch": response.get("would_fetch"),
                "cached_hits": response.get("cached_hits"),
                "fetched": response.get("fetched"),
                "errors": response.get("errors"),
                "blocked_by_quota": response.get("blocked_by_quota"),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def build_consensus(targets: list[dict[str, Any]]) -> None:
    if ONLY_REBUILD_WHEN_CHANGED and STATE["api_requests"] == 0 and STATE["cache_hits"] == 0 and STATE["observations_inserted"] == 0:
        STATE["consensus_skipped"] += len(targets)
        print(
            json.dumps(
                {
                    "event": "incremental_consensus_skipped",
                    "reason": "ONLY_REBUILD_WHEN_CHANGED and no new/cache data",
                    "count": len(targets),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return
    for target in targets:
        sport = str(target.get("sport") or "football")
        if sport == "soccer":
            sport = "football"
        payload = {
            "dry_run": DRY_RUN,
            "sport": sport,
            "league_id": target.get("league_id") or None,
            "match_id": str(target.get("match_id")),
            "data_types": CONSENSUS_DATA_TYPES,
        }
        response = post("/api/v1/internal/analytics/build-consensus", payload)
        STATE["guardrails_ok"] = STATE["guardrails_ok"] and guardrails_ok(response)
        context_score = response.get("context_score") if isinstance(response.get("context_score"), dict) else {}
        STATE["consensus_built"] += 1
        print(
            json.dumps(
                {
                    "event": "incremental_consensus",
                    "dry_run": DRY_RUN,
                    "match_id": target.get("match_id"),
                    "sport": sport,
                    "league_id": target.get("league_id"),
                    "context_status": context_score.get("context_status"),
                    "overall_context_score": context_score.get("overall_context_score"),
                    "missing_context_fields": context_score.get("missing_context_fields"),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )


def index_by_match_id(matches: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(match.get("match_id")): match for match in matches if match.get("match_id")}


def status_of(match: dict[str, Any] | None) -> str:
    if not match:
        return "MISSING"
    ranks = {
        "NO_CONTEXT": 0,
        "OBSERVATION_ONLY": 1,
        "CONTEXT_GAPS": 2,
        "FOOTBALL_CONTEXT_GAPS": 2,
        "BLOCK_CONFIRMATION": 2,
        "PARTIAL_CONTEXT_REVIEW": 3,
        "MATCHUP_CONTEXT_SUPPORTS": 4,
        "CONFIRMED_PAPER": 5,
        "FOOTBALL_CONFIRMED_PAPER": 5,
    }
    statuses = [status for status in context_statuses(match) if status]
    if not statuses:
        return "NO_CONTEXT"
    return sorted(statuses, key=lambda status: ranks.get(status, 1), reverse=True)[0]


def status_rank(status: str) -> int:
    ranks = {
        "NO_CONTEXT": 0,
        "OBSERVATION_ONLY": 1,
        "CONTEXT_GAPS": 2,
        "FOOTBALL_CONTEXT_GAPS": 2,
        "BLOCK_CONFIRMATION": 2,
        "PARTIAL_CONTEXT_REVIEW": 3,
        "MATCHUP_CONTEXT_SUPPORTS": 4,
        "CONFIRMED_PAPER": 5,
        "FOOTBALL_CONFIRMED_PAPER": 5,
    }
    return ranks.get(status, 1)


def run_cycle() -> None:
    STATE.update(
        {
            "status": "running",
            "last_cycle_at": utc_now(),
            "matches_seen": 0,
            "matches_scanned": 0,
            "matches_in_window": 0,
            "targets": 0,
            "api_requests": 0,
            "cache_hits": 0,
            "observations_inserted": 0,
            "observations_unchanged": 0,
            "football_hydrated": 0,
            "consensus_built": 0,
            "consensus_skipped": 0,
            "status_promotions": 0,
            "status_demotions": 0,
            "provider_errors": 0,
            "status_changes": [],
            "guardrails_ok": True,
            "error": None,
        }
    )
    print(
        json.dumps(
            {
                "event": "sports_context_incremental_cycle_start",
                "at": utc_now(),
                "dry_run": DRY_RUN,
                "near_kickoff": NEAR_KICKOFF,
                "lookahead_hours": LOOKAHEAD_HOURS,
                "lookback_minutes": LOOKBACK_MINUTES,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )

    command_center = get("/api/v1/internal/analytics/command-center")
    STATE["guardrails_ok"] = STATE["guardrails_ok"] and guardrails_ok(command_center)

    before_matches = load_match_center()
    STATE["matches_seen"] = len(before_matches)
    STATE["matches_scanned"] = len(before_matches)
    STATE["matches_in_window"] = sum(1 for match in before_matches if is_active_match(match) and in_near_kickoff_window(match))
    targets = unique_targets([match for match in before_matches if should_target(match)])
    STATE["targets"] = len(targets)
    print(
        json.dumps(
            {
                "event": "incremental_targets_selected",
                "count": len(targets),
                "targets": [target_summary(target) for target in targets],
            },
            ensure_ascii=False,
        ),
        flush=True,
    )

    hydrate_football(targets)
    build_consensus(targets)

    after_matches = load_match_center()
    before_by_id = index_by_match_id(before_matches)
    after_by_id = index_by_match_id(after_matches)
    changes: list[dict[str, Any]] = []
    for target in targets:
        match_id = str(target.get("match_id"))
        before_status = status_of(before_by_id.get(match_id))
        after_status = status_of(after_by_id.get(match_id))
        if before_status != after_status:
            if status_rank(after_status) > status_rank(before_status):
                STATE["status_promotions"] += 1
            elif status_rank(after_status) < status_rank(before_status):
                STATE["status_demotions"] += 1
            changes.append(
                {
                    "match_id": match_id,
                    "match": f"{target.get('home_team') or 'Home'} vs {target.get('away_team') or 'Away'}",
                    "from": before_status,
                    "to": after_status,
                }
            )
    STATE["status_changes"] = changes

    STATE["status"] = "ok" if STATE["guardrails_ok"] else "guardrail_failure"
    print(json.dumps({"event": "sports_context_incremental_cycle_done", **STATE}, ensure_ascii=False), flush=True)


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_response(404)
            self.end_headers()
            return
        payload = json.dumps(STATE, ensure_ascii=False).encode("utf-8")
        self.send_response(200 if STATE["status"] in {"starting", "running", "ok"} else 503)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        return


def serve_health() -> None:
    ThreadingHTTPServer(("0.0.0.0", HEALTH_PORT), HealthHandler).serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="sports-data-hub incremental context worker: near-kickoff context refresh only, no picks."
    )
    parser.add_argument("--once", action="store_true", help="Run one cycle and exit.")
    args = parser.parse_args()

    threading.Thread(target=serve_health, daemon=True).start()
    while True:
        try:
            run_cycle()
        except Exception as exc:
            STATE["status"] = "degraded"
            STATE["error"] = str(exc)
            print(
                json.dumps(
                    {"event": "sports_context_incremental_worker_error", "at": utc_now(), "error": str(exc)},
                    ensure_ascii=False,
                ),
                flush=True,
            )
        if args.once:
            break
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
