import argparse
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

from normalizer import normalize_alias


@dataclass
class ScrapedMatch:
    source_match_id: str
    league_slug: str
    match_date: str
    status: str
    home_alias: str
    away_alias: str
    home_score: int | None
    away_score: int | None
    period: str | None
    home_odds: float | None = None
    away_odds: float | None = None
    odds_source: str | None = None


def parse_score(value: str) -> int | None:
    value = value.strip()
    return int(value) if value.isdigit() else None


class ScoreboardParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.matches: list[dict[str, str | None]] = []
        self.current: dict[str, str | None] | None = None
        self.side: str | None = None
        self.field: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = dict(attrs)
        if "data-match-id" in attr:
            self.current = {
                "source_match_id": attr["data-match-id"],
                "league_slug": attr.get("data-league") or "mlb",
                "match_date": attr.get("data-date"),
                "status": attr.get("data-status") or "scheduled",
                "home_alias": None,
                "away_alias": None,
                "home_score": None,
                "away_score": None,
                "period": None,
            }
            return

        classes = set((attr.get("class") or "").split())
        if "home" in classes:
            self.side = "home"
        elif "away" in classes:
            self.side = "away"
        elif "team" in classes:
            self.field = f"{self.side}_alias" if self.side else None
        elif "score" in classes:
            self.field = f"{self.side}_score" if self.side else None
        elif "period" in classes:
            self.field = "period"

    def handle_data(self, data: str) -> None:
        if self.current is not None and self.field:
            text = data.strip()
            if text:
                self.current[self.field] = text

    def handle_endtag(self, tag: str) -> None:
        if tag == "section" and self.current:
            self.matches.append(self.current)
            self.current = None
            self.side = None
            self.field = None
        elif tag == "div":
            self.side = None
            self.field = None
        elif tag == "span":
            self.field = None


def parse_fixture(html: str) -> list[ScrapedMatch]:
    parser = ScoreboardParser()
    parser.feed(html)
    matches: list[ScrapedMatch] = []

    for node in parser.matches:
        matches.append(
            ScrapedMatch(
                source_match_id=str(node["source_match_id"]),
                league_slug=str(node["league_slug"]),
                match_date=str(node["match_date"]),
                status=str(node["status"]),
                home_alias=str(node["home_alias"]),
                away_alias=str(node["away_alias"]),
                home_score=parse_score(str(node["home_score"] or "")),
                away_score=parse_score(str(node["away_score"] or "")),
                period=str(node["period"]) if node["period"] else None,
            )
        )

    return matches


def resolve_team_id(cursor, source_slug: str, alias: str) -> str:
    cursor.execute(
        """
        SELECT sta.team_id
        FROM source_team_aliases sta
        JOIN data_sources ds ON ds.id = sta.source_id
        WHERE ds.slug = %s AND sta.normalized_alias = %s;
        """,
        (source_slug, normalize_alias(alias)),
    )
    row = cursor.fetchone()
    if not row:
        raise ValueError(f"No team alias mapping for {alias!r} in source {source_slug!r}")
    return row[0]


def ingest(matches: list[ScrapedMatch], source_slug: str, database_url: str) -> dict[str, int]:
    import psycopg

    counts = {"processed": 0, "created": 0, "updated": 0, "errors": 0}

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM data_sources WHERE slug = %s", (source_slug,))
            source = cursor.fetchone()
            if not source:
                raise ValueError(f"Unknown data source: {source_slug}")
            source_id = source[0]

            cursor.execute(
                """
                INSERT INTO scrape_runs (source_id, run_type, status, metadata)
                VALUES (%s, 'batch', 'running', %s)
                RETURNING id;
                """,
                (source_id, json.dumps({"started_by": "batch_scraper"})),
            )
            run_id = cursor.fetchone()[0]

            for match in matches:
                counts["processed"] += 1
                try:
                    home_team_id = resolve_team_id(cursor, source_slug, match.home_alias)
                    away_team_id = resolve_team_id(cursor, source_slug, match.away_alias)

                    cursor.execute(
                        """
                        SELECT l.id, s.id
                        FROM leagues l
                        LEFT JOIN seasons s ON s.league_id = l.id AND s.is_current = TRUE
                        WHERE l.slug = %s;
                        """,
                        (match.league_slug,),
                    )
                    league = cursor.fetchone()
                    if not league:
                        raise ValueError(f"Unknown league: {match.league_slug}")

                    slug = f"{match.match_date[:10]}-{match.source_match_id}"
                    cursor.execute(
                        """
                        INSERT INTO matches (
                          league_id, season_id, slug, match_date, status, period, home_score, away_score, home_odds, away_odds, raw_data
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (slug) DO UPDATE SET
                          status = EXCLUDED.status,
                          period = EXCLUDED.period,
                          home_score = EXCLUDED.home_score,
                          away_score = EXCLUDED.away_score,
                          home_odds = COALESCE(EXCLUDED.home_odds, matches.home_odds),
                          away_odds = COALESCE(EXCLUDED.away_odds, matches.away_odds),
                          raw_data = EXCLUDED.raw_data
                        RETURNING id, (xmax = 0) AS inserted;
                        """,
                        (
                            league[0],
                            league[1],
                            slug,
                            match.match_date,
                            match.status,
                            match.period,
                            match.home_score,
                            match.away_score,
                            match.home_odds,
                            match.away_odds,
                            json.dumps(match.__dict__),
                        ),
                    )
                    match_id, inserted = cursor.fetchone()
                    counts["created" if inserted else "updated"] += 1

                    for team_id, side, score in (
                        (home_team_id, "home", match.home_score),
                        (away_team_id, "away", match.away_score),
                    ):
                        cursor.execute(
                            """
                            INSERT INTO match_competitors (match_id, team_id, home_away, score)
                            VALUES (%s, %s, %s, %s)
                            ON CONFLICT (match_id, team_id) DO UPDATE SET
                              score = EXCLUDED.score,
                              home_away = EXCLUDED.home_away;
                            """,
                            (match_id, team_id, side, score),
                        )

                    cursor.execute(
                        """
                        INSERT INTO source_match_refs (source_id, match_id, source_match_id, raw_data)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (source_id, source_match_id) DO UPDATE SET
                          match_id = EXCLUDED.match_id,
                          raw_data = EXCLUDED.raw_data;
                        """,
                        (source_id, match_id, match.source_match_id, json.dumps(match.__dict__)),
                    )
                except Exception as exc:
                    counts["errors"] += 1
                    cursor.execute(
                        """
                        INSERT INTO scrape_errors (scrape_run_id, source_id, message, context)
                        VALUES (%s, %s, %s, %s);
                        """,
                        (run_id, source_id, str(exc), json.dumps(match.__dict__)),
                    )

            cursor.execute(
                """
                UPDATE scrape_runs
                SET status = %s,
                    finished_at = %s,
                    processed_count = %s,
                    created_count = %s,
                    updated_count = %s,
                    error_count = %s
                WHERE id = %s;
                """,
                (
                    "completed_with_errors" if counts["errors"] else "completed",
                    datetime.now(timezone.utc),
                    counts["processed"],
                    counts["created"],
                    counts["updated"],
                    counts["errors"],
                    run_id,
                ),
            )
        conn.commit()

    return counts


def post_batch(matches: list[ScrapedMatch], source_slug: str, api_url: str, api_key: str | None) -> dict:
    payload = {
        "matches": [
            {
                "source_slug": source_slug,
                "source_match_id": match.source_match_id,
                "league_slug": match.league_slug,
                "match_date": match.match_date,
                "status": match.status,
                "home_alias": match.home_alias,
                "away_alias": match.away_alias,
                "home_score": match.home_score,
                "away_score": match.away_score,
                "home_odds": match.home_odds,
                "away_odds": match.away_odds,
                "odds_source": match.odds_source or ("market_odds" if match.home_odds and match.away_odds else None),
                "period": match.period,
                "raw_data": match.__dict__,
            }
            for match in matches
        ]
    }

    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        api_url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            **({"X-Internal-API-Key": api_key} if api_key else {}),
        },
    )

    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--source", default="sample-local")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--api-url", default=os.environ.get("BATCH_INGESTION_URL"))
    parser.add_argument("--api-key", default=os.environ.get("INTERNAL_API_KEY"))
    parser.add_argument("--direct-db-fallback", action="store_true")
    args = parser.parse_args()

    html = Path(args.fixture).read_text(encoding="utf-8")
    matches = parse_fixture(html)

    if args.dry_run:
        print(json.dumps([match.__dict__ for match in matches], indent=2))
        return

    if args.api_url:
        try:
            print(json.dumps(post_batch(matches, args.source, args.api_url, args.api_key), indent=2))
            return
        except (urllib.error.URLError, TimeoutError) as exc:
            if not args.direct_db_fallback:
                raise
            print(json.dumps({"status": "api_unavailable", "message": str(exc), "fallback": "direct-db"}), flush=True)

    database_url = os.environ["DATABASE_URL"]
    print(json.dumps(ingest(matches, args.source, database_url), indent=2))


if __name__ == "__main__":
    main()
