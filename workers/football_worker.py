import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from base_worker import request_json, utc_now


FOOTBALL_DATA_URL = os.getenv("FOOTBALL_DATA_URL", "").strip()
FOOTBALL_API_KEY = os.getenv("FOOTBALL_API_KEY", "").strip()
FOOTBALL_API_HOST = os.getenv("FOOTBALL_API_HOST", "free-api-live-football-data.p.rapidapi.com").strip()
FOOTBALL_WORKER_INTERVAL_SECONDS = max(60, int(os.getenv("FOOTBALL_WORKER_INTERVAL_SECONDS", "900")))
FOOTBALL_WORKER_HEALTH_PORT = int(os.getenv("FOOTBALL_WORKER_HEALTH_PORT", "8080"))

STATE: dict[str, Any] = {
    "status": "idle" if not FOOTBALL_DATA_URL else "starting",
    "last_cycle_at": None,
    "rows": 0,
    "error": None,
}


def extract_rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("data", "response", "results", "matches", "items"):
        rows = payload.get(key)
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    return []


def run_cycle() -> None:
    STATE["last_cycle_at"] = utc_now()
    if not FOOTBALL_DATA_URL:
        STATE["status"] = "idle"
        STATE["error"] = "FOOTBALL_DATA_URL no configurado"
        print(
            json.dumps(
                {
                    "event": "football_worker_idle",
                    "at": utc_now(),
                    "reason": "FOOTBALL_DATA_URL no configurado",
                }
            ),
            flush=True,
        )
        return

    payload = request_json(
        "GET",
        FOOTBALL_DATA_URL,
        headers={
            "x-rapidapi-key": FOOTBALL_API_KEY,
            "x-rapidapi-host": FOOTBALL_API_HOST,
        },
    )
    rows = extract_rows(payload)
    STATE["status"] = "ok"
    STATE["rows"] = len(rows)
    STATE["error"] = None
    print(
        json.dumps(
            {
                "event": "football_data_cycle",
                "at": utc_now(),
                "rows": len(rows),
                "market_quotes_persisted": 0,
                "note": "Adaptador data-only: requiere endpoint de odds confirmado para publicar cuotas.",
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_response(404)
            self.end_headers()
            return
        payload = json.dumps(STATE).encode("utf-8")
        self.send_response(200 if STATE["status"] in {"idle", "starting", "ok"} else 503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        return


def serve_health() -> None:
    ThreadingHTTPServer(("0.0.0.0", FOOTBALL_WORKER_HEALTH_PORT), HealthHandler).serve_forever()


def main() -> None:
    threading.Thread(target=serve_health, daemon=True).start()
    while True:
        try:
            run_cycle()
        except Exception as exc:
            STATE["status"] = "degraded"
            STATE["error"] = str(exc)
            print(
                json.dumps(
                    {"event": "football_worker_error", "at": utc_now(), "error": str(exc)},
                    ensure_ascii=False,
                ),
                flush=True,
            )
        time.sleep(FOOTBALL_WORKER_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
