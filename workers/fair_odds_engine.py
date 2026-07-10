from __future__ import annotations

from dataclasses import dataclass
import math


@dataclass(frozen=True)
class TeamStats:
    era: float
    whip: float
    ops: float = 0.72
    bullpen_era: float = 4.2


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def calculate_fair_odds(home_stats: TeamStats, away_stats: TeamStats) -> dict[str, float]:
    """Simple MLB model for model-only fair odds.

    Lower ERA/WHIP is better for pitching. Higher OPS is better for offense.
    The output intentionally stays conservative until richer inputs exist.
    """
    home_pitching = ((5.0 - home_stats.era) * 0.22) + ((1.45 - home_stats.whip) * 0.75)
    away_pitching = ((5.0 - away_stats.era) * 0.22) + ((1.45 - away_stats.whip) * 0.75)
    home_offense = (home_stats.ops - 0.700) * 1.35
    away_offense = (away_stats.ops - 0.700) * 1.35
    home_bullpen = (4.50 - home_stats.bullpen_era) * 0.08
    away_bullpen = (4.50 - away_stats.bullpen_era) * 0.08

    home_score = home_pitching + home_offense + home_bullpen + 0.035
    away_score = away_pitching + away_offense + away_bullpen
    edge_signal = home_score - away_score

    home_probability = _clamp(0.5 + (edge_signal * 0.12), 0.18, 0.82)
    away_probability = 1.0 - home_probability
    confidence = _clamp(abs(home_probability - 0.5) * 2.0, 0.05, 0.95)
    projected_home_runs = _clamp(
        4.35
        + ((home_stats.ops - 0.700) * 8.0)
        - ((away_stats.era - 4.20) * 0.28)
        - ((away_stats.bullpen_era - 4.20) * 0.12)
        + 0.10,
        2.2,
        7.8,
    )
    projected_away_runs = _clamp(
        4.20
        + ((away_stats.ops - 0.700) * 8.0)
        - ((home_stats.era - 4.20) * 0.28)
        - ((home_stats.bullpen_era - 4.20) * 0.12),
        2.2,
        7.8,
    )
    total_runs_line = 8.5
    projected_total_runs = projected_home_runs + projected_away_runs
    over_probability = _clamp(1.0 / (1.0 + math.exp(-0.55 * (projected_total_runs - total_runs_line))), 0.18, 0.82)
    under_probability = 1.0 - over_probability
    total_confidence = _clamp(abs(over_probability - 0.5) * 2.0, 0.05, 0.80)
    projected_margin = projected_home_runs - projected_away_runs
    home_run_line = -1.5
    away_run_line = 1.5
    home_run_line_probability = _clamp(
        1.0 / (1.0 + math.exp(-0.75 * (projected_margin - 1.5))),
        0.08,
        0.92,
    )
    away_run_line_probability = _clamp(
        1.0 / (1.0 + math.exp(-0.75 * ((-projected_margin) - 1.5))),
        0.08,
        0.92,
    )
    home_run_line_confidence = _clamp(abs(home_run_line_probability - 0.5) * 2.0, 0.05, 0.85)
    away_run_line_confidence = _clamp(abs(away_run_line_probability - 0.5) * 2.0, 0.05, 0.85)

    return {
        "home_probability": round(home_probability, 6),
        "away_probability": round(away_probability, 6),
        "home_fair_odds": round(1.0 / home_probability, 4),
        "away_fair_odds": round(1.0 / away_probability, 4),
        "confidence": round(confidence, 4),
        "markets": {
            "total_runs": {
                "line": total_runs_line,
                "over_probability": round(over_probability, 6),
                "under_probability": round(under_probability, 6),
                "over_fair_odds": round(1.0 / over_probability, 4),
                "under_fair_odds": round(1.0 / under_probability, 4),
                "confidence": round(total_confidence, 4),
                "projected_home_runs": round(projected_home_runs, 3),
                "projected_away_runs": round(projected_away_runs, 3),
                "projected_total_runs": round(projected_total_runs, 3),
            }
            ,
            "run_line_home": {
                "line": home_run_line,
                "selection": "home",
                "probability": round(home_run_line_probability, 6),
                "fair_odds": round(1.0 / home_run_line_probability, 4),
                "confidence": round(home_run_line_confidence, 4),
                "projected_margin": round(projected_margin, 3),
            },
            "run_line_away": {
                "line": away_run_line,
                "selection": "away",
                "probability": round(away_run_line_probability, 6),
                "fair_odds": round(1.0 / away_run_line_probability, 4),
                "confidence": round(away_run_line_confidence, 4),
                "projected_margin": round(projected_margin, 3),
            },
        },
    }


def calculate_from_row(row: dict[str, str]) -> dict[str, float]:
    home = TeamStats(
        era=float(row["home_era"]),
        whip=float(row["home_whip"]),
        ops=float(row.get("home_ops") or 0.72),
        bullpen_era=float(row.get("home_bullpen_era") or 4.2),
    )
    away = TeamStats(
        era=float(row["away_era"]),
        whip=float(row["away_whip"]),
        ops=float(row.get("away_ops") or 0.72),
        bullpen_era=float(row.get("away_bullpen_era") or 4.2),
    )
    return calculate_fair_odds(home, away)
