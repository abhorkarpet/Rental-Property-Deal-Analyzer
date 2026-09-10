"""Regression coverage for v3 batch inventory review."""

import asyncio
import io

import httpx
from openpyxl import Workbook

import app as app_module
from services import batch_review


RTR_CSV = """Type,Address,Type,LINK,PRICE,ROI,CASH FLOW,INITIAL CASH,BED,BATH,YEAR BUILT,SELLER INCENTIVES
SFR,"**Fort Pierce, FL 34947 ($44,187 Incentive Available Now!)",New Construction,https://docs.google.com/document/d/test-doc/edit,"$339,900",120%,$204,"$57,000",4,2,2026,"$44K Cash Back + $37K Potential Tax Savings"
SFR,"1626 12th Ave N, Bessemer, AL 35020",Turnkey Rehab,https://docs.google.com/document/d/rehab-doc/edit,"$143,000",13%,$352,"$36,000",3,2,1944,
"""


def test_csv_import_preserves_claims_and_separates_duplicate_type_columns():
    result = batch_review.parse_csv_text(RTR_CSV)

    assert result["header_row"] == 1
    assert len(result["deals"]) == 2
    promo, rehab = result["deals"]
    assert promo["asset_type"] == "SFR"
    assert promo["deal_type"] == "New Construction"
    assert promo["claimed_roi_pct"] == 120
    assert promo["year1_coc_pct"] == 204 * 12 / 57_000 * 100
    assert promo["roi_basis"] == "first_year_promotional"
    assert rehab["address_quality"] == "exact"


def test_inventory_footnote_applies_ten_year_basis_only_to_non_promotional_roi():
    text = RTR_CSV + (
        ',"*Assumptions: 10yr ROI assumes a 10yr holding period without sale.",,,,,,,,,,,\n'
    )
    result = batch_review.parse_csv_text(text)

    assert result["roi_basis_hint"] == "ten_year_projection"
    assert result["deals"][0]["roi_basis"] == "first_year_promotional"
    assert result["deals"][1]["roi_basis"] == "ten_year_projection"


def test_incentive_parser_keeps_tax_out_of_core_and_requires_explicit_buydown_rate():
    incentives = batch_review.parse_incentives(
        "$44K Cash Back + $37K Potential Tax Savings. "
        "Use as cash back or rate buy down. 30% accelerated depreciation."
    )

    assert {item["type"] for item in incentives} == {"cash_back", "tax_estimate"}
    tax = next(item for item in incentives if item["type"] == "tax_estimate")
    assert tax["included_in_core"] is False

    buydown = batch_review.parse_incentives("Free PM Year 1. Rate Buydown to 3.75%")
    assert next(item for item in buydown if item["type"] == "rate_buydown")[
        "promotional_rate_pct"
    ] == 3.75


def test_brochure_augmentation_turns_pm_discount_into_stabilized_cash_flow():
    deal = batch_review.parse_csv_text(RTR_CSV)["deals"][1]
    augmented = batch_review.augment_from_brochure(
        deal,
        """13% ROI Turnkey SFR! $352/month Cash Flow, $36K total cash!
        Rent: $1200
        Square Footage: 1168
        Rental Status: Vacant
        5% PM for 1st year, 9% Year 2
        """,
    )

    assert augmented["monthly_rent"] == 1200
    assert augmented["sqft"] == 1168
    assert augmented["temporary_pm_uplift_monthly"] == 48
    assert augmented["stabilized_monthly_cash_flow"] == 304
    assert round(augmented["stabilized_coc_pct"], 2) == 10.13
    assert augmented["rental_status"] == "Vacant"


def test_brochure_extracts_two_year_pm_rent_and_closing_credits():
    deal = batch_review.normalize_deal(
        {"address": "Memphis, TN 38114", "price": 215000},
        source_row=2,
    )
    augmented = batch_review.augment_from_brochure(
        deal,
        """18% ROI New Build Turnkey SFR!
        0% PM for 2 years
        $900 Rent Credit
        $6,900 closing credit
        Rent: $1750
        Square Footage: 1430
        Bedrooms: 4
        Bathrooms: 2
        Year Built: 2025
        """,
    )

    by_type = {item["type"]: item for item in augmented["incentives"]}
    assert by_type["property_management_discount"]["promotional_rate_pct"] == 0
    assert by_type["property_management_discount"]["normal_rate_pct"] == 8
    assert by_type["property_management_discount"]["end_month"] == 24
    assert by_type["rent_credit"]["amount"] == 900
    assert by_type["rent_credit"]["choice_group"] is None
    assert by_type["closing_credit"]["amount"] == 6900
    assert by_type["closing_credit"]["choice_group"] is None
    assert augmented["monthly_rent"] == 1750
    assert augmented["sqft"] == 1430
    assert augmented["beds"] == 4
    assert augmented["baths"] == 2
    assert augmented["year_built"] == 2025


def test_fort_morgan_brochure_preserves_leased_rent_and_headline_cash():
    deal = batch_review.normalize_deal(
        {"address": "Fort Morgan, CO 80701", "price": 311500},
        source_row=2,
    )
    augmented = batch_review.augment_from_brochure(
        deal,
        """16% ROI New Build Turnkey SFR! $755/month Cash Flow, $78K total cash!
        $900 Rent Credit
        Free PM Year 1 (8% Starting Year 2)
        Price: $311,500
        Location: Fort Morgan, CO 80701
        Type: Single Family Residence
        Neighborhood Class: A
        Rent: $2495
        Square Footage: 1160
        Bedrooms: 3
        Bathrooms: 2.0
        Year Built: 2025
        Estimated Completion Time: Completed
        Rental Status: Leased
        """,
    )

    by_type = {item["type"]: item for item in augmented["incentives"]}
    assert augmented["monthly_rent"] == 2495
    assert augmented["field_sources"]["monthly_rent"] == "brochure"
    assert augmented["claimed_initial_cash"] == 78000
    assert augmented["claimed_monthly_cash_flow"] == 755
    assert augmented["rental_status"] == "Leased"
    assert by_type["rent_credit"]["amount"] == 900
    assert by_type["property_management_discount"]["promotional_rate_pct"] == 0
    assert by_type["property_management_discount"]["normal_rate_pct"] == 8
    assert by_type["property_management_discount"]["end_month"] == 12


def test_llm_brochure_merge_requires_source_evidence_and_preserves_hard_parse():
    deal = batch_review.normalize_deal(
        {"address": "Memphis, TN 38114", "price": 215000},
        source_row=2,
    )
    text = (
        "The monthly lease amount is $1,750. "
        "Management fees are waived for the first twenty-four months."
    )
    deterministic = batch_review.augment_from_brochure(deal, text)
    assert batch_review.brochure_needs_llm(text, deterministic) is True

    merged = batch_review.merge_llm_brochure_result(
        deterministic,
        text,
        {
            "fields": {"monthly_rent": 1750},
            "incentives": [
                {
                    "type": "property_management_discount",
                    "label": "0% PM for 24 months",
                    "amount": None,
                    "promotional_rate_pct": 0,
                    "normal_rate_pct": None,
                    "start_month": 1,
                    "end_month": 24,
                    "is_alternative": False,
                    "confidence": "high",
                    "evidence": "Management fees are waived for the first twenty-four months",
                },
                {
                    "type": "closing_credit",
                    "label": "$9,999 invented credit",
                    "amount": 9999,
                    "confidence": "high",
                    "evidence": "This phrase is not in the brochure",
                },
            ],
            "ambiguities": [],
        },
    )

    assert merged["monthly_rent"] == 1750
    assert merged["field_sources"]["monthly_rent"] == "brochure_llm"
    assert merged["brochure_llm_added_fields"] == 1
    assert merged["brochure_llm_added_incentives"] == 1
    assert any(
        item["type"] == "property_management_discount"
        and item["source"] == "brochure_llm"
        for item in merged["incentives"]
    )
    assert not any(item.get("amount") == 9999 for item in merged["incentives"])


def test_brochure_llm_fallback_is_cached_and_nonduplicating(monkeypatch):
    batch_review._brochure_llm_cache.clear()
    deal = batch_review.normalize_deal(
        {
            "address": "Memphis, TN 38114",
            "price": 215000,
            "brochure_url": "https://docs.google.com/document/d/cache-test/edit",
        },
        source_row=2,
    )
    text = "The monthly lease amount is $1,750. Management fees are waived for 24 months."
    calls = []

    async def fake_fetch(_url, _client):
        return text

    async def fake_llm(_text, _deal):
        calls.append(True)
        return {
            "fields": {"monthly_rent": 1750},
            "incentives": [],
            "ambiguities": [],
        }

    monkeypatch.setattr(batch_review, "fetch_brochure_text", fake_fetch)
    first = asyncio.run(batch_review.augment_brochures([deal], llm_parser=fake_llm))
    second = asyncio.run(batch_review.augment_brochures([deal], llm_parser=fake_llm))

    assert len(calls) == 1
    assert first["deals"][0]["monthly_rent"] == 1750
    assert first["llm_augmented_count"] == 1
    assert second["deals"][0]["brochure_llm_cache_hit"] is True
    batch_review._brochure_llm_cache.clear()


def test_brochure_conflicting_seller_funds_are_flagged():
    deal = batch_review.parse_csv_text(RTR_CSV)["deals"][0]
    augmented = batch_review.augment_from_brochure(
        deal,
        "Post-Closing Credit: $28,100\nRate Buydown to 4.25%",
    )

    assert any(item["type"] == "closing_credit" for item in augmented["incentives"])
    assert any("conflicting seller-fund amounts" in warning for warning in augmented["warnings"])
    assert any(
        item["type"] == "rate_buydown" and item["promotional_rate_pct"] == 4.25
        for item in augmented["incentives"]
    )


def test_market_screen_uses_stabilized_pm_and_discloses_missing_costs():
    deal = batch_review.parse_csv_text(RTR_CSV)["deals"][1]
    deal = batch_review.augment_from_brochure(
        deal, "Rent: $1200\n5% PM for 1st year, 9% Year 2"
    )
    screen = batch_review.calculate_market_screen(
        deal,
        monthly_rent=1350,
        vacancy_pct=5,
        annual_tax=1200,
        annual_insurance=1800,
        maintenance_pct=7,
        capex_pct=6,
        mortgage_rate_pct=6.5,
    )

    assert screen["management_pct"] == 9
    assert screen["down_payment_pct"] == 25
    assert screen["closing_cost_pct"] == 3
    assert screen["cash_invested"] == 40040
    assert set(screen["missing_costs"]) == {"HOA", "utilities", "repairs", "loan points"}
    assert screen["monthly_cash_flow"] < 1350


def _xlsx_fixture():
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "Inventory"
    worksheet.append([
        "Type", "Address", "Type", "LINK", "PRICE", "ROI", "CASH FLOW",
        "INITIAL CASH", "BED", "BATH", "YEAR BUILT", "SELLER INCENTIVES",
    ])
    worksheet.append([
        "SFR", "101 Test Ave, Austin, TX 78701", "Turnkey Rehab", "Brochure",
        300000, 0.15, 500, 75000, 3, 2, 1985, "",
    ])
    worksheet["D2"].hyperlink = "https://docs.google.com/document/d/brochure-id/edit"
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


def test_xlsx_import_preserves_hidden_brochure_hyperlinks():
    result = batch_review.parse_xlsx_bytes(_xlsx_fixture())

    assert result["sheet_name"] == "Inventory"
    assert result["deals"][0]["brochure_url"].endswith("/brochure-id/edit")
    assert result["deals"][0]["claimed_roi_pct"] == 15


def test_public_sheet_fetch_uses_safe_google_export_url():
    requested = []

    def handler(request):
        requested.append(str(request.url))
        return httpx.Response(200, content=_xlsx_fixture())

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await batch_review.fetch_google_sheet(
                "https://docs.google.com/spreadsheets/d/safe_sheet-123/edit?gid=9",
                client,
            )

    result = asyncio.run(run())
    assert len(result["deals"]) == 1
    assert requested == [
        "https://docs.google.com/spreadsheets/d/safe_sheet-123/export?format=xlsx"
    ]


def test_google_import_rejects_non_google_hosts():
    try:
        batch_review.google_sheet_id(
            "https://evil.example/spreadsheets/d/safe_sheet-123/edit"
        )
    except batch_review.BatchReviewError as exc:
        assert "docs.google.com" in str(exc)
    else:
        raise AssertionError("unsafe spreadsheet host was accepted")


def test_batch_import_api_and_brochure_augmentation_api(client, monkeypatch):
    imported = client.post(
        "/api/batch-review/import",
        json={"csv_text": RTR_CSV, "augment_brochures": False},
    )
    assert imported.status_code == 200
    assert imported.json()["count"] == 2

    async def fake_augment(deals, llm_parser=None):
        assert llm_parser is app_module._parse_brochure_with_llm
        deals = [dict(deal, brochure_status="augmented") for deal in deals]
        return {
            "deals": deals, "augmented_count": len(deals),
            "unavailable_count": 0, "llm_augmented_count": 0,
        }

    monkeypatch.setattr(app_module.batch_review, "augment_brochures", fake_augment)
    augmented = client.post(
        "/api/batch-review/augment", json={"deals": imported.json()["deals"]}
    )
    assert augmented.status_code == 200
    assert augmented.json()["augmented_count"] == 2


def test_batch_zip_enrichment_groups_market_data_and_calculates_screen(client, monkeypatch):
    deal = batch_review.parse_csv_text(RTR_CSV)["deals"][1]

    async def fake_redfin(zip_code, beds, **kwargs):
        assert (zip_code, beds) == ("35020", 3)
        assert kwargs["property_type"] == "SFR"
        return {
            "rentals": [],
            "stats": {"count": 12, "median": 1350, "low": 1150, "high": 1500,
                      "medianDaysOnMarket": 21},
        }

    async def fake_tax(zip_code, allow_overage):
        assert zip_code == "35020"
        return {"data": {"rate": 0.006, "sample_size": 20}, "cached": True}

    async def fake_market(*_args, **_kwargs):
        raise AssertionError("RentCast market should not run when Redfin has rent and DOM")

    async def fake_rate():
        return 6.5

    monkeypatch.setattr(app_module, "_search_redfin_rentals", fake_redfin)
    monkeypatch.setattr(app_module, "_ensure_mortgage_rate", fake_rate)
    monkeypatch.setattr(app_module.rentcast, "is_configured", lambda: True)
    monkeypatch.setattr(app_module.rentcast, "zip_tax_rate", fake_tax)
    monkeypatch.setattr(app_module.rentcast, "market_data", fake_market)
    monkeypatch.setattr(
        app_module.rentcast, "usage", lambda: {"count": 8, "limit": 50, "remaining": 42}
    )

    response = client.post("/api/batch-review/enrich", json={"deals": [deal]})
    assert response.status_code == 200
    payload = response.json()
    assert payload["zip_count"] == 1
    assert payload["screened_count"] == 1
    enriched = payload["deals"][0]
    assert enriched["market_rent"] == 1350
    assert enriched["market_rent_source"] == "redfin"
    assert enriched["market_tax"]["annual"] == 858
    assert enriched["market_screen"]["mortgage_rate_pct"] == 6.5


def test_analyze_details_can_explicitly_prefer_property_rentcast_avm(client, monkeypatch):
    async def fake_avm(address, **kwargs):
        assert address == "1626 12th Ave N, Bessemer, AL 35020"
        assert kwargs["allow_overage"] is True
        return {
            "data": {
                "rent": 1425, "rent_low": 1325, "rent_high": 1525,
                "comparables": [{"daysOnMarket": 18}],
            },
            "cached": False,
        }

    async def no_redfin(*_args, **_kwargs):
        raise AssertionError("explicit property AVM must run before Redfin")

    monkeypatch.setattr(app_module.rentcast, "is_configured", lambda: True)
    monkeypatch.setattr(app_module.rentcast, "has_cached_rent_estimate", lambda *_a, **_k: False)
    monkeypatch.setattr(app_module.rentcast, "rent_estimate", fake_avm)
    monkeypatch.setattr(app_module.rentcast, "usage", lambda: {"count": 9, "limit": 50})
    monkeypatch.setattr(app_module, "_search_redfin_rentals", no_redfin)

    response = client.post(
        "/api/rent-estimate",
        json={
            "location": "35020",
            "address": "1626 12th Ave N, Bessemer, AL 35020",
            "beds": 3,
            "prefer_rentcast": True,
            "allow_overage": True,
        },
    )
    assert response.status_code == 200
    assert response.json()["estimate"]["rent"] == 1425
    assert response.json()["estimate"]["source"] == "rentcast_avm"


def test_batch_import_api_requires_exactly_one_source(client):
    neither = client.post("/api/batch-review/import", json={})
    both = client.post(
        "/api/batch-review/import",
        json={"csv_text": RTR_CSV, "sheet_url": "https://docs.google.com/spreadsheets/d/x/edit"},
    )
    assert neither.status_code == 400
    assert both.status_code == 400


def test_batch_uses_entered_rate_when_market_lookup_is_unavailable(client, monkeypatch):
    deal = batch_review.parse_csv_text(RTR_CSV)["deals"][1]

    async def no_rate():
        return None

    async def rentals(*_args, **_kwargs):
        return {"stats": {"count": 12, "median": 1350, "medianDaysOnMarket": 21}}

    monkeypatch.setattr(app_module, "_ensure_mortgage_rate", no_rate)
    monkeypatch.setattr(app_module, "_search_redfin_rentals", rentals)
    monkeypatch.setattr(app_module.rentcast, "is_configured", lambda: False)
    for entered, expected, source in [(6.75, 6.75, "entered"), (None, 7.0, "default"), (0, 0, "entered")]:
        response = client.post("/api/batch-review/enrich", json={"deals": [deal], "mortgage_rate_pct": entered})
        assert response.status_code == 200
        data = response.json()
        assert data["mortgage_rate"] == expected
        assert data["mortgage_rate_source"] == source
        assert data["deals"][0]["market_screen"]["mortgage_rate_pct"] == expected
