import argparse
import csv
import os
from dataclasses import dataclass

import psycopg
from pre_bet_validator import validate_mlb_fixture
from source_manager import validate_mlb_cross_sources


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)


@dataclass(frozen=True)
class TeamDerivedStats:
    games: int
    runs_for: float
    runs_against: float
    win_rate: float

    @property
    def era_proxy(self) -> float:
        if self.games == 0:
            return 4.20
        return _clamp(self.runs_against, 2.50, 6.20)

    @property
    def whip_proxy(self) -> float:
        if self.games == 0:
            return 1.30
        return _clamp(1.10 + ((self.runs_against - 3.5) * 0.055), 0.95, 1.60)

    @property
    def ops_proxy(self) -> float:
        if self.games == 0:
            return 0.720
        return _clamp(0.690 + ((self.runs_for - 4.0) * 0.018), 0.610, 0.850)

    @property
    def bullpen_era_proxy(self) -> float:
        if self.games == 0:
            return 4.20
        return _clamp(self.runs_against + 0.15, 2.70, 6.40)


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _team_stats(conn, team_id: str, lookback_games: int) -> TeamDerivedStats:
    rows = conn.execute(
        """
        SELECT
          mc.score::float AS runs_for,
          CASE mc.home_away
            WHEN 'home' THEN m.away_score::float
            ELSE m.home_score::float
          END AS runs_against,
          CASE
            WHEN mc.score > CASE mc.home_away WHEN 'home' THEN m.away_score ELSE m.home_score END THEN 1.0
            ELSE 0.0
          END AS won
        FROM match_competitors mc
        JOIN v_valid_matches m ON m.id = mc.match_id
        WHERE mc.team_id = %s
          AND m.status = 'finished'
          AND mc.score IS NOT NULL
          AND m.home_score IS NOT NULL
          AND m.away_score IS NOT NULL
        ORDER BY m.match_date DESC
        LIMIT %s;
        """,
        (team_id, lookback_games),
    ).fetchall()

    if not rows:
        return TeamDerivedStats(games=0, runs_for=4.20, runs_against=4.20, win_rate=0.50)

    games = len(rows)
    runs_for = sum(float(row[0]) for row in rows) / games
    runs_against = sum(float(row[1]) for row in rows) / games
    win_rate = sum(float(row[2]) for row in rows) / games
    return TeamDerivedStats(games=games, runs_for=runs_for, runs_against=runs_against, win_rate=win_rate)


def fetch_active_match_rows(conn, include_live: bool, league_slug: str | None) -> list:
    status_filter = ("scheduled", "live") if include_live else ("scheduled",)
    params: list[object] = [list(status_filter)]
    league_filter = ""
    if league_slug:
        params.append(league_slug)
        league_filter = "AND l.slug = %s"

    return conn.execute(
        """
        WITH candidate_matches AS (
        SELECT
          m.id AS hub_match_id,
          COALESCE(pem.home_team_name, home_team.name) AS home_team_name,
          COALESCE(pem.away_team_name, away_team.name) AS away_team_name,
          COALESCE(pem.kickoff, m.match_date) AS kickoff,
          COALESCE(pem.provider_name, 'hub_internal') AS provider_name,
          COALESCE(pem.provider_event_id, m.slug) AS provider_event_id,
          home_mc.team_id AS home_team_id,
          away_mc.team_id AS away_team_id,
          ROW_NUMBER() OVER (
            PARTITION BY l.slug, home_mc.team_id, away_mc.team_id
            ORDER BY
              CASE WHEN m.status = 'live' THEN 0 ELSE 1 END,
              m.match_date DESC,
              m.updated_at DESC
          ) AS logical_rank
        FROM v_valid_matches m
        JOIN leagues l ON l.id = m.league_id
        JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
        JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
        JOIN teams home_team ON home_team.id = home_mc.team_id
        JOIN teams away_team ON away_team.id = away_mc.team_id
        LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = m.id AND pem.is_active = TRUE
        WHERE m.status::text = ANY(%s)
          {league_filter}
        )
        SELECT
          hub_match_id,
          home_team_name,
          away_team_name,
          kickoff,
          provider_name,
          provider_event_id,
          home_team_id,
          away_team_id
        FROM candidate_matches
        WHERE logical_rank = 1
        ORDER BY kickoff ASC;
        """.format(league_filter=league_filter),
        params,
    ).fetchall()


def generate_autofilled_stats(output_path: str, lookback_games: int, include_live: bool, league_slug: str | None) -> int:
    with psycopg.connect(DATABASE_URL) as conn:
        matches = fetch_active_match_rows(conn, include_live, league_slug)
        valid_matches = []
        rejected: dict[str, int] = {}
        for row in matches:
            validation = validate_mlb_fixture(
                match_date=row[3],
                home_team=str(row[1] or ""),
                away_team=str(row[2] or ""),
                status="live" if include_live else "scheduled",
            )
            if validation.ok:
                cross_source = validate_mlb_cross_sources(
                    match_date=row[3],
                    home_team=str(row[1] or ""),
                    away_team=str(row[2] or ""),
                )
                if cross_source.ok:
                    valid_matches.append(row)
                else:
                    rejected[cross_source.reason] = rejected.get(cross_source.reason, 0) + 1
            else:
                rejected[validation.reason] = rejected.get(validation.reason, 0) + 1
        if rejected:
            print(f"[PREBET] MLB fixtures rechazados={rejected}", flush=True)
        with open(output_path, "w", newline="", encoding="utf-8") as file:
            writer = csv.writer(file)
            writer.writerow(
                [
                    "hub_match_id",
                    "home_team",
                    "away_team",
                    "kickoff",
                    "provider_name",
                    "provider_event_id",
                    "home_era",
                    "home_whip",
                    "home_ops",
                    "home_bullpen_era",
                    "away_era",
                    "away_whip",
                    "away_ops",
                    "away_bullpen_era",
                ]
            )
            for row in valid_matches:
                home = _team_stats(conn, str(row[6]), lookback_games)
                away = _team_stats(conn, str(row[7]), lookback_games)
                writer.writerow(
                    [
                        row[0],
                        row[1],
                        row[2],
                        row[3],
                        row[4],
                        row[5],
                        f"{home.era_proxy:.2f}",
                        f"{home.whip_proxy:.3f}",
                        f"{home.ops_proxy:.3f}",
                        f"{home.bullpen_era_proxy:.2f}",
                        f"{away.era_proxy:.2f}",
                        f"{away.whip_proxy:.3f}",
                        f"{away.ops_proxy:.3f}",
                        f"{away.bullpen_era_proxy:.2f}",
                    ]
                )
    return len(valid_matches)


def main() -> None:
    parser = argparse.ArgumentParser(description="Genera stats_input.csv desde resultados historicos del Hub.")
    parser.add_argument("--output", default="/tmp/stats_input_auto.csv")
    parser.add_argument("--lookback-games", type=int, default=10)
    parser.add_argument("--include-live", action="store_true")
    parser.add_argument("--league-slug", default="mlb")
    args = parser.parse_args()
    count = generate_autofilled_stats(args.output, args.lookback_games, args.include_live, args.league_slug)
    print(f"[+] Stats automaticas generadas: {args.output} filas={count}")


if __name__ == "__main__":
    main()
