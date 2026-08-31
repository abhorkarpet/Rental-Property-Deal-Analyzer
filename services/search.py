"""Search use cases shared by Neighborhood Search and Smart Deal Finder."""

import asyncio
from collections.abc import Awaitable, Callable

from providers import appreciation, rentcast
from providers.base import extract_zip
from providers.redfin import _search_redfin_page, _search_redfin_rentals


MAX_MARKET_ZIPS_PER_SEARCH = 3


class SearchError(Exception):
    def __init__(self, message: str, status_code: int = 404):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def _median(values: list[int]) -> int:
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def attach_appreciation(result: dict, location: str) -> None:
    """Attach the same conservative ZIP appreciation used by the analyzer."""
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
        listing["apprPct"] = profile["conservative_pct"]
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

    default_zip = next(iter(fetched))
    for listing, zip_code in zip(listings, listing_zips):
        data = fetched.get(zip_code or default_zip) or fetched[default_zip]
        estimate = rentcast.rent_from_market(
            data, listing.get("beds"), listing.get("sqft")
        )
        if estimate:
            listing["estRent"] = estimate["rent"]
            listing["rentSource"] = "rentcast_market"
            listing["rentSampleSize"] = estimate.get("sample_size")
            listing["rentDaysOnMarket"] = estimate.get("days_on_market")

    result["rent_zips"] = list(fetched)
    result["rentcast_usage"] = rentcast.usage()


def attach_redfin_rents(result: dict, rentals_result: dict) -> None:
    """Attach free bedroom-matched Redfin medians before metered fallbacks."""
    medians, all_rents = _rent_medians(rentals_result.get("rentals") or [])
    overall = _median(all_rents) if all_rents else 0
    if not overall:
        return
    for listing in result.get("listings") or []:
        estimate = _rent_for_beds(listing.get("beds"), medians, overall)
        if estimate:
            listing["estRent"] = estimate
            listing["rentSource"] = "redfin"
            listing["rentSampleSize"] = len(all_rents)
    result["rent_stats"] = rentals_result.get("stats")


async def neighborhood_search(
    location: str, filters: dict, allow_overage: bool = False
) -> dict:
    result, rentals_result = await asyncio.gather(
        _search_redfin_page(location, filters),
        _search_redfin_rentals(location, filters.get("min_beds") or None),
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


def _rent_for_beds(
    beds: int | None, medians: dict[int, int], overall_median: int
) -> int | None:
    bed_rent = None
    if beds and beds in medians:
        bed_rent = medians[beds]
    elif beds and medians:
        closest = min(medians, key=lambda count: abs(count - beds))
        bed_rent = medians[closest]

    if bed_rent and overall_median and bed_rent > overall_median * 1.3:
        return int((bed_rent + overall_median) / 2)
    return bed_rent or overall_median or None


async def smart_deals(
    *,
    location: str,
    min_beds: int = 0,
    property_type: str | None = None,
    min_price: float | None = None,
    max_results: int = 50,
    allow_overage: bool = False,
    ensure_mortgage_rate: Callable[[], Awaitable[float | None]],
) -> dict:
    """Discover and enrich likely deals without leaking HTTP concerns here."""
    initial_filters = {
        "min_price": min_price or 25_000,
        "max_price": 750_000,
        "min_beds": min_beds,
        "property_type": property_type or "house",
        "max_results": min(max_results + 20, 80),
        "sort": "price-asc",
    }
    rental_beds = min_beds if min_beds >= 2 else None
    rentals_result, listings_result, current_rate = await asyncio.gather(
        _search_redfin_rentals(location, rental_beds),
        _search_redfin_page(location, initial_filters),
        ensure_mortgage_rate(),
    )

    if "error" in listings_result and "listings" not in listings_result:
        raise SearchError(listings_result["error"])

    rent_median_by_beds, all_rents = _rent_medians(
        rentals_result.get("rentals", [])
    )
    overall_median = _median(all_rents) if all_rents else 0

    market_zip_data = None
    quota_gate = None
    if not all_rents and rentcast.is_configured():
        market_zip = (
            rentcast.zip_from_address(listings_result.get("location_label") or "")
            or rentcast.zip_from_address(location)
        )
        if not market_zip:
            market_zip = next(
                (
                    rentcast.zip_from_address(listing.get("address"))
                    for listing in listings_result.get("listings") or []
                    if rentcast.zip_from_address(listing.get("address"))
                ),
                None,
            )
        if market_zip:
            market_result = await rentcast.market_data(market_zip, allow_overage)
            market_zip_data = market_result.get("data")
            quota_gate = market_result.get("gate")
            market_median = (
                (market_zip_data or {}).get("rentalData") or {}
            ).get("medianRent")
            if market_median:
                overall_median = market_median

    if not all_rents and not market_zip_data:
        raise SearchError(
            "No rental data found for this area. Try a nearby zip code — "
            "rent comps are needed to estimate deals."
        )

    smart_max_price = None
    if overall_median > 0:
        smart_max_price = int(overall_median * 250)
        smart_max_price = ((smart_max_price + 24_999) // 25_000) * 25_000
        smart_max_price = max(smart_max_price, 75_000)

    listings = listings_result.get("listings", [])
    if smart_max_price:
        listings = [
            listing for listing in listings
            if listing.get("price", 0) <= smart_max_price
        ]
    listings = [
        listing for listing in listings
        if not (listing.get("address") or "").strip().startswith("0 ")
    ]
    if not listings:
        raise SearchError("No for-sale listings found. Try a different location.")

    for listing in listings[:max_results]:
        listing["estRent"] = _rent_for_beds(
            listing.get("beds"), rent_median_by_beds, overall_median
        )
        if market_zip_data:
            scaled = rentcast.rent_from_market(
                market_zip_data, listing.get("beds"), listing.get("sqft")
            )
            if scaled:
                listing["estRent"] = scaled["rent"]
                listing["rentSource"] = "rentcast_market"
                listing["rentSampleSize"] = scaled.get("sample_size")
                listing["rentDaysOnMarket"] = scaled.get("days_on_market")

        price = listing.get("price") or 0
        if listing["estRent"] and price > 0:
            listing["estRent"] = min(
                listing["estRent"], max(int(price * 0.02), 500)
            )

    listings = listings[:max_results]
    result = {"listings": listings}
    attach_appreciation(result, location)
    rent_count = len(all_rents)

    payload = {
        "listings": listings,
        "appreciation": result.get("appreciation"),
        "total": listings_result.get("total", len(listings)),
        "location_label": listings_result.get("location_label", location),
        "rent_stats": rentals_result.get("stats"),
        "rent_by_beds": {str(key): value for key, value in rent_median_by_beds.items()},
        "smart_max_price": smart_max_price,
        "rent_confidence": (
            "high" if rent_count >= 15 else "medium" if rent_count >= 5 else "low"
        ),
        "mortgage_rate": current_rate,
        "rentcast_usage": rentcast.usage(),
    }
    if quota_gate:
        payload["quota_gate"] = quota_gate
    return payload
