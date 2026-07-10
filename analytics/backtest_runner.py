import os
from dataclasses import dataclass, field

import requests

from analytics_bot import (
    API_V1_URL,
    LEAGUES,
    MIN_EV_THRESHOLD,
    MIN_PLAYED_FOR_SIGNAL,
    TIMEOUT_SECONDS,
    competitor,
    enrich_team,
    evaluate_bet_contract,
    league_averages,
    projected_home_probability,
    quarter_kelly,
)


def get_json(path: str):
    normalized_path = path[7:] if path.startswith("/api/v1") else path
    response = requests.get(f"{API_V1_URL}{normalized_path}", timeout=TIMEOUT_SECONDS)
    response.raise_for_status()
    return response.json()


def parse_decimal(value):
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 1.0 else None


@dataclass
class PronostixBacktestEngine:
    bankroll_inicial: float = 10000.0
    bankroll: float = field(init=False)
    total_picks: int = 0
    apuestas_permitidas: int = 0
    wins: int = 0
    losses: int = 0
    pushes: int = 0
    registro_auditoria: list[dict] = field(default_factory=list)

    def __post_init__(self):
        self.bankroll = self.bankroll_inicial

    def historical_matches(self, league: str) -> list[dict]:
        rows = get_json(f"/matches?league={league}&limit=100")
        return [row for row in rows if row.get("status") == "finished"]

    def snapshot_profiles(self, match: dict) -> dict[str, dict]:
        snapshots = get_json(f"/matches/{match['id']}/snapshots")
        if len(snapshots) < 2:
            return {}

        total_played = sum(int(row.get("played") or 0) for row in snapshots)
        averages = {
            "for_per_game": sum(int(row.get("points_for") or 0) for row in snapshots) / max(total_played, 1),
            "against_per_game": sum(int(row.get("points_against") or 0) for row in snapshots) / max(total_played, 1),
        }
        profiles = {}
        for snapshot in snapshots:
            row = {
                "slug": snapshot["team_slug"],
                "name": snapshot["team_name"],
                "played": int(snapshot.get("played") or 0),
                "wins": int(snapshot.get("wins") or 0),
                "draws": int(snapshot.get("draws") or 0),
                "losses": int(snapshot.get("losses") or 0),
                "goals_for": int(snapshot.get("points_for") or 0),
                "goals_against": int(snapshot.get("points_against") or 0),
            }
            profiles[row["slug"]] = enrich_team(row, averages, snapshot.get("form") or [])
        return profiles

    def evaluate_match(self, match: dict, profiles: dict[str, dict]) -> None:
        home_competitor = competitor(match, "home")
        away_competitor = competitor(match, "away")
        if not home_competitor or not away_competitor:
            return

        home = profiles.get(home_competitor["team_slug"])
        away = profiles.get(away_competitor["team_slug"])
        if not home or not away:
            return
        home_score = match.get("home_score")
        away_score = match.get("away_score")
        if home_score is None or away_score is None:
            return

        self.total_picks += 1
        prob_home = projected_home_probability(
            home,
            away,
            max((home.get("for_per_game", 0) + away.get("for_per_game", 0)) / 2, 1.0),
            match.get("sport_slug", ""),
        )
        prob_away = 1.0 - prob_home
        candidates = [
            {
                "side": "home",
                "team": home["name"],
                "slug": home["slug"],
                "probability": prob_home,
                "odds": parse_decimal(match.get("home_odds")),
                "won": home_score > away_score,
                "push": home_score == away_score,
            },
            {
                "side": "away",
                "team": away["name"],
                "slug": away["slug"],
                "probability": prob_away,
                "odds": parse_decimal(match.get("away_odds")),
                "won": away_score > home_score,
                "push": home_score == away_score,
            },
        ]

        for candidate in candidates:
            contract = evaluate_bet_contract(
                pick_detected=f"{candidate['team']} gana",
                probability=candidate["probability"],
                market_odds=candidate["odds"] if match.get("odds_source") == "market_odds" else None,
                odds_source=match.get("odds_source") or "simulated_odds",
                home_played=home.get("played", 0),
                away_played=away.get("played", 0),
            )
            if not contract["bet_allowed"]:
                continue

            self.apuestas_permitidas += 1
            kelly = quarter_kelly(candidate["probability"], candidate["odds"])
            amount = self.bankroll * kelly["bankroll_fraction"]
            if candidate["push"]:
                self.pushes += 1
                profit = 0.0
                result = "PUSH"
            elif candidate["won"]:
                self.wins += 1
                profit = amount * (candidate["odds"] - 1.0)
                result = "WIN"
            else:
                self.losses += 1
                profit = -amount
                result = "LOSS"

            self.bankroll += profit
            self.registro_auditoria.append(
                {
                    "id": match["id"],
                    "league": match["league_slug"],
                    "juego": f"{away['slug']} @ {home['slug']}",
                    "pick": candidate["slug"],
                    "resultado": result,
                    "probability": round(candidate["probability"], 4),
                    "odds": candidate["odds"],
                    "expected_value": contract["expected_value"],
                    "bankroll_allocation": kelly["bankroll_allocation"],
                    "monto": round(amount, 2),
                    "net_profit": round(profit, 2),
                    "bankroll_snapshot": round(self.bankroll, 2),
                }
            )

    def ejecutar(self) -> None:
        print("[PRONOSTIX ENGINE] Ejecutando backtesting institucional")
        print(
            f"[CONFIG] leagues={','.join(LEAGUES)} min_ev={MIN_EV_THRESHOLD} "
            f"min_played={MIN_PLAYED_FOR_SIGNAL} bankroll={self.bankroll_inicial:,.2f}"
        )
        for league in LEAGUES:
            try:
                matches = self.historical_matches(league)
            except Exception as error:
                print(f"[WARN] {league}: no se pudo cargar historico ({error})")
                continue
            print(f"[LEAGUE] {league}: {len(matches)} partidos finalizados para auditar")
            for match in matches:
                profiles = self.snapshot_profiles(match)
                if not profiles:
                    continue
                self.evaluate_match(match, profiles)
        self.imprimir_reporte_financiero()

    def imprimir_reporte_financiero(self) -> None:
        win_rate = (self.wins / max(self.apuestas_permitidas, 1)) * 100
        retorno_total = self.bankroll - self.bankroll_inicial
        roi = (retorno_total / self.bankroll_inicial) * 100

        print("\n============================================================")
        print("[PRONOSTIX ENGINE] REPORTE DE RENDIMIENTO DEL BACKTEST")
        print("============================================================")
        print(f"Capital Inicial:      ${self.bankroll_inicial:,.2f}")
        print(f"Capital Final:        ${self.bankroll:,.2f}")
        print(f"Retorno Neto:         ${retorno_total:+,.2f} ({roi:+.2f}% ROI)")
        print(f"Tasa de Acierto:      {win_rate:.1f}% ({self.wins}W - {self.losses}L - {self.pushes}P)")
        print(f"Picks en Base:        {self.total_picks} procesados")
        print(f"Ordenes Permitidas:   {self.apuestas_permitidas} ejecutadas")
        print("============================================================")
        if self.registro_auditoria:
            print("[ULTIMAS ORDENES]")
            for item in self.registro_auditoria[-10:]:
                print(
                    f"  {item['resultado']} {item['league']} {item['pick']} "
                    f"odds={item['odds']} ev={item['expected_value']:+.3f} "
                    f"profit={item['net_profit']:+.2f} bankroll={item['bankroll_snapshot']:.2f}"
                )


if __name__ == "__main__":
    runner = PronostixBacktestEngine(float(os.getenv("BACKTEST_BANKROLL", "10000")))
    runner.ejecutar()
