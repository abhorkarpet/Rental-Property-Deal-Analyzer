"""Provider parsing, caching, and local-data fallback coverage."""

import asyncio
import json

from bs4 import BeautifulSoup

from providers import estimates, page_fetch, rentcast, upload, zillow
from providers.base import TTLCache, extract_zip


def test_listing_page_detection_requires_positive_listing_evidence():
    valid = "<html><script type='application/ld+json'>{}</script>" + "x" * 20_000
    blocked = "<html>captcha</html>" + "x" * 20_000

    assert page_fetch.looks_like_listing_page(valid)
    assert not page_fetch.looks_like_listing_page(blocked)
    assert not page_fetch.looks_like_listing_page("short response")


def test_zillow_next_data_is_normalized_to_the_shared_property_shape():
    prop = {
        "address": {
            "streetAddress": "10 Oak Ave", "city": "Austin",
            "state": "TX", "zipcode": "78701",
        },
        "price": 310_000,
        "bedrooms": 3,
        "bathrooms": 2,
        "livingArea": 1550,
        "yearBuilt": 1984,
        "homeType": "SINGLE_FAMILY",
        "rentZestimate": 2400,
        "taxHistory": [{"year": 2025, "taxPaid": 5200}],
    }
    payload = {"props": {"pageProps": {"property": prop}}}
    soup = BeautifulSoup(
        f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(payload)}</script>',
        "lxml",
    )

    result = zillow.extract(soup)

    assert result["address"] == "10 Oak Ave, Austin, TX 78701"
    assert result["price"] == 310_000
    assert result["annualTax"] == 5200
    assert result["rentZestimate"] == 2400


def test_market_rent_scales_by_bedroom_and_size_without_leaving_observed_range():
    market = {
        "rentalData": {
            "medianRent": 2200,
            "dataByBedrooms": [
                {
                    "bedrooms": 3, "medianRent": 2500, "medianSquareFootage": 1500,
                    "minRent": 2100, "maxRent": 2900, "totalListings": 18,
                    "medianDaysOnMarket": 24,
                }
            ],
        }
    }

    normal = rentcast.rent_from_market(market, beds=3, sqft=1800)
    oversized = rentcast.rent_from_market(market, beds=3, sqft=10_000)

    assert 2500 < normal["rent"] <= 2900
    assert oversized["rent"] == 2900
    assert normal["sample_size"] == 18
    assert normal["days_on_market"] == 24


def test_cache_persists_and_expires(monkeypatch, tmp_path):
    now = [1_000.0]
    monkeypatch.setattr("providers.base.time.time", lambda: now[0])
    path = tmp_path / "cache.json"
    cache = TTLCache(60, path)
    cache.set("78701", {"rent": 2200})

    reloaded = TTLCache(60, path)
    assert reloaded.get("78701") == {"rent": 2200}
    now[0] += 61
    assert reloaded.get("78701") is None


def test_property_rent_avm_is_cached_with_comparable_timing(monkeypatch):
    calls = []

    async def fake_request(path, params, allow_overage=False):
        calls.append((path, params, allow_overage))
        return {
            "data": {
                "rent": 2820,
                "rentRangeLow": 2550,
                "rentRangeHigh": 3100,
                "comparables": [{"daysOnMarket": 21, "price": 2800}],
            }
        }

    monkeypatch.setattr(rentcast, "_rent_cache", TTLCache(24 * 3600))
    monkeypatch.setattr(rentcast, "_request", fake_request)

    kwargs = {
        "address": "4325 Frontier Way, Modesto, CA 95356",
        "beds": 4,
        "baths": 2.5,
        "sqft": 1858,
        "property_type": "Single Family",
    }
    first = asyncio.run(rentcast.rent_estimate(**kwargs))
    second = asyncio.run(rentcast.rent_estimate(**kwargs))

    assert len(calls) == 1
    assert first["cached"] is False
    assert second["cached"] is True
    assert second["data"]["comparables"][0]["daysOnMarket"] == 21


def test_vacancy_reuses_the_median_days_on_market_from_avm_comps():
    vacancy = estimates.vacancy_from_comparables([
        {"daysOnMarket": 14},
        {"daysOnMarket": 28},
        {"daysOnMarket": 42},
        {"daysOnMarket": None},
    ])

    assert vacancy["source"] == "market"
    assert vacancy["days_on_market"] == 28
    assert vacancy["sample_size"] == 3
    assert "3 nearby rental comps" in vacancy["label"]


def test_address_and_estimate_fallbacks_are_explicit():
    assert extract_zip("14901 W Ripon Rd, Manteca, CA 95336") == "95336"
    tax = estimates.resolve_tax_rate(0.50, "1 Main St, Austin, TX 78701")
    vacancy = estimates.vacancy_from_days_on_market(None)

    assert tax["source"] == "state"
    assert tax["rate"] == estimates.STATE_TAX_RATES["TX"]
    assert vacancy["source"] == "default"
    assert vacancy["rate_pct"] == estimates.DEFAULT_VACANCY_PCT


def test_uploaded_listing_text_is_cleaned_and_validated():
    parsed = upload.parse_text(
        "123 Main Street, Austin, TX 78701\n"
        "$325,000\n3 beds 2 baths 1,650 sqft\nBuilt in 1988\n"
    )

    assert parsed["price"] == 325_000
    assert parsed["beds"] == 3
    assert parsed["baths"] == 2
    assert parsed["sqft"] == 1650
    assert parsed["yearBuilt"] == 1988
