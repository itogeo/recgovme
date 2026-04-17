"""
Fetch all Alaska cabin listings from Recreation.gov.

Outputs site/cabins.json — the searchable cabin list for the frontend.
Uses multiple search queries to maximize coverage since the API caps
results at ~200 per query.

Usage:
    python3 scripts/fetch-cabins.py
"""

import json
import time
import random
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlencode

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json",
}

SEARCH_URL = "https://www.recreation.gov/api/search"

# Multiple queries to catch cabins across different national forests / parks
QUERIES = [
    "cabin alaska",
    "chugach cabin",
    "tongass cabin",
]

CABIN_KEYWORDS = ["cabin", "yurt", "lookout", "shelter"]


def fetch_query(query: str, all_cabins: dict[str, dict]) -> None:
    """Paginate through one search query, adding results to all_cabins."""
    offset = 0
    size = 50
    total = None

    while True:
        params = urlencode({
            "fq": "entity_type:campground",
            "q": query,
            "size": size,
            "offset": offset,
        })
        url = f"{SEARCH_URL}?{params}"
        req = Request(url, headers=HEADERS)

        try:
            with urlopen(req) as resp:
                data = json.loads(resp.read())
        except Exception as e:
            print(f"    Error at offset {offset}: {e}")
            break

        if total is None:
            total = data.get("total", 0)

        results = data.get("results", [])
        if not results:
            break

        for item in results:
            state = item.get("state_code", "")
            if state != "Alaska":
                continue

            name = item.get("name", "")
            name_lower = name.lower()
            if not any(kw in name_lower for kw in CABIN_KEYWORDS):
                continue

            eid = str(item.get("entity_id", ""))
            if eid not in all_cabins:
                all_cabins[eid] = {
                    "id": eid,
                    "name": name,
                    "parent": item.get("parent_name", ""),
                    "lat": item.get("latitude"),
                    "lon": item.get("longitude"),
                }

        offset += size
        if offset >= total:
            break

        time.sleep(1 + random.random())

    print(f"  \"{query}\": {total} results, {len(all_cabins)} unique cabins so far")


def main():
    print("Fetching Alaska cabins from Recreation.gov...")
    all_cabins: dict[str, dict] = {}

    for query in QUERIES:
        fetch_query(query, all_cabins)

    result = sorted(all_cabins.values(), key=lambda c: c["name"])

    out_path = Path(__file__).parent.parent / "site" / "cabins.json"
    out_path.write_text(json.dumps(result, indent=2))
    print(f"Wrote {len(result)} cabins to {out_path}")


if __name__ == "__main__":
    main()
