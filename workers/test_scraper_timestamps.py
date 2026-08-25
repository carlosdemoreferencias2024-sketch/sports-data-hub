import json

from bs4 import BeautifulSoup

import mlb_scraper
import soccer_scraper


def soup_with_scoreboard(scoreboard: dict, event_id: str) -> BeautifulSoup:
    payload = {"page": {"content": {"scoreboard": scoreboard}}}
    html = (
        "<html><body>"
        f"<section class='Scoreboard' id='{event_id}'></section>"
        f"<script>window['__espnfitt__']={json.dumps(payload)};</script>"
        "</body></html>"
    )
    return BeautifulSoup(html, "html.parser")


mlb_soup = soup_with_scoreboard(
    {"evts": [{"id": "mlb-1", "date": "2026-08-13T17:10Z"}]},
    "mlb-1",
)
mlb_dates = mlb_scraper.embedded_event_dates(mlb_soup)
assert mlb_scraper.exact_match_date(mlb_soup.select_one("section"), mlb_dates) == "2026-08-13T17:10:00Z"

soccer_soup = soup_with_scoreboard(
    {"gmsByLeague": [{"evts": [{"id": "soccer-1", "date": "2026-08-13T23:30Z"}]}]},
    "soccer-1",
)
soccer_dates = soccer_scraper.embedded_event_dates(soccer_soup)
assert soccer_scraper.exact_match_date(soccer_soup.select_one("section"), soccer_dates) == "2026-08-13T23:30:00Z"

missing_soup = BeautifulSoup("<section class='Scoreboard' id='missing'></section>", "html.parser")
assert mlb_scraper.exact_match_date(missing_soup.select_one("section"), {}) is None
assert soccer_scraper.exact_match_date(missing_soup.select_one("section"), {}) is None

print("SCRAPER_TIMESTAMP_EXTRACTION_OK")
