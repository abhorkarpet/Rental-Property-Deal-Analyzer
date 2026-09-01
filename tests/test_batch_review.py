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

    async def fake_augment(deals):
        deals = [dict(deal, brochure_status="augmented") for deal in deals]
        return {"deals": deals, "augmented_count": len(deals), "unavailable_count": 0}

    monkeypatch.setattr(app_module.batch_review, "augment_brochures", fake_augment)
    augmented = client.post(
        "/api/batch-review/augment", json={"deals": imported.json()["deals"]}
    )
    assert augmented.status_code == 200
    assert augmented.json()["augmented_count"] == 2


def test_batch_import_api_requires_exactly_one_source(client):
    neither = client.post("/api/batch-review/import", json={})
    both = client.post(
        "/api/batch-review/import",
        json={"csv_text": RTR_CSV, "sheet_url": "https://docs.google.com/spreadsheets/d/x/edit"},
    )
    assert neither.status_code == 400
    assert both.status_code == 400
