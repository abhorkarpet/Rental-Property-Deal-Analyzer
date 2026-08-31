"""Shared helpers for data providers: HTTP headers, TTL caching, address parsing."""

import json
import re
import time
from pathlib import Path


STATE_NAMES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "district of columbia": "DC", "florida": "FL", "georgia": "GA", "hawaii": "HI",
    "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI",
    "south carolina": "SC", "south dakota": "SD", "tennessee": "TN", "texas": "TX",
    "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
}

# Empty listing/property shape. Extractors fill what they can find and leave
# the rest None so the frontend can tell "not found" from "zero".
EMPTY_PROPERTY = {
    "address": None, "price": None, "beds": None, "baths": None,
    "sqft": None, "lotSize": None, "yearBuilt": None, "propertyType": None,
    "zestimate": None, "rentZestimate": None, "taxHistory": [],
    "annualTax": None, "hoaFee": 0, "description": None, "imageUrl": None,
}


class TTLCache:
    """Small time-based cache. Follows the pattern already used for mortgage rates.

    Optionally backed by a JSON file. That matters for metered data: a local
    app gets restarted often, and an in-memory-only cache would re-buy the
    same zip's statistics every time.
    """

    def __init__(self, ttl_seconds: int, path: "Path | None" = None):
        self.ttl = ttl_seconds
        self.path = path
        self._store: dict[str, tuple[float, object]] = {}
        if path:
            self._load()

    def _load(self) -> None:
        try:
            raw = json.loads(self.path.read_text())
        except (OSError, ValueError, TypeError):
            return
        if not isinstance(raw, dict):
            return
        now = time.time()
        for key, entry in raw.items():
            try:
                fetched_at, value = entry["t"], entry["v"]
            except (KeyError, TypeError):
                continue
            if now - fetched_at <= self.ttl:
                self._store[key] = (fetched_at, value)

    def _save(self) -> None:
        if not self.path:
            return
        try:
            self.path.write_text(json.dumps(
                {k: {"t": t, "v": v} for k, (t, v) in self._store.items()}
            ))
        except (OSError, TypeError):
            # Losing the cache costs a request later; it must never break a search.
            pass

    def get(self, key: str):
        entry = self._store.get(key)
        if not entry:
            return None
        fetched_at, value = entry
        if time.time() - fetched_at > self.ttl:
            del self._store[key]
            return None
        return value

    def set(self, key: str, value) -> None:
        self._store[key] = (time.time(), value)
        self._save()


def extract_zip(text: str | None) -> str | None:
    """Pull a 5-digit zip code out of an address string.

    Taking the first 5-digit run is wrong: a house number often has five
    digits, so "14901 W Ripon Rd, Manteca, CA 95336" yielded 14901. That
    bought market data for a zip that does not exist and scored the listing
    against nothing. A zip follows the state and ends the address, so look
    there first and fall back to the *last* 5-digit run, never the first.
    """
    if not text:
        return None
    match = re.search(r",\s*[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b", text)
    if match:
        return match.group(1)
    match = re.search(r"\b(\d{5})(?:-\d{4})?\s*$", text.strip())
    if match:
        return match.group(1)
    matches = re.findall(r"\b(\d{5})(?:-\d{4})?\b", text)
    return matches[-1] if matches else None


def extract_state(text: str | None) -> str | None:
    """Pull a 2-letter state abbreviation out of an address string.

    Looks for a state in the positions it actually appears in a US address
    ("..., CA 95336" or a trailing ", CA") rather than any two capitals,
    which would match street abbreviations.
    """
    if not text:
        return None
    match = re.search(r",\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\b", text, re.IGNORECASE)
    if match:
        return match.group(1).upper()
    match = re.search(r",\s*([A-Z]{2})\s*$", text.strip(), re.IGNORECASE)
    if match:
        return match.group(1).upper()
    names = "|".join(re.escape(name) for name in sorted(STATE_NAMES, key=len, reverse=True))
    match = re.search(
        rf",\s*({names})(?:\s+\d{{5}}(?:-\d{{4}})?)?\s*$",
        text.strip(),
        re.IGNORECASE,
    )
    return STATE_NAMES.get(match.group(1).lower()) if match else None
