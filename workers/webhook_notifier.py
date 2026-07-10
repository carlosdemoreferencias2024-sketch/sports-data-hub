import argparse
import os
from typing import Any

import requests

from base_worker import request_json


HUB_BASE_URL = os.getenv("HUB_BASE_URL", "http://127.0.0.1:4000")
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")


def _headers() -> dict[str, str]:
    if not INTERNAL_API_KEY:
        raise RuntimeError("INTERNAL_API_KEY no esta definido.")
    return {"X-Internal-API-Key": INTERNAL_API_KEY}


def _format_alert(opportunity: dict[str, Any]) -> str:
    ev = float(opportunity["expected_value"]) * 100
    probability = float(opportunity["model_probability"]) * 100
    market_odds = float(opportunity["market_odds"])
    fair_odds = float(opportunity["model_fair_odds"])
    home_team = opportunity.get("home_team_name") or "Home"
    away_team = opportunity.get("away_team_name") or "Away"
    return (
        "[ALPHA EV+]\n"
        f"Match: {home_team} vs {away_team}\n"
        f"Sport: {opportunity['sport_slug']} / {opportunity['league_slug']}\n"
        f"Model: {opportunity['model_name']}\n"
        f"Selection: {opportunity['market_selection']}\n"
        f"Market: {opportunity['provider_name']} {opportunity['market_type']}\n"
        f"EV: {ev:.2f}%\n"
        f"Model prob: {probability:.2f}%\n"
        f"Fair odds: {fair_odds:.4f}\n"
        f"Market odds: {market_odds:.4f}\n"
        f"Alpha ID: {opportunity['id']}"
    )


def fetch_unprocessed_alpha(min_ev: float, limit: int) -> list[dict[str, Any]]:
    result = request_json(
        "GET",
        f"{HUB_BASE_URL.rstrip('/')}/api/v1/internal/model-quotes/alpha-opportunities",
        headers=_headers(),
        params={
            "processed": "false",
            "min_ev": min_ev,
            "limit": limit,
        },
    )
    if not isinstance(result, dict):
        return []
    opportunities = result.get("opportunities", [])
    return opportunities if isinstance(opportunities, list) else []


def send_telegram_alert(message: str) -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        raise RuntimeError("TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID son requeridos para enviar alertas.")
    response = requests.post(
        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
        json={
            "chat_id": TELEGRAM_CHAT_ID,
            "text": message,
            "disable_web_page_preview": True,
        },
        timeout=20,
    )
    response.raise_for_status()


def mark_processed(opportunity_id: str, note: str) -> dict[str, Any]:
    result = request_json(
        "PATCH",
        f"{HUB_BASE_URL.rstrip('/')}/api/v1/internal/model-quotes/alpha-opportunities/{opportunity_id}/process",
        headers=_headers(),
        payload={
            "processed": True,
            "note": note,
        },
    )
    return result if isinstance(result, dict) else {}


def notify(min_ev: float, limit: int, dry_run: bool, mark_processed_on_dry_run: bool) -> tuple[int, int, int]:
    opportunities = fetch_unprocessed_alpha(min_ev=min_ev, limit=limit)
    sent = 0
    marked = 0
    for opportunity in opportunities:
        message = _format_alert(opportunity)
        print("--- alpha_alert ---")
        print(message)
        if dry_run:
            if mark_processed_on_dry_run:
                mark_processed(str(opportunity["id"]), "telegram_alert_dry_run_marked")
                marked += 1
            continue
        send_telegram_alert(message)
        mark_processed(str(opportunity["id"]), "telegram_alert_sent")
        sent += 1
        marked += 1
    return len(opportunities), sent, marked


def main() -> None:
    parser = argparse.ArgumentParser(description="Envia alertas Telegram para Alpha EV+ sin procesar.")
    parser.add_argument("--min-ev", type=float, default=float(os.getenv("ALPHA_NOTIFY_MIN_EV", "0.05")))
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--mark-processed",
        action="store_true",
        help="En dry-run, marca las oportunidades como procesadas despues de imprimirlas.",
    )
    args = parser.parse_args()
    found, sent, marked = notify(
        min_ev=args.min_ev,
        limit=args.limit,
        dry_run=args.dry_run,
        mark_processed_on_dry_run=args.mark_processed,
    )
    print(
        "[+] Webhook notifier finalizado "
        f"found={found} sent={sent} marked={marked} dry_run={args.dry_run}"
    )


if __name__ == "__main__":
    main()
