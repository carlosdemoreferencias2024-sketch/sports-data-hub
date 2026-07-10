import math


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def calculate_nba_odds(features: dict) -> dict[str, float]:
    home_net = float(features.get("home_net_rating", 0.0))
    away_net = float(features.get("away_net_rating", 0.0))
    home_advantage = float(features.get("home_advantage", 2.5))
    rest_edge = float(features.get("home_rest_days", 0.0)) - float(features.get("away_rest_days", 0.0))
    pace = float(features.get("pace", 100.0))

    power_diff = (home_net - away_net) + home_advantage + (rest_edge * 0.55)
    pace_multiplier = _clamp(pace / 100.0, 0.92, 1.08)
    prob_home = 1.0 / (1.0 + math.exp(-0.095 * power_diff * pace_multiplier))
    prob_home = _clamp(prob_home, 0.18, 0.82)
    prob_away = 1.0 - prob_home
    confidence = _clamp(abs(prob_home - 0.5) * 2.0, 0.05, 0.95)

    return {
        "home_probability": round(prob_home, 6),
        "away_probability": round(prob_away, 6),
        "home_fair_odds": round(1.0 / prob_home, 4),
        "away_fair_odds": round(1.0 / prob_away, 4),
        "confidence": round(confidence, 4),
    }
