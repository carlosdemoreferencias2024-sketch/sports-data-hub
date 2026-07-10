import email.utils
import json
import os
import random
import time
from datetime import datetime, timezone
from typing import Any

import requests


REQUEST_TIMEOUT_SECONDS = float(os.getenv("WORKER_REQUEST_TIMEOUT_SECONDS", "20"))
HTTP_MAX_RETRIES = max(0, int(os.getenv("WORKER_HTTP_MAX_RETRIES", "4")))
HTTP_BACKOFF_BASE_SECONDS = max(0.1, float(os.getenv("WORKER_HTTP_BACKOFF_BASE_SECONDS", "15")))
HTTP_BACKOFF_MAX_SECONDS = max(
    HTTP_BACKOFF_BASE_SECONDS,
    float(os.getenv("WORKER_HTTP_BACKOFF_MAX_SECONDS", "300")),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _retry_after_seconds(response: requests.Response) -> float | None:
    value = response.headers.get("Retry-After")
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            retry_at = email.utils.parsedate_to_datetime(value)
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            return max(0.0, (retry_at - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError):
            return None


def request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    payload: Any = None,
    timeout: float = REQUEST_TIMEOUT_SECONDS,
) -> Any:
    last_response: requests.Response | None = None
    for attempt in range(HTTP_MAX_RETRIES + 1):
        try:
            response = requests.request(
                method,
                url,
                headers=headers,
                params=params,
                json=payload,
                timeout=timeout,
            )
        except requests.RequestException as exc:
            if attempt >= HTTP_MAX_RETRIES:
                raise
            delay = min(
                HTTP_BACKOFF_MAX_SECONDS,
                HTTP_BACKOFF_BASE_SECONDS * (2**attempt),
            ) + random.uniform(0, 1)
            print(
                json.dumps(
                    {
                        "event": "http_backoff",
                        "error": type(exc).__name__,
                        "attempt": attempt + 1,
                        "max_retries": HTTP_MAX_RETRIES,
                        "sleep_seconds": round(delay, 2),
                        "url": url,
                    }
                ),
                flush=True,
            )
            time.sleep(delay)
            continue
        last_response = response
        if response.ok:
            return response.json()

        retryable = response.status_code == 429 or 500 <= response.status_code < 600
        if not retryable or attempt >= HTTP_MAX_RETRIES:
            response.raise_for_status()

        retry_after = _retry_after_seconds(response)
        exponential = min(
            HTTP_BACKOFF_MAX_SECONDS,
            HTTP_BACKOFF_BASE_SECONDS * (2**attempt),
        )
        delay = retry_after if retry_after is not None else exponential
        delay = min(HTTP_BACKOFF_MAX_SECONDS, delay) + random.uniform(0, 1)
        print(
            json.dumps(
                {
                    "event": "http_backoff",
                    "status_code": response.status_code,
                    "attempt": attempt + 1,
                    "max_retries": HTTP_MAX_RETRIES,
                    "sleep_seconds": round(delay, 2),
                    "url": url,
                }
            ),
            flush=True,
        )
        time.sleep(delay)

    if last_response is not None:
        last_response.raise_for_status()
    raise RuntimeError(f"No se obtuvo respuesta de {url}")


def post_quotes(hub_url: str, headers: dict[str, str], quotes: list[dict[str, Any]]) -> dict[str, Any]:
    result = request_json("POST", hub_url, headers=headers, payload={"quotes": quotes})
    return result if isinstance(result, dict) else {}


def post_raw_provider_events(
    hub_base_url: str,
    headers: dict[str, str],
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    if not events:
        return {"received": 0, "inserted": 0, "updated": 0}
    result = request_json(
        "POST",
        f"{hub_base_url.rstrip('/')}/api/v1/internal/mappings/raw-events",
        headers=headers,
        payload={"events": events},
    )
    return result if isinstance(result, dict) else {}


def get_hub_match_id(
    hub_base_url: str,
    headers: dict[str, str],
    provider_name: str,
    provider_event_id: str,
) -> str | None:
    url = f"{hub_base_url.rstrip('/')}/api/v1/internal/mappings/{provider_name}/{provider_event_id}"
    try:
        result = request_json("GET", url, headers=headers)
        if isinstance(result, dict):
            match_id = result.get("hub_match_id")
            return str(match_id) if match_id else None
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else None
        if status_code in {404, 409}:
            return None
        raise
    return None
