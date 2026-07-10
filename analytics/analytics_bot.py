import json
import math
import os
from datetime import datetime

import requests


API_BASE_URL = os.getenv("API_BASE_URL", "http://engine-node:3000").rstrip("/")
API_V1_URL = os.getenv("API_URL", f"{API_BASE_URL}/api/v1").rstrip("/")
LEAGUES = [item.strip() for item in os.getenv("ANALYTICS_LEAGUES", "liga-mx,mlb").split(",") if item.strip()]
TIMEOUT_SECONDS = int(os.getenv("ANALYTICS_TIMEOUT_SECONDS", "10"))
SIMULATED_HOME_ODDS = float(os.getenv("SIMULATED_HOME_ODDS", "2.00"))
SIMULATED_AWAY_ODDS = float(os.getenv("SIMULATED_AWAY_ODDS", "2.00"))
MIN_EV_THRESHOLD = float(os.getenv("MIN_EV_THRESHOLD", "0.02"))
MIN_PLAYED_FOR_SIGNAL = int(os.getenv("MIN_PLAYED_FOR_SIGNAL", "2"))
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "replace_with_local_internal_api_key")
PAPER_TRADE_ENABLED = os.getenv("PAPER_TRADE_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
MODEL_VERSION = os.getenv("MODEL_VERSION", "pronostix-v2-snapshots")


def get_json(path: str):
    normalized_path = path[7:] if path.startswith("/api/v1") else path
    response = requests.get(f"{API_V1_URL}{normalized_path}", timeout=TIMEOUT_SECONDS)
    response.raise_for_status()
    return response.json()


def weighted_inertia(form: list[str]) -> float:
    if not form:
        return 0.5

    weights = [1.0, 0.8, 0.6, 0.4, 0.2]
    score_by_result = {"W": 1.0, "D": 0.5, "L": 0.0}
    limited_form = form[: len(weights)]
    weighted_points = 0.0
    total_weight = 0.0

    for index, result in enumerate(limited_form):
        weight = weights[index]
        total_weight += weight
        weighted_points += score_by_result.get(result, 0.0) * weight

    return weighted_points / total_weight if total_weight else 0.5


def decimal_ev(probability: float, decimal_odds: float, stake: float = 1.0) -> float:
    potential_profit = decimal_odds - 1.0
    losing_probability = 1.0 - probability
    return (probability * potential_profit * stake) - (losing_probability * stake)


def quarter_kelly(probability: float, decimal_odds: float) -> dict:
    if not decimal_odds or decimal_odds <= 1:
        return {"suggested_stake": 0, "bankroll_allocation": "0.0%", "bankroll_fraction": 0.0}

    b = decimal_odds - 1.0
    q = 1.0 - probability
    full_kelly = ((b * probability) - q) / b
    fractional = max(full_kelly, 0.0) * 0.25
    final_fraction = min(max(fractional, 0.005), 0.05)
    stake_visual = 1
    if final_fraction >= 0.04:
        stake_visual = 5
    elif final_fraction >= 0.03:
        stake_visual = 4
    elif final_fraction >= 0.02:
        stake_visual = 3
    elif final_fraction >= 0.01:
        stake_visual = 2

    return {
        "suggested_stake": stake_visual,
        "bankroll_allocation": f"{final_fraction * 100:.1f}%",
        "bankroll_fraction": round(final_fraction, 4),
    }


def parse_market_odds(value) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 1.0 else None


def clamp(value: float, low: float = 0.05, high: float = 0.95) -> float:
    return max(low, min(high, value))


def safe_divide(numerator: float, denominator: float, fallback: float = 1.0) -> float:
    if denominator <= 0:
        return fallback
    return numerator / denominator


def league_averages(table: list[dict]) -> dict[str, float]:
    played_rows = [row for row in table if (row.get("played") or 0) > 0]
    if not played_rows:
        return {"for_per_game": 1.0, "against_per_game": 1.0}

    total_for = sum(row.get("goals_for", 0) for row in played_rows)
    total_against = sum(row.get("goals_against", 0) for row in played_rows)
    total_played = sum(row.get("played", 0) for row in played_rows)

    return {
        "for_per_game": safe_divide(total_for, total_played),
        "against_per_game": safe_divide(total_against, total_played),
    }


def enrich_team(row: dict, averages: dict[str, float], form: list[str]) -> dict:
    played = row.get("played", 0) or 0
    for_per_game = safe_divide(row.get("goals_for", 0), played, 0.0) if played else 0.0
    against_per_game = safe_divide(row.get("goals_against", 0), played, 0.0) if played else 0.0

    offensive_rating = safe_divide(for_per_game, averages["for_per_game"]) if played else 1.0
    defensive_rating = safe_divide(against_per_game, averages["against_per_game"]) if played else 1.0
    inertia = weighted_inertia(form)

    return {
        **row,
        "form": form,
        "inertia": inertia,
        "for_per_game": for_per_game,
        "against_per_game": against_per_game,
        "offensive_rating": offensive_rating,
        "defensive_rating": defensive_rating,
    }


def competitor(match: dict, side: str) -> dict | None:
    for item in match.get("competitors", []):
        if item.get("home_away") == side:
            return item
    return None


def projected_home_probability(home: dict, away: dict, league_average: float | None = None, sport: str = "") -> float:
    average = league_average or max((home.get("for_per_game", 0) + away.get("for_per_game", 0)) / 2, 1.0)
    mu_home_base = home["offensive_rating"] * away["defensive_rating"] * average
    mu_away_base = away["offensive_rating"] * home["defensive_rating"] * average
    mu_home = mu_home_base * (home["inertia"] + 0.5)
    mu_away = mu_away_base * (away["inertia"] + 0.5)
    differential = mu_home - mu_away
    k = 0.28 if sport == "baseball" else 0.42
    home_field = 0.035 if sport == "baseball" else 0.055
    logistic = 1.0 / (1.0 + math.exp(-k * differential))
    return clamp(logistic + home_field)


def calcular_probabilidad_endogena_mlb(partido: dict, stats_home: dict, stats_away: dict, promedio_carreras_liga: float = 4.5) -> float:
    return projected_home_probability(stats_home, stats_away, promedio_carreras_liga, partido.get("sport_slug", "baseball"))


def evaluate_bet_contract(
    *,
    pick_detected: str,
    probability: float,
    market_odds: float | None,
    odds_source: str,
    home_played: int,
    away_played: int,
) -> dict:
    fair_odds = 1 / max(probability, 0.01)
    ev_real = decimal_ev(probability, market_odds) if market_odds else -1.0
    base = {
        "pick_detected": pick_detected,
        "odds_source": odds_source,
        "model_probability": round(probability, 4),
        "fair_odds": round(fair_odds, 3),
        "market_odds": round(market_odds, 3) if market_odds else None,
        "expected_value": round(ev_real, 4),
        "value_confirmed": bool(odds_source == "market_odds" and market_odds and ev_real > MIN_EV_THRESHOLD),
        "bet_allowed": False,
        "no_bet_reason": None,
        "suggested_stake": 0,
        "bankroll_allocation": "0.0%",
        "bankroll_fraction": 0.0,
        "analysis_note": "",
    }

    if odds_source != "market_odds" or not market_odds:
        return {
            **base,
            "no_bet_reason": "NO_REAL_MARKET_ODDS_AVAILABLE",
            "analysis_note": f"Pick estadistico en shadow mode. Fuente de cuota: {odds_source}.",
        }
    if home_played < MIN_PLAYED_FOR_SIGNAL or away_played < MIN_PLAYED_FOR_SIGNAL:
        return {
            **base,
            "no_bet_reason": "SAMPLE_SIZE_TOO_LOW",
            "analysis_note": (
                f"Muestra insuficiente ({home_played}v{away_played}). "
                f"Se requieren minimo {MIN_PLAYED_FOR_SIGNAL} juegos por equipo."
            ),
        }
    if ev_real <= MIN_EV_THRESHOLD:
        return {
            **base,
            "no_bet_reason": "NEGATIVE_OR_INSUFFICIENT_EV",
            "analysis_note": f"EV calculado ({ev_real * 100:.1f}%) por debajo del umbral minimo del {MIN_EV_THRESHOLD * 100:.1f}%.",
        }

    kelly = quarter_kelly(probability, market_odds)
    return {
        **base,
        **kelly,
        "bet_allowed": True,
        "no_bet_reason": None,
        "analysis_note": (
            f"Kelly fraccionario confirma ventaja. Operacion autorizada con "
            f"{kelly['bankroll_allocation']} de la banca."
        ),
    }


def total_pressure(home: dict, away: dict) -> float:
    return (home["offensive_rating"] + away["offensive_rating"] + home["defensive_rating"] + away["defensive_rating"]) / 4


def recommendation(match: dict, home: dict, away: dict) -> dict:
    sport = match.get("sport_slug", "")
    league_average = max((home.get("for_per_game", 0) + away.get("for_per_game", 0)) / 2, 1.0)
    prob_home = projected_home_probability(home, away, league_average, sport)
    prob_away = 1.0 - prob_home
    market_home_odds = parse_market_odds(match.get("home_odds"))
    market_away_odds = parse_market_odds(match.get("away_odds"))
    odds_source = match.get("odds_source") or "simulated_odds"
    real_market = odds_source == "market_odds" and sport != "soccer"
    home_odds = market_home_odds or SIMULATED_HOME_ODDS
    away_odds = market_away_odds or SIMULATED_AWAY_ODDS
    fair_home_odds = round(1 / max(prob_home, 0.01), 3)
    fair_away_odds = round(1 / max(prob_away, 0.01), 3)
    ev_home = decimal_ev(prob_home, home_odds)
    ev_away = decimal_ev(prob_away, away_odds)
    pressure = total_pressure(home, away)

    confidence_notes = []
    if home.get("played", 0) < MIN_PLAYED_FOR_SIGNAL or away.get("played", 0) < MIN_PLAYED_FOR_SIGNAL:
        confidence_notes.append("sample_size_low")
    if pressure >= 1.15:
        confidence_notes.append("over_pressure")

    if ev_home > MIN_EV_THRESHOLD and prob_home >= 0.62:
        pick = f"{home['name']} moneyline"
        coverage = f"{home['name']} or draw" if match.get("sport_slug") == "soccer" else f"{home['name']} +1.5"
        contract = evaluate_bet_contract(
            pick_detected=f"{home['name']} gana",
            probability=prob_home,
            market_odds=market_home_odds if real_market else None,
            odds_source=odds_source,
            home_played=home.get("played", 0),
            away_played=away.get("played", 0),
        )
    elif ev_away > MIN_EV_THRESHOLD and prob_home <= 0.38:
        pick = f"{away['name']} moneyline"
        coverage = f"{away['name']} or draw" if match.get("sport_slug") == "soccer" else f"{away['name']} +1.5"
        contract = evaluate_bet_contract(
            pick_detected=f"{away['name']} gana",
            probability=prob_away,
            market_odds=market_away_odds if real_market else None,
            odds_source=odds_source,
            home_played=home.get("played", 0),
            away_played=away.get("played", 0),
        )
    elif pressure >= 1.20:
        pick = "over lean"
        coverage = "reduce stake; totals market only"
        contract = evaluate_bet_contract(
            pick_detected="over lean",
            probability=max(prob_home, prob_away),
            market_odds=None,
            odds_source=odds_source,
            home_played=home.get("played", 0),
            away_played=away.get("played", 0),
        )
    else:
        pick = "pass"
        coverage = "no clear statistical edge"
        contract = evaluate_bet_contract(
            pick_detected="pass",
            probability=max(prob_home, prob_away),
            market_odds=None,
            odds_source=odds_source,
            home_played=home.get("played", 0),
            away_played=away.get("played", 0),
        )

    return {
        "match_id": match["id"],
        "match_slug": match["slug"],
        "league": match["league_slug"],
        "status": match["status"],
        "home_team": home["name"],
        "away_team": away["name"],
        "home_inertia": round(home["inertia"], 3),
        "away_inertia": round(away["inertia"], 3),
        "home_offensive_rating": round(home["offensive_rating"], 3),
        "away_offensive_rating": round(away["offensive_rating"], 3),
        "home_defensive_rating": round(home["defensive_rating"], 3),
        "away_defensive_rating": round(away["defensive_rating"], 3),
        "home_probability": round(prob_home, 3),
        "away_probability": round(prob_away, 3),
        "home_odds": round(home_odds, 3),
        "away_odds": round(away_odds, 3),
        "odds_source": odds_source,
        "fair_home_odds": fair_home_odds,
        "fair_away_odds": fair_away_odds,
        "home_market_discrepancy": round(home_odds - fair_home_odds, 3),
        "away_market_discrepancy": round(away_odds - fair_away_odds, 3),
        "home_ev": round(ev_home, 3),
        "away_ev": round(ev_away, 3),
        "total_pressure": round(pressure, 3),
        "pick": pick,
        "coverage": coverage,
        "market_type": "moneyline_3way" if sport == "soccer" else "moneyline_2way",
        "selection": "home" if contract["pick_detected"] == f"{home['name']} gana" else "away" if contract["pick_detected"] == f"{away['name']} gana" else "home",
        "model_version": MODEL_VERSION,
        "notes": confidence_notes,
        **contract,
    }


def candidate_matches(league: str) -> list[dict]:
    scheduled = get_json(f"/api/v1/matches?league={league}&status=scheduled&limit=50")
    live = get_json(f"/api/v1/matches?league={league}&status=live&limit=50")
    return [*live, *scheduled]


def analyze_league(slug: str) -> dict:
    table = get_json(f"/api/v1/leagues/{slug}/table")
    averages = league_averages(table)

    enriched: dict[str, dict] = {}
    for row in table:
        form_payload = get_json(f"/api/v1/teams/{row['slug']}/form")
        enriched[row["slug"]] = enrich_team(row, averages, form_payload.get("form", []))

    opportunities = []
    for match in candidate_matches(slug):
        home_competitor = competitor(match, "home")
        away_competitor = competitor(match, "away")
        if not home_competitor or not away_competitor:
            continue

        home = enriched.get(home_competitor["team_slug"])
        away = enriched.get(away_competitor["team_slug"])
        if not home or not away:
            continue

        opportunities.append(recommendation(match, home, away))

    opportunities.sort(key=lambda item: max(item["home_ev"], item["away_ev"], item["total_pressure"] - 1), reverse=True)

    return {
        "league": slug,
        "league_averages": {key: round(value, 3) for key, value in averages.items()},
        "candidate_count": len(opportunities),
        "opportunities": opportunities[:10],
    }


def register_paper_trade(item: dict) -> dict | None:
    if not PAPER_TRADE_ENABLED or not item.get("bet_allowed"):
        return None

    response = requests.post(
        f"{API_V1_URL}/internal/paper-trades",
        json={
            "match_id": item["match_id"],
            "status": "PENDING",
            "league_slug": item["league"],
            "league_type": "international" if "champions" in item["league"] or "copa" in item["league"] else "domestic",
            "home_team": item["home_team"],
            "away_team": item["away_team"],
            "pick_detected": item["pick_detected"],
            "market_type": item["market_type"],
            "selection": item["selection"],
            "model_version": item["model_version"],
            "odds_source": item["odds_source"],
            "model_probability": item["model_probability"],
            "market_odds": item["market_odds"],
            "expected_value": item["expected_value"],
            "bankroll_fraction": item["bankroll_fraction"],
            "raw_data": {
                "source": "analytics_bot",
                "match_slug": item["match_slug"],
                "generated_at": datetime.now().isoformat(),
            },
        },
        headers={"X-Internal-API-Key": INTERNAL_API_KEY},
        timeout=TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return response.json()


def print_human_report(report: list[dict]) -> None:
    print("[SYSTEM] Opportunity Scanner active")
    print(f"[CONFIG] odds_home={SIMULATED_HOME_ODDS} odds_away={SIMULATED_AWAY_ODDS} min_ev={MIN_EV_THRESHOLD}")

    for league_report in report:
        print(f"\n[MARKET] {league_report['league'].upper()} candidates={league_report['candidate_count']}")
        if not league_report["opportunities"]:
            print("  No scheduled/live candidates found.")
            continue

        for item in league_report["opportunities"]:
            print(f"  {item['home_team']} vs {item['away_team']}")
            print(
                "    inertia "
                f"H:{item['home_inertia']:.2f} A:{item['away_inertia']:.2f} | "
                "ratings "
                f"H-OF:{item['home_offensive_rating']:.2f} A-DEF:{item['away_defensive_rating']:.2f}"
            )
            print(
                "    probability "
                f"H:{item['home_probability'] * 100:.1f}% A:{item['away_probability'] * 100:.1f}% | "
                f"EV H:{item['home_ev']:.3f} A:{item['away_ev']:.3f} | pressure:{item['total_pressure']:.2f}"
            )
            print(
                "    odds "
                f"source:{item['odds_source']} "
                f"H:{item['home_odds']:.2f} fair:{item['fair_home_odds']:.2f} diff:{item['home_market_discrepancy']:.2f} | "
                f"A:{item['away_odds']:.2f} fair:{item['fair_away_odds']:.2f} diff:{item['away_market_discrepancy']:.2f}"
            )
            print(f"    pick: {item['pick']} | coverage: {item['coverage']} | notes: {','.join(item['notes']) or 'ok'}")
            print(
                "    control "
                f"allowed:{item['bet_allowed']} reason:{item['no_bet_reason'] or 'OK'} "
                f"stake:{item['suggested_stake']} allocation:{item['bankroll_allocation']}"
            )
            paper_result = register_paper_trade(item)
            if paper_result:
                print(f"    paper_trade: {paper_result}")


def main() -> None:
    print(
        json.dumps(
            {
                "event": "opportunity_scanner_started",
                "api_base_url": API_BASE_URL,
                "leagues": LEAGUES,
                "time": datetime.now().isoformat(),
            }
        ),
        flush=True,
    )

    report = [analyze_league(slug) for slug in LEAGUES]
    print_human_report(report)
    print(json.dumps({"event": "opportunity_report", "report": report}, indent=2), flush=True)


if __name__ == "__main__":
    main()
