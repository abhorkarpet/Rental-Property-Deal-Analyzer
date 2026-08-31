import asyncio

import pytest

from services import search


APPRECIATION = {
    "conservative_pct": 2.5,
    "rate_pct": 4.0,
    "source": "fhfa_zip",
}


def test_neighborhood_search_enriches_appreciation(monkeypatch):
    async def listings(_location, _filters):
        return {
            "listings": [{"address": "1 Main St, Austin, TX 78701"}],
            "location_label": "Austin, TX 78701",
        }

    async def no_rentals(_location, _beds):
        return {"rentals": [], "total": 0}

    monkeypatch.setattr(search, "_search_redfin_page", listings)
    monkeypatch.setattr(search, "_search_redfin_rentals", no_rentals)
    monkeypatch.setattr(search.rentcast, "is_configured", lambda: False)
    monkeypatch.setattr(
        search.appreciation, "resolve_appreciation", lambda **_kwargs: APPRECIATION
    )

    result = asyncio.run(search.neighborhood_search("78701", {}))

    assert result["listings"][0]["apprPct"] == 2.5
    assert result["appreciation"] == APPRECIATION


def test_neighborhood_prefers_free_redfin_rents_before_rentcast(monkeypatch):
    async def listings(_location, _filters):
        return {
            "listings": [
                {"address": "1 Main St, Austin, TX 78701", "beds": 3},
            ],
            "location_label": "Austin, TX 78701",
        }

    async def rentals(_location, _beds):
        return {
            "rentals": [
                {"rent": 2200, "beds": 3},
                {"rent": 2400, "beds": 3},
            ],
            "stats": {"count": 2, "median": 2400},
        }

    async def unexpected_market(*_args, **_kwargs):
        raise AssertionError("RentCast should not run when Redfin supplied rent")

    monkeypatch.setattr(search, "_search_redfin_page", listings)
    monkeypatch.setattr(search, "_search_redfin_rentals", rentals)
    monkeypatch.setattr(search.rentcast, "is_configured", lambda: True)
    monkeypatch.setattr(search.rentcast, "market_data", unexpected_market)
    monkeypatch.setattr(
        search.appreciation, "resolve_appreciation", lambda **_kwargs: APPRECIATION
    )

    result = asyncio.run(search.neighborhood_search("78701", {}))

    assert result["listings"][0]["estRent"] == 2400
    assert result["listings"][0]["rentSource"] == "redfin"


def test_smart_deals_uses_concurrent_rate_and_listing_rent(monkeypatch):
    async def rentals(_location, _beds):
        return {
            "rentals": [
                {"rent": 1800, "beds": 2},
                {"rent": 2000, "beds": 2},
                {"rent": 2200, "beds": 3},
            ],
            "stats": {"count": 3, "median": 2000, "low": 1800, "high": 2200},
        }

    async def listings(_location, _filters):
        return {
            "listings": [
                {
                    "address": "1 Main St, Austin, TX 78701",
                    "price": 300_000,
                    "beds": 2,
                    "sqft": 1400,
                }
            ],
            "total": 1,
            "location_label": "Austin, TX 78701",
        }

    async def mortgage_rate():
        return 6.5

    monkeypatch.setattr(search, "_search_redfin_rentals", rentals)
    monkeypatch.setattr(search, "_search_redfin_page", listings)
    monkeypatch.setattr(search.rentcast, "is_configured", lambda: False)
    monkeypatch.setattr(
        search.appreciation, "resolve_appreciation", lambda **_kwargs: APPRECIATION
    )

    result = asyncio.run(
        search.smart_deals(
            location="78701",
            min_beds=2,
            max_results=10,
            ensure_mortgage_rate=mortgage_rate,
        )
    )

    assert result["mortgage_rate"] == 6.5
    assert result["listings"][0]["estRent"] == 2000
    assert result["listings"][0]["apprPct"] == 2.5
    assert result["smart_max_price"] == 500_000


def test_neighborhood_search_limits_metered_zip_calls_and_surfaces_quota(monkeypatch):
    listings = [
        {"address": f"{index} Main St, Test, TX {zip_code}", "beds": 2, "sqft": 1200}
        for index, zip_code in enumerate(("78701", "78702", "78703", "78704"), 1)
    ]
    calls = []

    async def listing_search(_location, _filters):
        return {"listings": listings, "location_label": "Austin, TX"}

    async def no_rentals(_location, _beds):
        return {"rentals": [], "total": 0}

    async def market_data(zip_code, _allow_overage=False):
        calls.append(zip_code)
        if zip_code == "78703":
            return {"gate": {"reason": "quota", "message": "confirm spend"}}
        return {
            "data": {
                "rentalData": {
                    "medianRent": 2100,
                    "dataByBedrooms": [{
                        "bedrooms": 2, "medianRent": 2200,
                        "medianSquareFootage": 1100, "minRent": 1800,
                        "maxRent": 2600, "totalListings": 12,
                    }],
                }
            }
        }

    monkeypatch.setattr(search, "_search_redfin_page", listing_search)
    monkeypatch.setattr(search, "_search_redfin_rentals", no_rentals)
    monkeypatch.setattr(search.rentcast, "is_configured", lambda: True)
    monkeypatch.setattr(search.rentcast, "market_data", market_data)
    monkeypatch.setattr(search.rentcast, "usage", lambda: {"count": 45, "limit": 50})
    monkeypatch.setattr(
        search.appreciation, "resolve_appreciation", lambda **_kwargs: APPRECIATION
    )

    result = asyncio.run(search.neighborhood_search("Austin, TX", {}))

    assert calls == ["78701", "78702", "78703"]
    assert result["quota_gate"]["reason"] == "quota"
    assert result["listings"][0]["estRent"] > 0
    assert result["rent_zips"] == ["78701", "78702"]


def test_smart_deals_requires_a_rent_signal(monkeypatch):
    async def no_rentals(_location, _beds):
        return {"rentals": [], "stats": {"count": 0}}

    async def listings(_location, _filters):
        return {
            "listings": [{"address": "1 Main St, Austin, TX 78701", "price": 250_000}],
            "location_label": "Austin, TX 78701",
        }

    async def mortgage_rate():
        return 6.5

    monkeypatch.setattr(search, "_search_redfin_rentals", no_rentals)
    monkeypatch.setattr(search, "_search_redfin_page", listings)
    monkeypatch.setattr(search.rentcast, "is_configured", lambda: False)

    with pytest.raises(search.SearchError, match="No rental data found"):
        asyncio.run(
            search.smart_deals(location="78701", ensure_mortgage_rate=mortgage_rate)
        )


def test_smart_deals_applies_price_cap_and_drops_placeholder_addresses(monkeypatch):
    async def rentals(_location, _beds):
        return {
            "rentals": [{"rent": 1600, "beds": 2}] * 6,
            "stats": {"count": 6, "median": 1600, "low": 1600, "high": 1600},
        }

    async def listings(_location, _filters):
        return {
            "listings": [
                {"address": "1 Main St, Austin, TX 78701", "price": 350_000, "beds": 2},
                {"address": "2 Main St, Austin, TX 78701", "price": 450_000, "beds": 2},
                {"address": "0 Unknown, Austin, TX 78701", "price": 200_000, "beds": 2},
            ],
            "total": 3,
            "location_label": "Austin, TX 78701",
        }

    async def mortgage_rate():
        return 6.25

    monkeypatch.setattr(search, "_search_redfin_rentals", rentals)
    monkeypatch.setattr(search, "_search_redfin_page", listings)
    monkeypatch.setattr(search.rentcast, "is_configured", lambda: False)
    monkeypatch.setattr(search.rentcast, "usage", lambda: {"count": 0, "limit": 50})
    monkeypatch.setattr(
        search.appreciation, "resolve_appreciation", lambda **_kwargs: APPRECIATION
    )

    result = asyncio.run(
        search.smart_deals(location="78701", ensure_mortgage_rate=mortgage_rate)
    )

    assert result["smart_max_price"] == 400_000
    assert [listing["address"] for listing in result["listings"]] == [
        "1 Main St, Austin, TX 78701"
    ]
    assert result["rent_confidence"] == "medium"
