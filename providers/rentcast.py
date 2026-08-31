"""RentCast API client with a quota gate.

Activated only when RENTCAST_API_KEY is set; every caller must work without
it. The free Developer tier allows 50 requests/month and bills a per-request
overage fee beyond that, so crossing the limit is a spending decision that
belongs to the user — this module never silently spends past the reserve and
never silently degrades. It stops and returns a `gate` for the UI to resolve.
"""

import json
import os
import time
from pathlib import Path

import httpx

from .base import TTLCache, extract_zip
from .estimates import is_plausible_tax_rate

BASE_URL = "https://api.rentcast.io/v1"
USAGE_FILE = Path(__file__).resolve().parent.parent / ".rentcast_usage.json"

# Fraction of the monthly limit at which automatic calls stop and the user
# is asked instead.
RESERVE_FRACTION = 0.9

# Rent grows more slowly than floor area; see rent_from_market for the fit.
SIZE_SCALING_EXPONENT = 0.5

# Zip-scoped data is shared by every property in that zip, so cache it hard —
# and on disk, so restarting the app doesn't re-buy statistics we already have.
_DATA_DIR = Path(__file__).resolve().parent.parent
_market_cache = TTLCache(24 * 3600, _DATA_DIR / ".rentcast_market_cache.json")
_tax_rate_cache = TTLCache(24 * 3600, _DATA_DIR / ".rentcast_tax_cache.json")
_rent_cache = TTLCache(24 * 3600, _DATA_DIR / ".rentcast_rent_cache.json")

# App property type -> RentCast's enum.
PROPERTY_TYPE_MAP = {
    "sfh": "Single Family",
    "single family": "Single Family",
    "single-family": "Single Family",
    "house": "Single Family",
    "condo": "Condo",
    "townhouse": "Townhouse",
    "manufactured": "Manufactured",
    "multifamily": "Multi-Family",
    "multi-family": "Multi-Family",
    "apartment": "Apartment",
}


def _rent_cache_key(
    address: str,
    beds: float | None = None,
    baths: float | None = None,
    sqft: int | None = None,
    property_type: str | None = None,
) -> str:
    """Stable key for a property AVM and the attributes that affect it."""
    normalized_address = " ".join(address.lower().split())
    mapped_type = PROPERTY_TYPE_MAP.get((property_type or "").strip().lower())
    return json.dumps(
        [normalized_address, beds, baths, sqft, mapped_type],
        separators=(",", ":"),
    )


def has_cached_rent_estimate(
    address: str,
    beds: float | None = None,
    baths: float | None = None,
    sqft: int | None = None,
    property_type: str | None = None,
) -> bool:
    """Return whether this exact AVM can be served without another API call."""
    if not address:
        return False
    return _rent_cache.get(
        _rent_cache_key(address, beds, baths, sqft, property_type)
    ) is not None


def is_configured() -> bool:
    return bool(os.getenv("RENTCAST_API_KEY"))


def monthly_limit() -> int:
    try:
        return int(os.getenv("RENTCAST_MONTHLY_LIMIT", "50"))
    except ValueError:
        return 50


def _hard_limit() -> int | None:
    raw = os.getenv("RENTCAST_HARD_LIMIT")
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _current_month() -> str:
    return time.strftime("%Y-%m")


def _read_usage() -> dict:
    """Load the persisted counter, resetting it when the month rolls over."""
    month = _current_month()
    try:
        data = json.loads(USAGE_FILE.read_text())
        if data.get("month") == month:
            return {"month": month, "count": int(data.get("count", 0))}
    except (OSError, ValueError, TypeError):
        pass
    return {"month": month, "count": 0}


def _write_usage(data: dict) -> None:
    try:
        USAGE_FILE.write_text(json.dumps(data))
    except OSError:
        # A read-only deploy shouldn't break searches; we just lose the count.
        pass


def usage() -> dict:
    data = _read_usage()
    limit = monthly_limit()
    return {
        "count": data["count"],
        "limit": limit,
        "month": data["month"],
        "remaining": max(0, limit - data["count"]),
    }


def _reserve_reached(count: int) -> bool:
    return count >= monthly_limit() * RESERVE_FRACTION


def _gate(reason: str = "quota") -> dict:
    """Payload telling the caller to ask the user before spending."""
    info = usage()
    return {
        "reason": reason,
        "usage": info,
        "message": (
            f"Monthly RentCast limit reached ({info['count']}/{info['limit']}). "
            "A property-specific estimate costs 1 request and may incur an "
            "overage fee."
        ),
    }


async def _request(
    path: str, params: dict, allow_overage: bool = False
) -> dict:
    """Single entry point for every RentCast call.

    Returns {"data": ...} on success, {"gate": ...} when the user must decide,
    or {"error": ...} when the call failed. Only real HTTP calls count against
    the quota — cache hits are free.
    """
    if not is_configured():
        return {"error": "RentCast is not configured."}

    current = _read_usage()

    hard = _hard_limit()
    if hard is not None and current["count"] >= hard:
        return {"error": "RentCast hard request limit reached."}

    if _reserve_reached(current["count"]) and not allow_overage:
        return {"gate": _gate()}

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(
                f"{BASE_URL}{path}",
                params=params,
                headers={
                    "X-Api-Key": os.getenv("RENTCAST_API_KEY", ""),
                    "Accept": "application/json",
                },
            )
    except httpx.RequestError:
        return {"error": "Could not reach RentCast."}

    # The request was made, so it counts regardless of the response.
    current["count"] += 1
    _write_usage(current)

    if resp.status_code == 403:
        return {"error": "RentCast subscription is inactive or the key is invalid."}
    if resp.status_code == 404:
        return {"data": None}
    if resp.status_code != 200:
        return {"error": f"RentCast error (HTTP {resp.status_code})."}

    try:
        return {"data": resp.json()}
    except ValueError:
        return {"error": "RentCast returned an unreadable response."}


# ---------------------------------------------------------------------------
# Zip-level market data — the cheapest useful call. One per zip, cached.
# ---------------------------------------------------------------------------

async def market_data(zip_code: str, allow_overage: bool = False) -> dict:
    """Aggregate rental stats for a zip, including per-bedroom rent/sqft."""
    if not zip_code:
        return {"error": "A zip code is required."}

    cached = _market_cache.get(zip_code)
    if cached is not None:
        return {"data": cached, "cached": True}

    result = await _request(
        "/markets",
        {"zipCode": zip_code, "dataType": "Rental", "historyRange": 12},
        allow_overage,
    )
    if result.get("data"):
        _market_cache.set(zip_code, result["data"])
    return result


def rent_from_market(market: dict | None, beds: int | None, sqft: int | None) -> dict | None:
    """Per-listing rent estimate from zip market data.

    This is what replaces applying one typed rent to every listing: a unit's
    rent scales with its size, so a 385 sqft studio and a 2,000 sqft house in
    the same zip no longer get the same number.
    """
    if not market:
        return None
    rental = market.get("rentalData") or {}
    by_beds = {
        entry.get("bedrooms"): entry
        for entry in rental.get("dataByBedrooms") or []
        if entry.get("bedrooms") is not None
    }

    entry = None
    if beds is not None and beds in by_beds:
        entry = by_beds[beds]
    elif beds is not None and by_beds:
        # Nearest bedroom count we have data for.
        nearest = min(by_beds, key=lambda b: abs(b - beds))
        entry = by_beds[nearest]

    stats = entry or rental
    if not stats:
        return None

    median = stats.get("medianRent")
    median_sqft = stats.get("medianSquareFootage")

    rent = None
    if sqft and median and median_sqft:
        # Anchor on the bedroom class median and damp the size adjustment.
        #
        # Rent is NOT linear in square footage: small units rent at a much
        # higher rate per sqft than large ones (a real zip shows 1bd at
        # $2.53/sqft against 4bd at $1.35/sqft). Multiplying a class's median
        # $/sqft by an above-median size therefore overshoots badly — it put a
        # 2,372 sqft home at $4,483/mo in a zip whose 3bd rentals top out at
        # $3,000. Fitting rent against size across bedroom classes gives an
        # exponent near 0.4-0.45; 0.5 is the conservative round number.
        rent = median * (sqft / median_sqft) ** SIZE_SCALING_EXPONENT
    elif median:
        rent = median

    if not rent:
        return None

    # Never leave the range this bedroom class actually rents for.
    low, high = stats.get("minRent"), stats.get("maxRent")
    if low:
        rent = max(rent, low)
    if high:
        rent = min(rent, high)

    return {
        "rent": int(round(rent)),
        "beds": entry.get("bedrooms") if entry else None,
        "sample_size": stats.get("totalListings"),
        "days_on_market": stats.get("medianDaysOnMarket"),
        "median_rent": median,
        "source": "rentcast_market",
    }


# ---------------------------------------------------------------------------
# Per-property rent AVM
# ---------------------------------------------------------------------------

async def rent_estimate(
    address: str,
    beds: float | None = None,
    baths: float | None = None,
    sqft: int | None = None,
    property_type: str | None = None,
    allow_overage: bool = False,
) -> dict:
    """Property-specific rent estimate with a confidence range and comps."""
    if not address:
        return {"error": "An address is required."}

    cache_key = _rent_cache_key(address, beds, baths, sqft, property_type)
    cached = _rent_cache.get(cache_key)
    if cached is not None:
        return {"data": cached, "cached": True}

    params: dict = {"address": address}
    if beds is not None:
        params["bedrooms"] = beds
    if baths is not None:
        params["bathrooms"] = baths
    if sqft:
        params["squareFootage"] = sqft
    mapped = PROPERTY_TYPE_MAP.get((property_type or "").strip().lower())
    if mapped:
        params["propertyType"] = mapped

    result = await _request("/avm/rent/long-term", params, allow_overage)
    data = result.get("data")
    if not data:
        return result

    payload = {
        "rent": data.get("rent"),
        "rent_low": data.get("rentRangeLow"),
        "rent_high": data.get("rentRangeHigh"),
        "comparables": (data.get("comparables") or [])[:5],
        "source": "rentcast_avm",
    }
    _rent_cache.set(cache_key, payload)
    return {"data": payload, "cached": False}


# ---------------------------------------------------------------------------
# Zip-level effective property tax rate
# ---------------------------------------------------------------------------

async def zip_tax_rate(zip_code: str, allow_overage: bool = False) -> dict:
    """Derive the local effective tax rate from real assessment records.

    Each record gives tax paid and assessed value for the same property, so
    the ratio is a true rate even where assessments are stale — and the median
    across the zip picks up county and special-district levies that a state
    average cannot see.
    """
    if not zip_code:
        return {"error": "A zip code is required."}

    cached = _tax_rate_cache.get(zip_code)
    if cached is not None:
        return {"data": cached, "cached": True}

    result = await _request(
        "/properties", {"zipCode": zip_code, "limit": 50}, allow_overage
    )
    records = result.get("data")
    if not records:
        return result

    ratios = []
    for record in records:
        taxes = record.get("propertyTaxes") or {}
        assessments = record.get("taxAssessments") or {}
        if not taxes or not assessments:
            continue
        # Compare the same year where possible; otherwise the latest of each.
        shared_years = set(taxes) & set(assessments)
        year = max(shared_years) if shared_years else None
        if year is None:
            continue
        total = (taxes.get(year) or {}).get("total")
        value = (assessments.get(year) or {}).get("value")
        if not total or not value or value <= 0:
            continue
        ratios.append(total / value)

    if len(ratios) < 5:
        # Too thin a sample to trust; caller falls back to the state table.
        return {"data": None}

    ratios.sort()
    median = ratios[len(ratios) // 2]
    if not is_plausible_tax_rate(median):
        return {"data": None}

    payload = {"rate": median, "sample_size": len(ratios)}
    _tax_rate_cache.set(zip_code, payload)
    return {"data": payload}


def zip_from_address(address: str | None) -> str | None:
    return extract_zip(address)
