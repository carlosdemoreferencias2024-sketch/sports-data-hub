from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from urllib.request import Request, urlopen


SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event={event_id}"
ODDS_URL = (
    "https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/"
    "{event_id}/competitions/{event_id}/odds?lang=en&region=us"
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def fetch_json(url: str, timeout: int) -> dict:
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "sports-data-hub-market-capture/1.0 (manual-verification-required)",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"SOURCE_HTTP_{response.status}")
        return json.loads(response.read().decode("utf-8"))


def normalize_team(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def american_number(value: object) -> int:
    if isinstance(value, dict):
        value = value.get("american") or value.get("alternateDisplayValue") or value.get("value")
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
    raise ValueError("American odds must be at least +100 or at most -100")


def current_moneyline(side: dict) -> int:
    current = side.get("current") or {}
    return american_number(current.get("moneyLine") or side.get("moneyLine"))


def event_context(summary: dict, event_id: str) -> dict:
    header = summary.get("header") or {}
    if str(header.get("id")) != event_id:
        raise RuntimeError("EVENT_ID_MISMATCH")
    competitions = header.get("competitions") or []
    if not competitions:
        raise RuntimeError("EVENT_COMPETITION_MISSING")
    competition = competitions[0]
    competitors = competition.get("competitors") or []
    by_side = {str(row.get("homeAway")): row for row in competitors}
    if "home" not in by_side or "away" not in by_side:
        raise RuntimeError("EVENT_HOME_AWAY_MISSING")

    status_type = (competition.get("status") or {}).get("type") or {}
    state = str(status_type.get("state") or "").lower()
    completed = bool(status_type.get("completed"))
    if state != "pre" or completed:
        raise RuntimeError(f"POST_KICKOFF_AUDIT_ONLY: state={state or 'unknown'}")

    kickoff_raw = competition.get("date")
    if not kickoff_raw:
        raise RuntimeError("EVENT_KICKOFF_MISSING")
    kickoff = datetime.fromisoformat(str(kickoff_raw).replace("Z", "+00:00")).astimezone(timezone.utc)

    def team(side: str) -> dict:
        row = by_side[side]
        value = row.get("team") or {}
        return {
            "id": str(value.get("id") or row.get("id") or ""),
            "name": str(value.get("displayName") or value.get("name") or "").strip(),
            "abbreviation": str(value.get("abbreviation") or "").strip(),
        }

    home = team("home")
    away = team("away")
    if not home["name"] or not away["name"]:
        raise RuntimeError("EVENT_TEAM_NAME_MISSING")
    return {"home": home, "away": away, "kickoff": kickoff, "status": "scheduled"}


def market_context(payload: dict, bookmaker: str) -> dict:
    items = payload.get("items") or []
    selected = next(
        (
            row
            for row in items
            if str((row.get("provider") or {}).get("name") or "").strip().lower() == bookmaker.lower()
        ),
        None,
    )
    if not selected:
        raise RuntimeError("MARKET_BOOKMAKER_MISSING")
    home_american = current_moneyline(selected.get("homeTeamOdds") or {})
    away_american = current_moneyline(selected.get("awayTeamOdds") or {})
    return {
        "bookmaker": str((selected.get("provider") or {}).get("name") or bookmaker),
        "provider_id": str((selected.get("provider") or {}).get("id") or ""),
        "home_american": home_american,
        "away_american": away_american,
        "home_decimal": american_to_decimal(home_american),
        "away_decimal": american_to_decimal(away_american),
    }


def find_chrome(explicit: str | None) -> Path:
    candidates = [
        explicit,
        os.environ.get("CHROME_PATH"),
        shutil.which("chrome.exe"),
        shutil.which("msedge.exe"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise RuntimeError("CHROME_EXECUTABLE_NOT_FOUND")


def capture_source_screenshot(chrome: Path, url: str, output: Path, timeout: int) -> None:
    with tempfile.TemporaryDirectory(prefix="sdh-market-chrome-") as profile:
        command = [
            str(chrome),
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            "--force-device-scale-factor=0.75",
            "--window-size=1920,5000",
            f"--user-data-dir={profile}",
            f"--screenshot={output}",
            url,
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "unknown chrome failure").strip()
        raise RuntimeError(f"SCREENSHOT_CAPTURE_FAILED: {message[-500:]}")
    if not output.is_file() or output.stat().st_size < 1000:
        raise RuntimeError("SCREENSHOT_CAPTURE_EMPTY")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def capture(args: argparse.Namespace) -> dict:
    event_id = str(args.event_id).strip()
    if not re.fullmatch(r"\d+", event_id):
        raise RuntimeError("EVENT_ID_INVALID")

    summary_url = SUMMARY_URL.format(event_id=event_id)
    source_url = ODDS_URL.format(event_id=event_id)
    summary = fetch_json(summary_url, args.timeout)
    context = event_context(summary, event_id)
    now = utc_now()
    minutes_to_kickoff = (context["kickoff"] - now).total_seconds() / 60
    if minutes_to_kickoff <= 0:
        raise RuntimeError("POST_KICKOFF_AUDIT_ONLY")
    if args.snapshot_type == "current" and not 20 <= minutes_to_kickoff <= 1440:
        raise RuntimeError(f"OUTSIDE_CURRENT_WINDOW: minutes_to_kickoff={minutes_to_kickoff:.1f}")
    if args.snapshot_type == "closing" and not 3 <= minutes_to_kickoff <= 10:
        raise RuntimeError(f"OUTSIDE_CLOSING_WINDOW: minutes_to_kickoff={minutes_to_kickoff:.1f}")

    if args.expected_home and normalize_team(args.expected_home) != normalize_team(context["home"]["name"]):
        raise RuntimeError(f"HOME_TEAM_MISMATCH: expected={args.expected_home} actual={context['home']['name']}")
    if args.expected_away and normalize_team(args.expected_away) != normalize_team(context["away"]["name"]):
        raise RuntimeError(f"AWAY_TEAM_MISMATCH: expected={args.expected_away} actual={context['away']['name']}")

    odds_before = fetch_json(source_url, args.timeout)
    market_before = market_context(odds_before, args.bookmaker)
    stamp = utc_now()
    output_dir = Path(args.output_root) / stamp.strftime("%Y-%m-%d") / stamp.strftime("%H%M%S")
    output_dir.mkdir(parents=True, exist_ok=True)
    screenshot_path = output_dir / f"espn__{event_id}__{args.snapshot_type}_odds.png"
    capture_source_screenshot(find_chrome(args.chrome_path), source_url, screenshot_path, args.browser_timeout)
    captured_at = utc_now()

    odds_after = fetch_json(source_url, args.timeout)
    market_after = market_context(odds_after, args.bookmaker)
    price_fields = ("home_american", "away_american", "bookmaker")
    if any(market_before[key] != market_after[key] for key in price_fields):
        screenshot_path.unlink(missing_ok=True)
        raise RuntimeError("MARKET_MOVED_DURING_CAPTURE")

    screenshot_sha256 = sha256_file(screenshot_path)
    raw_canonical = canonical_json(odds_after)
    provider_raw_sha256 = hashlib.sha256(raw_canonical.encode("utf-8")).hexdigest()
    match_fingerprint = hashlib.sha256(
        f"{context['home']['name']}|{context['away']['name']}|{iso_z(context['kickoff'])}".encode("utf-8")
    ).hexdigest()[:32]
    capture_type = "closing_odds" if args.snapshot_type == "closing" else "current_odds"
    odds_rows = [
        {
            "market_type": "moneyline_2way",
            "selection": "home",
            "american_odds": market_after["home_american"],
            "decimal_odds": market_after["home_decimal"],
            "odds_format": "decimal",
        },
        {
            "market_type": "moneyline_2way",
            "selection": "away",
            "american_odds": market_after["away_american"],
            "decimal_odds": market_after["away_decimal"],
            "odds_format": "decimal",
        },
    ]
    normalized_event = {
        "source": "espn",
        "source_event_id": event_id,
        "sport": "baseball",
        "league": "Major League Baseball",
        "competition": "MLB",
        "starts_at": iso_z(context["kickoff"]),
        "status": context["status"],
        "home": context["home"],
        "away": context["away"],
        "odds": odds_rows,
        "detail_level": "market",
        "observed_at": iso_z(captured_at),
    }
    data = {
        "provider": "espn_public_odds",
        "provider_event_id": event_id,
        "match_fingerprint": match_fingerprint,
        "competition": "MLB",
        "scheduled_kickoff": iso_z(context["kickoff"]),
        "status": context["status"],
        "market": "moneyline_2way",
        "snapshot_type": args.snapshot_type,
        "bookmaker": market_after["bookmaker"],
        "odds_timestamp": iso_z(captured_at),
        "odds": odds_rows,
        "screenshot_sha256": screenshot_sha256,
        "provider_raw_sha256": provider_raw_sha256,
        "normalized_event": normalized_event,
    }
    evidence_payload = {
        "capture_type": capture_type,
        "captured_at": iso_z(captured_at),
        "data": data,
        "source_url": source_url,
        "screenshot_sha256": screenshot_sha256,
    }
    evidence_canonical_json = canonical_json(evidence_payload)
    evidence_sha256 = hashlib.sha256(evidence_canonical_json.encode("utf-8")).hexdigest()
    draft = {
        "schema_version": "sports-data-hub.source-capture-draft.v1",
        "workflow_state": "PENDING_HUMAN_VERIFICATION",
        "auto_post": False,
        "match_id": args.match_id or None,
        "source_name": "sportsbook_manual_verified",
        "source_url": source_url,
        "bookmaker": market_after["bookmaker"],
        "captured_at": iso_z(captured_at),
        "verified_by": None,
        "evidence_id": evidence_sha256[:32],
        "evidence_sha256": evidence_sha256,
        "evidence_canonical_json": evidence_canonical_json,
        "screenshot_path": screenshot_path.name,
        "screenshot_sha256": screenshot_sha256,
        "capture_type": capture_type,
        "sport": "baseball",
        "source_event_id": event_id,
        "match_fingerprint": match_fingerprint,
        "data": data,
        "guardrails": {
            "picks_created": 0,
            "real_candidate": 0,
            "real_money_enabled": False,
            "kelly_enabled": False,
            "telegram_auto_enabled": False,
            "human_verification_required": True,
        },
    }
    draft_path = output_dir / f"espn__{event_id}__{evidence_sha256[:32]}.json"
    draft_path.write_text(json.dumps(draft, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    (output_dir / f"espn__{event_id}__source_response.json").write_text(
        json.dumps(odds_after, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )
    return {
        "status": "PENDING_HUMAN_VERIFICATION",
        "draft_path": str(draft_path.resolve()),
        "screenshot_path": str(screenshot_path.resolve()),
        "screenshot_sha256": screenshot_sha256,
        "evidence_id": evidence_sha256[:32],
        "event_id": event_id,
        "match_id": args.match_id or None,
        "bookmaker": market_after["bookmaker"],
        "home": context["home"]["name"],
        "away": context["away"]["name"],
        "home_american": market_after["home_american"],
        "away_american": market_after["away_american"],
        "home_decimal": market_after["home_decimal"],
        "away_decimal": market_after["away_decimal"],
        "captured_at": iso_z(captured_at),
        "minutes_to_kickoff": round((context["kickoff"] - captured_at).total_seconds() / 60, 1),
        "picks_created": 0,
        "real_candidate": 0,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Capture visible ESPN MLB moneyline evidence for human review.")
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--match-id", default="")
    parser.add_argument("--expected-home", default="")
    parser.add_argument("--expected-away", default="")
    parser.add_argument("--bookmaker", default="DraftKings")
    parser.add_argument("--snapshot-type", choices=["current", "closing"], default="current")
    parser.add_argument("--output-root", default=str(Path(__file__).resolve().parents[1] / "uploads" / "source-captures" / "scraper-inbox"))
    parser.add_argument("--chrome-path", default="")
    parser.add_argument("--timeout", type=int, default=20)
    parser.add_argument("--browser-timeout", type=int, default=45)
    return parser


def main() -> int:
    try:
        result = capture(build_parser().parse_args())
        print(json.dumps(result, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "REJECTED", "reason": str(exc), "picks_created": 0, "real_candidate": 0}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
