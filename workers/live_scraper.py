import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import redis

from batch_scraper import parse_fixture


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--match-id", required=True)
    args = parser.parse_args()

    matches = parse_fixture(Path(args.fixture).read_text(encoding="utf-8"))
    match = next((item for item in matches if item.source_match_id == args.match_id), None)
    if not match:
        raise SystemExit(f"Fixture match not found: {args.match_id}")

    redis_client = redis.Redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6380"), decode_responses=True)
    state = {
        "match_id": args.match_id,
        "status": match.status,
        "period": match.period,
        "home_score": match.home_score,
        "away_score": match.away_score,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "payload": match.__dict__,
    }

    key = f"match:live:{args.match_id}"
    channel = f"match:{args.match_id}"
    redis_client.setex(key, 60 * 60 * 8, json.dumps(state))
    redis_client.publish(channel, json.dumps(state))
    print(json.dumps(state, indent=2))


if __name__ == "__main__":
    main()
