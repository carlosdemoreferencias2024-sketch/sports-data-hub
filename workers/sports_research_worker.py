import argparse
import glob
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from base_worker import request_json, utc_now


HUB_BASE_URL = os.getenv("HUB_BASE_URL", "http://engine-node:3000").rstrip("/")
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "").strip()
RESEARCH_INTERVAL_SECONDS = max(300, int(os.getenv("SPORTS_RESEARCH_INTERVAL_SECONDS", "1800")))
RESEARCH_HEALTH_PORT = int(os.getenv("SPORTS_RESEARCH_HEALTH_PORT", "8080"))
RESEARCH_DRY_RUN = os.getenv("SPORTS_RESEARCH_DRY_RUN", "true").strip().lower() not in {"0", "false", "no"}
RESEARCH_AUTO_CONSENSUS = os.getenv("SPORTS_RESEARCH_AUTO_CONSENSUS", "true").strip().lower() not in {
    "0",
    "false",
    "no",
}
RESEARCH_PAYLOAD_DIRS = [
    item.strip()
    for item in os.getenv("SPORTS_RESEARCH_PAYLOAD_DIRS", "/research-payloads,/scripts").split(",")
    if item.strip()
]
RESEARCH_FILE_GLOBS = [
    item.strip()
    for item in os.getenv(
        "SPORTS_RESEARCH_FILE_GLOBS",
        "sports_research_*.json,football_hydrate*.json,historical_intelligence*.json",
    ).split(",")
    if item.strip()
]
RESEARCH_MAX_FILES = max(1, int(os.getenv("SPORTS_RESEARCH_MAX_FILES", "25")))
APPLY_ALLOWED_FIELD = "research_worker_apply_allowed"

HEADERS = {
    "X-API-Key": INTERNAL_API_KEY,
    "X-Internal-API-Key": INTERNAL_API_KEY,
}

STATE: dict[str, Any] = {
    "status": "starting",
    "last_cycle_at": None,
    "dry_run": RESEARCH_DRY_RUN,
    "files_seen": 0,
    "source_observations": 0,
    "context_records": 0,
    "historical_matches": 0,
    "consensus_built": 0,
    "guardrails_ok": True,
    "error": None,
}


def as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if value is None:
        return []
    return [value]


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        print(
            json.dumps({"event": "research_file_skipped", "path": str(path), "error": str(exc)}, ensure_ascii=False),
            flush=True,
        )
        return None
    return payload if isinstance(payload, dict) else None


def file_candidates() -> list[Path]:
    files: list[Path] = []
    for directory in RESEARCH_PAYLOAD_DIRS:
        base = Path(directory)
        if not base.exists():
            continue
        for pattern in RESEARCH_FILE_GLOBS:
            files.extend(Path(path) for path in glob.glob(str(base / pattern)))
    unique = sorted(set(files), key=lambda path: path.stat().st_mtime if path.exists() else 0, reverse=True)
    return unique[:RESEARCH_MAX_FILES]


def has_context_payload(payload: dict[str, Any]) -> bool:
    keys = (
        "team_profiles",
        "player_profiles",
        "match_history",
        "team_match_stats",
        "player_match_stats",
        "match_lineups",
        "player_availability",
    )
    return any(isinstance(payload.get(key), list) and payload.get(key) for key in keys)


def infer_consensus_targets(payload: dict[str, Any]) -> set[tuple[str, str, str]]:
    targets: set[tuple[str, str, str]] = set()
    for observation in as_list(payload.get("observations")):
        if not isinstance(observation, dict):
            continue
        sport = str(observation.get("sport") or "football")
        league_id = str(observation.get("league_id") or "")
        match_id = str(observation.get("match_id") or "")
        if match_id:
            targets.add((sport, league_id, match_id))
    for key in ("match_history", "team_match_stats", "player_match_stats", "match_lineups", "player_availability"):
        for row in as_list(payload.get(key)):
            if not isinstance(row, dict):
                continue
            sport = str(row.get("sport") or "football")
            league_id = str(row.get("league_id") or "")
            match_id = str(row.get("match_id") or "")
            if match_id:
                targets.add((sport, league_id, match_id))
    return targets


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


def post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not INTERNAL_API_KEY:
        raise RuntimeError("INTERNAL_API_KEY no configurado")
    result = request_json("POST", f"{HUB_BASE_URL}{path}", headers=HEADERS, payload=payload)
    return result if isinstance(result, dict) else {}


def get(path: str) -> dict[str, Any]:
    if not INTERNAL_API_KEY:
        raise RuntimeError("INTERNAL_API_KEY no configurado")
    result = request_json("GET", f"{HUB_BASE_URL}{path}", headers=HEADERS)
    return result if isinstance(result, dict) else {}


def run_cycle() -> None:
    STATE.update(
        {
            "status": "running",
            "last_cycle_at": utc_now(),
            "files_seen": 0,
            "source_observations": 0,
            "context_records": 0,
            "historical_matches": 0,
            "consensus_built": 0,
            "guardrails_ok": True,
            "error": None,
        }
    )
    print(
        json.dumps({"event": "sports_research_cycle_start", "at": utc_now(), "dry_run": RESEARCH_DRY_RUN}, ensure_ascii=False),
        flush=True,
    )

    command_center = get("/api/trading/command-center")
    STATE["guardrails_ok"] = STATE["guardrails_ok"] and guardrails_ok(command_center)

    all_targets: dict[tuple[str, str, str], bool] = {}
    for path in file_candidates():
        payload = read_json(path)
        if payload is None:
            continue
        STATE["files_seen"] += 1
        effective_dry_run = RESEARCH_DRY_RUN
        if not RESEARCH_DRY_RUN and payload.get(APPLY_ALLOWED_FIELD) is not True:
            effective_dry_run = True
            print(
                json.dumps(
                    {
                        "event": "research_apply_blocked",
                        "file": str(path),
                        "reason": f"{APPLY_ALLOWED_FIELD}=true requerido para escribir",
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        payload["dry_run"] = effective_dry_run
        targets = infer_consensus_targets(payload)
        for target in targets:
            all_targets[target] = all_targets.get(target, True) and effective_dry_run

        if isinstance(payload.get("observations"), list) and payload["observations"]:
            response = post("/api/v1/internal/analytics/source-observations", payload)
            STATE["source_observations"] += int(response.get("would_insert") or response.get("inserted") or 0)
            STATE["guardrails_ok"] = STATE["guardrails_ok"] and guardrails_ok(response)
            print(
                json.dumps(
                    {
                        "event": "research_source_observations",
                        "file": str(path),
                        "status": response.get("status"),
                        "count": STATE["source_observations"],
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

        if has_context_payload(payload):
            response = post("/api/v1/internal/analytics/sports-context-ingest", payload)
            rows = response.get("rows") if isinstance(response.get("rows"), list) else []
            STATE["context_records"] += len(rows)
            STATE["guardrails_ok"] = STATE["guardrails_ok"] and guardrails_ok(response)
            print(
                json.dumps(
                    {
                        "event": "research_context_ingest",
                        "file": str(path),
                        "status": response.get("status"),
                        "rows": len(rows),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

        matches = payload.get("matches")
        if isinstance(matches, list) and matches:
            response = post("/api/v1/internal/analytics/ingest-historical-matches", payload)
            STATE["historical_matches"] += int(
                response.get("would_upsert") or response.get("inserted") or response.get("updated") or 0
            )
            STATE["guardrails_ok"] = STATE["guardrails_ok"] and guardrails_ok(response)
            print(
                json.dumps(
                    {
                        "event": "research_historical_matches",
                        "file": str(path),
                        "status": response.get("system_status"),
                        "count": STATE["historical_matches"],
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

    if RESEARCH_AUTO_CONSENSUS:
        for (sport, league_id, match_id), target_dry_run in sorted(all_targets.items()):
            payload = {
                "dry_run": target_dry_run,
                "sport": sport,
                "league_id": league_id,
                "match_id": match_id,
                "data_types": ["fixture", "kickoff", "lineup", "injuries", "team_stats", "player_stats"],
            }
            response = post("/api/v1/internal/analytics/build-consensus", payload)
            STATE["consensus_built"] += 1
            STATE["guardrails_ok"] = STATE["guardrails_ok"] and guardrails_ok(response)
            context_score = response.get("context_score") if isinstance(response.get("context_score"), dict) else {}
            print(
                json.dumps(
                    {
                        "event": "research_consensus",
                        "match_id": match_id,
                        "context_status": context_score.get("context_status"),
                        "score": context_score.get("overall_context_score"),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

    STATE["status"] = "ok" if STATE["guardrails_ok"] else "guardrail_failure"
    print(json.dumps({"event": "sports_research_cycle_done", **STATE}, ensure_ascii=False), flush=True)


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
    ThreadingHTTPServer(("0.0.0.0", RESEARCH_HEALTH_PORT), HealthHandler).serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="sports-data-hub research worker: data collection orchestration only, no picks.")
    parser.add_argument("--once", action="store_true", help="Run one cycle and exit.")
    args = parser.parse_args()

    threading.Thread(target=serve_health, daemon=True).start()
    while True:
        try:
            run_cycle()
        except Exception as exc:
            STATE["status"] = "degraded"
            STATE["error"] = str(exc)
            print(json.dumps({"event": "sports_research_worker_error", "at": utc_now(), "error": str(exc)}, ensure_ascii=False), flush=True)
        if args.once:
            break
        time.sleep(RESEARCH_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
