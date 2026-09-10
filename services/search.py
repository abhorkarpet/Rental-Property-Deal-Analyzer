"""Search use cases shared by Neighborhood Search and Smart Deal Finder."""

import asyncio
from collections.abc import Awaitable, Callable

from providers import appreciation, rentcast
from providers.base import extract_zip
from providers.redfin import _search_redfin_page, _search_redfin_rentals, _median_rent, _qualify_redfin_rentals


MAX_MARKET_ZIPS_PER_SEARCH = 3


class SearchError(Exception):
    def __init__(self, message: str, status_code: int = 404):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def _median(values: list[int]) -> int:
    return _median_rent(values)


def attach_appreciation(result: dict, location: str) -> None:
    """Attach the same local market appreciation used by the analyzer."""
    listings = result.get("listings") or []
    if not listings:
        return

    fallback = result.get("location_label") or location
    resolved: dict[str, dict] = {}
    for listing in listings:
        address = listing.get("address") or fallback
        key = extract_zip(address) or extract_zip(fallback) or "_"
        if key not in resolved:
            resolved[key] = appreciation.resolve_appreciation(
                address=address if key != "_" else fallback
            )
        profile = resolved[key]
        listing["apprPct"] = profile["rate_pct"]
        listing["apprHistoricalPct"] = profile["rate_pct"]
        listing["apprSource"] = profile["source"]

    primary = next(iter(resolved.values()), None)
    if primary:
        result["appreciation"] = primary


async def attach_market_rents(
    result: dict, location: str, allow_overage: bool = False
) -> None:
    """Use RentCast only for listings the free rental search could not price."""
    listings = [
        listing for listing in (result.get("listings") or [])
        if not listing.get("estRent")
    ]
    if not listings or not rentcast.is_configured():
        return

    fallback_zip = (
        rentcast.zip_from_address(result.get("location_label") or "")
        or rentcast.zip_from_address(location)
    )
    zips: list[str] = []
    listing_zips: list[str | None] = []
    for listing in listings:
        zip_code = rentcast.zip_from_address(listing.get("address")) or fallback_zip
        listing_zips.append(zip_code)
        if zip_code and zip_code not in zips:
            zips.append(zip_code)

    if not zips:
        return

    fetched: dict[str, dict] = {}
    for zip_code in zips[:MAX_MARKET_ZIPS_PER_SEARCH]:
        market = await rentcast.market_data(zip_code, allow_overage)
        if market.get("gate"):
            result["quota_gate"] = market["gate"]
            break
        if market.get("data"):
            fetched[zip_code] = market["data"]

    if not fetched:
        result["rentcast_usage"] = rentcast.usage()
        return

    for listing, zip_code in zip(listings, listing_zips):
        data = fetched.get(zip_code)
        if not data:
            continue
        estimate = rentcast.rent_from_market(
            data, listing.get("beds"), listing.get("sqft")
        )
        if estimate:
            listing["estRent"] = estimate["rent"]
            listing["rentSource"] = "rentcast_market"
            listing["rentSampleSize"] = estimate.get("sample_size")
            listing["rentDaysOnMarket"] = estimate.get("days_on_market")
            listing["rentBasis"] = f"ZIP {zip_code} market estimate; verify property-specific rent"
            listing["rentConfidence"] = "low"
            listing["rentMethodVersion"] = 2

    result["rent_zips"] = list(fetched)
    result["rentcast_usage"] = rentcast.usage()


def attach_redfin_rents(result: dict, rentals_result: dict) -> None:
    """Match asking rents by exact bedrooms, then size when evidence permits.

    Never substitute a smaller home's rent for a missing bedroom group. A
    bedroom median can legitimately repeat; expose the method and sample size.
    """
    rentals = _qualify_redfin_rentals(rentals_result.get("rentals") or [])
    for listing in result.get("listings") or []:
        listing.update(estRent=None, rentSource=None, rentSampleSize=0,
                       rentConfidence="unavailable", rentMethodVersion=2,
                       rentBasis="No matching bedroom rental comps; verify rent")
        beds = listing.get("beds")
        if beds is None:
            continue
        comps = [r for r in rentals if r.get("beds") == beds]
        if not comps:
            continue
        basis = f"{beds}-bed asking-rent median; size not matched"
        sqft = listing.get("sqft")
        if sqft and sqft > 0:
            sized = [r for r in comps if r.get("sqft") and
                     0.75 <= r["sqft"] / sqft <= 1.25]
            if len(sized) >= 3:
                comps = sized
                basis = f"{beds}-bed asking-rent median; size within 25%"
        listing.update(
            estRent=_median([r["rent"] for r in comps]), rentSource="redfin",
            rentSampleSize=len(comps), rentBasis=basis,
            rentConfidence="medium" if len(comps) >= 5 else "low",
        )
    result["rent_stats"] = rentals_result.get("stats")


async def neighborhood_search(
    location: str, filters: dict, allow_overage: bool = False
) -> dict:
    result, rentals_result = await asyncio.gather(
        _search_redfin_page(location, filters),
        _search_redfin_rentals(location, None, property_type=filters.get("property_type") or "house"),
    )
    if "error" in result and "listings" not in result:
        raise SearchError(result["error"])

    attach_redfin_rents(result, rentals_result)
    await attach_market_rents(result, location, allow_overage)
    attach_appreciation(result, location)
    return result


def _rent_medians(rentals: list[dict]) -> tuple[dict[int, int], list[int]]:
    by_beds: dict[int, list[int]] = {}
    all_rents: list[int] = []
    for rental in rentals:
        rent_value = rental.get("rent", 0)
        if rent_value <= 0:
            continue
        all_rents.append(rent_value)
        beds = rental.get("beds")
        if beds is not None and beds > 0:
            by_beds.setdefault(beds, []).append(rent_value)
    return {beds: _median(rents) for beds, rents in by_beds.items()}, all_rents


async def smart_deals(
    *,
    location: str,
    min_beds: int = 0,
    property_type: str | None = None,
    min_price: float | None = None,
    max_price: float | None = None,
    max_results: int = 50,
    allow_overage: bool = False,
    ensure_mortgage_rate: Callable[[], Awaitable[float | None]],
) -> dict:
    """Discover and enrich likely deals without leaking HTTP concerns here."""
    initial_filters = {
        "min_price": min_price or 25_000,
        "max_price": max_price,
        "min_beds": min_beds,
        "property_type": property_type or "house",
        "max_results": min(max_results + 20, 80),
        "sort": "price-asc",
    }
    rentals_result, listings_result, current_rate = await asyncio.gather(
        _search_redfin_rentals(location, None, property_type=property_type or "house"),
        _search_redfin_page(location, initial_filters),
        ensure_mortgage_rate(),
    )

    if "error" in listings_result and "listings" not in listings_result:
        raise SearchError(listings_result["error"])

    rent_median_by_beds, all_rents = _rent_medians(
        rentals_result.get("rentals", [])
    )
    overall_median = _median(all_rents) if all_rents else 0

    attach_redfin_rents(listings_result, rentals_result)
    await attach_market_rents(listings_result, location, allow_overage)
    quota_gate = listings_result.get("quota_gate")
    estimates = [l["estRent"] for l in listings_result.get("listings", [])
                 if l.get("estRent")]
    if not overall_median and estimates:
        overall_median = _median(estimates)
    if not estimates and not quota_gate:
        raise SearchError(
            "No rental data found for these homes. Try a nearby zip code — "
            "matching bedroom rent comps are needed to estimate deals."
        )

    # Goal scoring happens on the client. A rent/price heuristic must not
    # silently remove appreciation or hybrid candidates before they are scored.
    listings = listings_result.get("listings", [])
    if max_price is not None:
        listings = [listing for listing in listings if (listing.get("price") or 0) <= max_price]
    listings = [
        listing for listing in listings
        if not (listing.get("address") or "").strip().startswith("0 ")
    ]
    if not listings:
        raise SearchError("No for-sale listings found. Try a different location.")

    listings = listings[:max_results]
    result = {"listings": listings}
    attach_appreciation(result, location)

    payload = {
        "listings": listings,
        "appreciation": result.get("appreciation"),
        "total": listings_result.get("total", len(listings)),
        "location_label": listings_result.get("location_label", location),
        "rent_stats": rentals_result.get("stats"),
        "rent_by_beds": {str(key): value for key, value in rent_median_by_beds.items()},
        "smart_max_price": max_price,
        "rent_confidence": (
            "medium" if listings and all(l.get("rentConfidence") == "medium" for l in listings) else "low"
        ),
        "mortgage_rate": current_rate,
        "rentcast_usage": rentcast.usage(),
    }
    if quota_gate:
        payload["quota_gate"] = quota_gate
    return payload
