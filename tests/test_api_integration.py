"""HTTP contract and fallback tests for the FastAPI application."""

from types import SimpleNamespace

import app as app_module


def test_frontend_and_static_assets_share_the_current_version(client):
    response = client.get("/")

    assert response.status_code == 200
    assert f'window.__APP_VERSION__="{app_module.APP_VERSION}"' in response.text
    assert f'id="appVersion">v{app_module.APP_VERSION}</div>' in response.text
    for path in ("/static/css/app.css", "/static/js/deal-engine.js", "/static/js/app.js"):
        assert client.get(path).status_code == 200


def test_neighborhood_search_validates_and_forwards_filters(client, monkeypatch):
    captured = {}

    async def fake_search(location, filters, allow_overage):
        captured.update(location=location, filters=filters, allow_overage=allow_overage)
        return {"listings": [{"address": "1 Main St"}], "total": 1}

    monkeypatch.setattr(app_module.search_service, "neighborhood_search", fake_search)
    response = client.post(
        "/api/search",
        json={
            "location": " 78701 ", "min_price": 100_000, "max_price": 400_000,
            "min_beds": 2, "property_type": "house", "max_results": 10,
            "allow_overage": True,
        },
    )

    assert response.status_code == 200
    assert captured == {
        "location": "78701",
        "filters": {
            "min_price": 100_000.0, "max_price": 400_000.0, "min_beds": 2,
            "property_type": "house", "max_results": 10,
        },
        "allow_overage": True,
    }
    assert client.post("/api/search", json={"location": " "}).status_code == 400
    assert client.post("/api/search", json={"location": "78701", "max_results": 100}).status_code == 422


def test_smart_search_wires_the_automatic_rate_and_service(client, monkeypatch):
    captured = {}

    async def fake_smart_deals(**kwargs):
        captured.update(kwargs)
        return {"listings": [{"address": "2 Main St", "estRent": 2100}], "total": 1}

    monkeypatch.setattr(app_module.search_service, "smart_deals", fake_smart_deals)
    response = client.post(
        "/api/smart-search",
        json={"location": "Austin, TX", "min_beds": 3, "max_results": 25},
    )

    assert response.status_code == 200
    assert captured["location"] == "Austin, TX"
    assert captured["min_beds"] == 3
    assert captured["max_results"] == 25
    assert captured["ensure_mortgage_rate"] is app_module._ensure_mortgage_rate


def test_local_searches_auto_authorize_rentcast_without_ui_gate(client, monkeypatch):
    captured = {}

    async def fake_search(location, filters, allow_overage):
        captured["neighborhood"] = allow_overage
        return {"listings": [], "total": 0}

    async def fake_smart_deals(**kwargs):
        captured["smart"] = kwargs["allow_overage"]
        return {"listings": [], "total": 0}

    monkeypatch.setattr(app_module, "_is_local_request", lambda _request: True)
    monkeypatch.setattr(app_module.search_service, "neighborhood_search", fake_search)
    monkeypatch.setattr(app_module.search_service, "smart_deals", fake_smart_deals)

    neighborhood = client.post("/api/search", json={"location": "95356"})
    smart = client.post("/api/smart-search", json={"location": "95356"})

    assert neighborhood.status_code == 200
    assert smart.status_code == 200
    assert captured == {"neighborhood": True, "smart": True}


def test_search_rate_limit_is_enforced(client, monkeypatch):
    async def fake_search(*_args, **_kwargs):
        return {"listings": [], "total": 0}

    monkeypatch.setattr(app_module.search_service, "neighborhood_search", fake_search)
    statuses = [
        client.post("/api/search", json={"location": "78701"}).status_code
        for _ in range(4)
    ]
    assert statuses == [200, 200, 200, 429]


def test_tax_rate_returns_local_cost_stack_and_state_policy(client, monkeypatch):
    monkeypatch.setattr(app_module.rentcast, "is_configured", lambda: False)
    monkeypatch.setattr(
        app_module.rentcast,
        "usage",
        lambda: {"count": 0, "limit": 50, "remaining": 50, "month": "2026-08"},
    )

    response = client.post(
        "/api/tax-rate",
        json={
            "address": "123 Main St, Los Angeles, CA 90001",
            "price": 400_000,
            "sqft": 1600,
            "yearBuilt": 1965,
            "rent": 2800,
        },
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["state"] == "CA"
    assert payload["tax"]["annual"] == 4600
    assert payload["tax"]["policy"]["annual_cap_pct"] == 2.0
    assert payload["insurance"]["annual"] > 0
    assert payload["reserves"]["maintenance_pct"] > 0
    assert payload["reserves"]["capex_pct"] > 0


def test_rent_estimate_uses_property_avm_when_available(client, monkeypatch):
    async def fake_avm(*_args, **_kwargs):
        return {
            "data": {
                "rent": 2450, "rent_low": 2250, "rent_high": 2650,
                "comparables": [
                    {"address": "Comp 1", "daysOnMarket": 18},
                    {"address": "Comp 2", "daysOnMarket": 26},
                    {"address": "Comp 3", "daysOnMarket": 34},
                ],
            }
        }

    async def no_redfin_rentals(*_args, **_kwargs):
        return {"rentals": [], "total": 0}

    monkeypatch.setattr(app_module.rentcast, "is_configured", lambda: True)
    monkeypatch.setattr(app_module.rentcast, "rent_estimate", fake_avm)
    monkeypatch.setattr(app_module.rentcast, "usage", lambda: {"count": 1, "limit": 50})
    monkeypatch.setattr(app_module, "_search_redfin_rentals", no_redfin_rentals)

    response = client.post(
        "/api/rent-estimate",
        json={"location": "78701", "address": "1 Main St, Austin, TX 78701", "beds": 2},
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["estimate"] == {
        "rent": 2450,
        "rent_low": 2250,
        "rent_high": 2650,
        "source": "rentcast_avm",
        "label": "RentCast property estimate",
    }
    assert payload["vacancy"]["rate_pct"] == 5.2
    assert payload["vacancy"]["sample_size"] == 3
    assert payload["comparables"][0]["address"] == "Comp 1"


def test_rentcast_quota_continuation_does_not_trip_route_limiter(client, monkeypatch):
    async def fake_avm(*_args, **kwargs):
        if kwargs.get("allow_overage"):
            return {
                "data": {
                    "rent": 2820,
                    "rent_low": 2550,
                    "rent_high": 3100,
                    "comparables": [{"daysOnMarket": 21}],
                }
            }
        return {"gate": {"reason": "quota", "message": "confirm spend"}}

    async def no_market(*_args, **_kwargs):
        return None

    async def no_redfin_rentals(*_args, **_kwargs):
        return {"rentals": [], "total": 0}

    monkeypatch.setattr(app_module.rentcast, "is_configured", lambda: True)
    monkeypatch.setattr(app_module.rentcast, "has_cached_rent_estimate", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(app_module.rentcast, "rent_estimate", fake_avm)
    monkeypatch.setattr(app_module.rentcast, "usage", lambda: {"count": 50, "limit": 50})
    monkeypatch.setattr(app_module, "_zip_market_rent", no_market)
    monkeypatch.setattr(app_module, "_search_redfin_rentals", no_redfin_rentals)

    request = {
        "location": "95356",
        "address": "4325 Frontier Way, Modesto, CA 95356",
        "beds": 4,
    }
    initial = [client.post("/api/rent-estimate", json=request) for _ in range(3)]
    continued = client.post(
        "/api/rent-estimate", json={**request, "allow_overage": True}
    )

    assert [response.status_code for response in initial] == [200, 200, 200]
    assert continued.status_code == 200
    assert continued.json()["estimate"]["rent"] == 2820

    monkeypatch.setattr(
        app_module.rentcast,
        "has_cached_rent_estimate",
        lambda *_args, **_kwargs: True,
    )
    cached_reads = [
        client.post("/api/rent-estimate", json=request) for _ in range(4)
    ]
    assert [response.status_code for response in cached_reads] == [200, 200, 200, 200]


def test_rent_estimate_prefers_free_redfin_without_rentcast(client, monkeypatch):
    async def fake_rentals(location, beds):
        assert (location, beds) == ("78701", 2)
        return {
            "rentals": [{"address": "Rental 1", "rent": 2100}],
            "stats": {
                "count": 1, "median": 2100, "low": 2100, "high": 2100,
                "medianDaysOnMarket": 24,
            },
        }

    monkeypatch.setattr(app_module.rentcast, "is_configured", lambda: False)
    monkeypatch.setattr(app_module, "_search_redfin_rentals", fake_rentals)

    response = client.post(
        "/api/rent-estimate",
        json={"location": "78701", "address": "1 Main St, Austin, TX 78701", "beds": 2},
    )

    assert response.status_code == 200
    assert response.json()["estimate"]["rent"] == 2100
    assert response.json()["estimate"]["source"] == "redfin"
    assert response.json()["vacancy"]["source"] == "market"


def test_local_redfin_rent_fills_missing_vacancy_from_zip_cache(client, monkeypatch):
    captured = {}

    async def fake_rentals(location, beds):
        assert (location, beds) == ("95356", 4)
        return {
            "rentals": [{"address": "Redfin comp", "rent": 2800}],
            "stats": {
                "count": 1, "median": 2800, "low": 2800, "high": 2800,
            },
        }

    async def fake_zip_vacancy(location, address, beds, allow_overage=False):
        captured.update(
            location=location,
            address=address,
            beds=beds,
            allow_overage=allow_overage,
        )
        return {
            "rate_pct": 5.2,
            "days_on_market": 26,
            "source": "market",
            "label": "local rentals let in ~26 days in 95356",
            "zip": "95356",
        }

    monkeypatch.setattr(app_module, "_is_local_request", lambda _request: True)
    monkeypatch.setattr(app_module, "_search_redfin_rentals", fake_rentals)
    monkeypatch.setattr(app_module, "_zip_market_vacancy", fake_zip_vacancy)
    monkeypatch.setattr(app_module.rentcast, "is_configured", lambda: True)
    monkeypatch.setattr(
        app_module.rentcast,
        "has_cached_rent_estimate",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(
        app_module.rentcast,
        "usage",
        lambda: {"count": 51, "limit": 50, "remaining": 0},
    )

    response = client.post(
        "/api/rent-estimate",
        json={
            "location": "95356",
            "address": "4325 Frontier Way, Modesto, CA 95356",
            "beds": 4,
        },
    )
    payload = response.json()

    assert response.status_code == 200
    assert payload["estimate"]["source"] == "redfin"
    assert payload["estimate"]["rent"] == 2800
    assert payload["vacancy"]["source"] == "market"
    assert payload["vacancy"]["rate_pct"] == 5.2
    assert captured == {
        "location": "95356",
        "address": "4325 Frontier Way, Modesto, CA 95356",
        "beds": 4,
        "allow_overage": True,
    }


def test_zip_market_vacancy_uses_bedroom_specific_days_and_cached_provider(
    monkeypatch,
):
    captured = {}

    async def fake_market_data(zip_code, allow_overage=False):
        captured.update(zip_code=zip_code, allow_overage=allow_overage)
        return {
            "data": {
                "rentalData": {
                    "medianRent": 2200,
                    "medianDaysOnMarket": 41,
                    "dataByBedrooms": [
                        {
                            "bedrooms": 4,
                            "medianRent": 2850,
                            "medianDaysOnMarket": 19,
                            "totalListings": 12,
                        }
                    ],
                }
            },
            "cached": True,
        }

    monkeypatch.setattr(app_module.rentcast, "is_configured", lambda: True)
    monkeypatch.setattr(app_module.rentcast, "market_data", fake_market_data)

    vacancy = app_module.asyncio.run(
        app_module._zip_market_vacancy(
            "Modesto, CA 95356",
            "4325 Frontier Way, Modesto, CA 95356",
            4,
            allow_overage=True,
        )
    )

    assert captured == {"zip_code": "95356", "allow_overage": True}
    assert vacancy["source"] == "market"
    assert vacancy["days_on_market"] == 19
    assert vacancy["zip"] == "95356"


def test_rent_estimate_free_choice_bypasses_configured_rentcast(client, monkeypatch):
    async def unexpected_avm(*_args, **_kwargs):
        raise AssertionError("RentCast must not be called after the free choice")

    async def fake_rentals(location, beds):
        assert (location, beds) == ("95356", 4)
        return {
            "rentals": [{"address": "Free fallback comp", "rent": 2800}],
            "stats": {
                "count": 1, "median": 2800, "avg": 2800,
                "low": 2800, "high": 2800,
            },
        }

    monkeypatch.setattr(app_module.rentcast, "is_configured", lambda: True)
    monkeypatch.setattr(app_module.rentcast, "rent_estimate", unexpected_avm)
    monkeypatch.setattr(app_module, "_search_redfin_rentals", fake_rentals)

    response = client.post(
        "/api/rent-estimate",
        json={
            "location": "95356",
            "address": "4325 Frontier Way, Modesto, CA 95356",
            "beds": 4,
            "skip_rentcast": True,
        },
    )

    assert response.status_code == 200
    assert response.json()["estimate"]["rent"] == 2800
    assert response.json()["free_source"] is True


def test_free_redfin_result_avoids_a_new_configured_rentcast_call(client, monkeypatch):
    async def unexpected_avm(*_args, **_kwargs):
        raise AssertionError("a usable free Redfin result must win")

    async def fake_rentals(*_args, **_kwargs):
        return {
            "rentals": [{"address": "Redfin comp", "rent": 2750}],
            "stats": {
                "count": 1, "median": 2750, "avg": 2750,
                "low": 2750, "high": 2750,
            },
        }

    monkeypatch.setattr(app_module.rentcast, "is_configured", lambda: True)
    monkeypatch.setattr(
        app_module.rentcast,
        "has_cached_rent_estimate",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(app_module.rentcast, "rent_estimate", unexpected_avm)
    monkeypatch.setattr(app_module, "_search_redfin_rentals", fake_rentals)

    response = client.post(
        "/api/rent-estimate",
        json={
            "location": "95356",
            "address": "4325 Frontier Way, Modesto, CA 95356",
            "beds": 4,
        },
    )

    assert response.status_code == 200
    assert response.json()["estimate"]["source"] == "redfin"


def test_local_rentcast_fallback_auto_continues_and_reports_mode(client, monkeypatch):
    async def no_redfin_rentals(*_args, **_kwargs):
        return {"rentals": [], "total": 0}

    async def fake_avm(*_args, **kwargs):
        assert kwargs["allow_overage"] is True
        return {
            "data": {
                "rent": 2820,
                "rent_low": 2550,
                "rent_high": 3100,
                "comparables": [{"daysOnMarket": 21}],
            }
        }

    monkeypatch.setattr(app_module, "_is_local_request", lambda _request: True)
    monkeypatch.setattr(app_module, "_search_redfin_rentals", no_redfin_rentals)
    monkeypatch.setattr(app_module.rentcast, "is_configured", lambda: True)
    monkeypatch.setattr(
        app_module.rentcast,
        "has_cached_rent_estimate",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(app_module.rentcast, "rent_estimate", fake_avm)
    monkeypatch.setattr(
        app_module.rentcast,
        "usage",
        lambda: {"count": 51, "limit": 50, "remaining": 0},
    )

    response = client.post(
        "/api/rent-estimate",
        json={
            "location": "95356",
            "address": "4325 Frontier Way, Modesto, CA 95356",
            "beds": 4,
        },
    )
    usage = client.get("/api/rentcast-usage").json()

    assert response.status_code == 200
    assert "quota_gate" not in response.json()
    assert response.json()["estimate"]["rent"] == 2820
    assert usage["count"] == 51
    assert usage["local_auto_continue"] is True


def test_scrape_uses_browser_fallback_when_direct_fetch_is_blocked(client, monkeypatch):
    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            return SimpleNamespace(status_code=202, text="challenge")

    async def fake_browser_fetch(_url):
        return "browser listing"

    monkeypatch.setattr(app_module.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(app_module.page_fetch, "fetch_with_playwright", fake_browser_fetch)
    monkeypatch.setattr(
        app_module.page_fetch,
        "looks_like_listing_page",
        lambda html: html == "browser listing",
    )
    monkeypatch.setattr(
        app_module.zillow,
        "extract",
        lambda _soup: {"address": "3 Main St, Austin, TX 78701", "price": 325_000},
    )

    response = client.post(
        "/api/scrape",
        json={"url": "https://www.zillow.com/homedetails/3-Main-St/123_zpid/"},
    )

    assert response.status_code == 200
    assert response.json()["price"] == 325_000


def test_pdf_upload_and_ai_provider_contracts(client, monkeypatch):
    async def fake_pdf(_data):
        return {
            "address": "4 Main St", "price": 275_000,
            "_source": "pdf", "_document": "listing",
        }

    async def fake_ollama(metrics, model_override=None):
        assert "Cash flow" in metrics
        assert model_override == "test-model"
        return "## Assessment\nA controlled test analysis."

    monkeypatch.setattr(app_module.upload, "extract_pdf", fake_pdf)
    upload_response = client.post(
        "/api/extract-upload",
        files={"file": ("listing.pdf", b"%PDF-1.4 test", "application/pdf")},
    )
    assert upload_response.status_code == 200
    assert upload_response.json()["fields_found"] == ["address", "price"]

    monkeypatch.setattr(app_module, "_resolve_provider", lambda: ("ollama", None))
    monkeypatch.setattr(app_module, "_analyze_with_ollama", fake_ollama)
    ai_response = client.post(
        "/api/analyze-ai",
        json={"metrics": "Cash flow: $500", "model": "test-model"},
    )
    assert ai_response.status_code == 200
    assert ai_response.json()["provider"] == "ollama"
