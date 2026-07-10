import math


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _poisson_probability(lam: float, goals: int) -> float:
    return (math.exp(-lam) * (lam ** goals)) / math.factorial(goals)


def calculate_football_odds(features: dict) -> dict[str, float]:
    league_avg_home_goals = float(features.get("league_avg_home_goals", 1.35))
    league_avg_away_goals = float(features.get("league_avg_away_goals", 1.10))
    home_attack = float(features.get("home_attack_strength", 1.0))
    home_defense = float(features.get("home_defense_weakness", 1.0))
    away_attack = float(features.get("away_attack_strength", 1.0))
    away_defense = float(features.get("away_defense_weakness", 1.0))
    home_advantage = float(features.get("home_advantage", 1.07))
    draw_coefficient = float(features.get("draw_coefficient", 1.04))
    max_goals = int(features.get("max_goals", 7))

    lambda_home = _clamp(league_avg_home_goals * home_attack * away_defense * home_advantage, 0.15, 4.20)
    lambda_away = _clamp(league_avg_away_goals * away_attack * home_defense, 0.15, 4.20)

    home_probability = 0.0
    draw_probability = 0.0
    away_probability = 0.0
    over_2_5_probability = 0.0
    btts_yes_probability = 0.0
    for home_goals in range(max_goals + 1):
        p_home_score = _poisson_probability(lambda_home, home_goals)
        for away_goals in range(max_goals + 1):
            score_probability = p_home_score * _poisson_probability(lambda_away, away_goals)
            if home_goals + away_goals > 2.5:
                over_2_5_probability += score_probability
            if home_goals > 0 and away_goals > 0:
                btts_yes_probability += score_probability
            if home_goals > away_goals:
                home_probability += score_probability
            elif home_goals == away_goals:
                draw_probability += score_probability * draw_coefficient
            else:
                away_probability += score_probability

    total = home_probability + draw_probability + away_probability
    home_probability = home_probability / total
    draw_probability = draw_probability / total
    away_probability = away_probability / total

    strongest = max(home_probability, draw_probability, away_probability)
    second = sorted([home_probability, draw_probability, away_probability], reverse=True)[1]
    confidence = _clamp((strongest - second) * 1.4, 0.05, 0.95)
    under_2_5_probability = 1.0 - over_2_5_probability
    btts_no_probability = 1.0 - btts_yes_probability
    dnb_total = home_probability + away_probability
    dnb_home_probability = home_probability / dnb_total
    dnb_away_probability = away_probability / dnb_total

    return {
        "home_probability": round(home_probability, 6),
        "draw_probability": round(draw_probability, 6),
        "away_probability": round(away_probability, 6),
        "home_fair_odds": round(1.0 / home_probability, 4),
        "draw_fair_odds": round(1.0 / draw_probability, 4),
        "away_fair_odds": round(1.0 / away_probability, 4),
        "confidence": round(confidence, 4),
        "lambda_home": round(lambda_home, 4),
        "lambda_away": round(lambda_away, 4),
        "markets": {
            "moneyline_3way": {
                "home_probability": round(home_probability, 6),
                "draw_probability": round(draw_probability, 6),
                "away_probability": round(away_probability, 6),
                "home_fair_odds": round(1.0 / home_probability, 4),
                "draw_fair_odds": round(1.0 / draw_probability, 4),
                "away_fair_odds": round(1.0 / away_probability, 4),
                "confidence": round(confidence, 4),
            },
            "total_goals_2_5": {
                "line": 2.5,
                "over_probability": round(over_2_5_probability, 6),
                "under_probability": round(under_2_5_probability, 6),
                "over_fair_odds": round(1.0 / over_2_5_probability, 4),
                "under_fair_odds": round(1.0 / under_2_5_probability, 4),
                "confidence": round(_clamp(abs(over_2_5_probability - under_2_5_probability) * 1.2, 0.05, 0.95), 4),
            },
            "btts": {
                "yes_probability": round(btts_yes_probability, 6),
                "no_probability": round(btts_no_probability, 6),
                "yes_fair_odds": round(1.0 / btts_yes_probability, 4),
                "no_fair_odds": round(1.0 / btts_no_probability, 4),
                "confidence": round(_clamp(abs(btts_yes_probability - btts_no_probability) * 1.2, 0.05, 0.95), 4),
            },
            "draw_no_bet": {
                "home_probability": round(dnb_home_probability, 6),
                "away_probability": round(dnb_away_probability, 6),
                "home_fair_odds": round(1.0 / dnb_home_probability, 4),
                "away_fair_odds": round(1.0 / dnb_away_probability, 4),
                "confidence": round(_clamp(abs(dnb_home_probability - dnb_away_probability) * 1.2, 0.05, 0.95), 4),
            },
        },
    }
