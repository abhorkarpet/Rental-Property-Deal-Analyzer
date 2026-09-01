"""Batch inventory import, brochure augmentation, and incentive normalization.

Seller spreadsheets are treated as claims.  This module never promotes a
claimed ROI to a calculated return; it produces comparable first-year and
stabilized cash-on-cash screens and carries source/confidence metadata forward
for the full analyzer.
"""

from __future__ import annotations

import asyncio
import csv
import io
import re
import time
from urllib.parse import urlparse

import httpx
from openpyxl import load_workbook


MAX_IMPORT_BYTES = 10 * 1024 * 1024
MAX_DEALS = 200
BROCHURE_CACHE_SECONDS = 24 * 60 * 60


class BatchReviewError(ValueError):
    """User-facing import or augmentation error."""


HEADER_ALIASES = {
    "state": {"state", "st"},
    "asset_type": {"asset type", "property type", "type"},
    "address": {"address", "property", "location", "property address"},
    "deal_type": {"deal type", "inventory type", "construction type"},
    "brochure_url": {
        "brochure url", "brochure link", "link", "more info", "listing url",
    },
    "price": {"price", "purchase price", "asking price", "sale price"},
    "claimed_roi_pct": {"roi", "claimed roi", "return", "estimated roi"},
    "claimed_monthly_cash_flow": {
        "cash flow", "monthly cash flow", "monthly cf", "cashflow",
    },
    "claimed_initial_cash": {
        "initial cash", "total cash", "cash required", "cash to close",
        "total cash investment",
    },
    "beds": {"bed", "beds", "bedrooms", "br"},
    "baths": {"bath", "baths", "bathrooms", "ba"},
    "year_built": {"year built", "built", "year"},
    "incentive_text": {
        "seller incentives", "incentives", "incentive", "promotion",
        "seller credits",
    },
    "monthly_rent": {"rent", "monthly rent", "gross rent"},
    "sqft": {"sqft", "square feet", "square footage", "size"},
}


def _header_key(value) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").strip().lower()).strip()


def _field_for_header(value) -> str | None:
    key = _header_key(value)
    for field, aliases in HEADER_ALIASES.items():
        if key in aliases:
            return field
    return None


def _number(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    raw = str(value).strip()
    if not raw:
        return None
    multiplier = 1000 if re.search(r"[kK]\s*$", raw) else 1
    cleaned = re.sub(r"[^0-9.()-]", "", raw)
    if cleaned.startswith("(") and cleaned.endswith(")"):
        cleaned = "-" + cleaned[1:-1]
    try:
        return float(cleaned) * multiplier
    except (TypeError, ValueError):
        return None


def _percent(value) -> float | None:
    result = _number(value)
    if result is None:
        return None
    raw = str(value or "")
    if "%" not in raw and abs(result) <= 2:
        result *= 100
    return result


def _integer(value) -> int | None:
    parsed = _number(value)
    return int(parsed) if parsed is not None else None


def _amount_token(token: str) -> float | None:
    return _number(token)


def parse_incentives(text: str | None) -> list[dict]:
    """Extract conservative, reviewable incentive options from seller prose."""
    raw = " ".join(str(text or "").split())
    if not raw:
        return []
    lower = raw.lower()
    incentives: list[dict] = []

    def add(kind, label, *, amount=None, promo_rate=None, normal_rate=None,
            start_month=1, end_month=None, included_in_core=True,
            choice_group=None, confidence="medium"):
        key = (kind, amount, promo_rate, normal_rate, start_month, end_month)
        if any(item.get("_key") == key for item in incentives):
            return
        incentives.append({
            "_key": key,
            "id": f"incentive-{len(incentives) + 1}",
            "type": kind,
            "label": label,
            "amount": amount,
            "promotional_rate_pct": promo_rate,
            "normal_rate_pct": normal_rate,
            "start_month": start_month,
            "end_month": end_month,
            "included_in_core": included_in_core,
            "choice_group": choice_group,
            "confidence": confidence,
            "source": "seller",
        })

    amount_pattern = r"\$\s*([\d,.]+\s*[kK]?)"
    for match in re.finditer(amount_pattern + r"\s*(?:of\s+)?cash\s*back", raw, re.I):
        amount = _amount_token(match.group(1))
        add("cash_back", f"{_money_label(amount)} cash back", amount=amount,
            choice_group="seller_funds")

    for match in re.finditer(amount_pattern + r"\s*post[-\s]*closing\s+credit", raw, re.I):
        amount = _amount_token(match.group(1))
        add("closing_credit", f"{_money_label(amount)} post-closing credit",
            amount=amount, choice_group="seller_funds")

    for match in re.finditer(r"post[-\s]*closing\s+credit\s*:\s*" + amount_pattern, raw, re.I):
        amount = _amount_token(match.group(1))
        add("closing_credit", f"{_money_label(amount)} post-closing credit",
            amount=amount, choice_group="seller_funds")

    for match in re.finditer(amount_pattern + r"\s*(?:of\s+)?(?:potential\s+)?tax\s+savings", raw, re.I):
        amount = _amount_token(match.group(1))
        add("tax_estimate", f"{_money_label(amount)} estimated tax benefit",
            amount=amount, included_in_core=False, choice_group="tax_scenario")

    pm_pair = re.search(
        r"(\d+(?:\.\d+)?)\s*%\s*(?:pm|property\s*management).*?"
        r"(?:1st|first|year\s*1).*?(\d+(?:\.\d+)?)\s*%\s*(?:year\s*2|after|thereafter)?",
        raw, re.I,
    )
    if pm_pair:
        add(
            "property_management_discount",
            f"{pm_pair.group(1)}% PM in Year 1, {pm_pair.group(2)}% stabilized",
            promo_rate=float(pm_pair.group(1)), normal_rate=float(pm_pair.group(2)),
            end_month=12, confidence="high",
        )
    elif re.search(r"free\s+(?:property\s+management|pm).*?(?:year\s*1|first\s+year)", raw, re.I):
        add(
            "property_management_discount", "Free property management in Year 1",
            promo_rate=0, normal_rate=None, end_month=12, confidence="high",
        )

    rate = re.search(
        r"rate\s*(?:buy\s*down|buydown)\s*(?:to|at)\s*"
        r"(\d+(?:\.\d+)?)\s*%",
        raw, re.I,
    )
    if rate:
        add(
            "rate_buydown", f"Rate buy-down to {rate.group(1)}%",
            promo_rate=float(rate.group(1)), end_month=None,
            choice_group="seller_funds", confidence="high",
        )

    percent_funds = re.search(r"(\d+(?:\.\d+)?)\s*%\s+(?:incentive|seller\s+credit)", raw, re.I)
    if percent_funds:
        add(
            "unallocated_seller_funds",
            f"{percent_funds.group(1)}% seller incentive — allocation required",
            choice_group="seller_funds", confidence="medium",
        )

    # A generic amount is useful only when the prose says it is available and
    # no more specific cash-back amount was found.
    generic = re.search(amount_pattern + r"\s+(?:incentive\s+)?available", raw, re.I)
    if generic and not any(i["type"] == "cash_back" for i in incentives):
        amount = _amount_token(generic.group(1))
        add(
            "unallocated_seller_funds",
            f"{_money_label(amount)} available — allocation required",
            amount=amount, choice_group="seller_funds", confidence="medium",
        )

    for item in incentives:
        item.pop("_key", None)
    return incentives


def _money_label(amount: float | None) -> str:
    if amount is None:
        return "Unspecified"
    return f"${amount:,.0f}"


def _roi_basis(roi_pct: float | None, incentive_text: str, incentives: list[dict]) -> str:
    promotional = any(
        item["type"] in {"cash_back", "tax_estimate", "rate_buydown"}
        for item in incentives
    )
    text = incentive_text.lower()
    if promotional and ((roi_pct or 0) >= 50 or "tax" in text or "str" in text):
        return "first_year_promotional"
    if "10 year" in text or "10yr" in text or "10-year" in text:
        return "ten_year_projection"
    return "seller_claimed_unspecified"


def _has_exact_address(address: str) -> bool:
    return bool(re.match(r"^\s*\d+[A-Za-z]?\s+\S+", address or ""))


def _pick(mapping: dict, field: str):
    value = mapping.get(field)
    if value is None:
        return None
    return value


def normalize_deal(mapping: dict, source_row: int, *, source="csv") -> dict | None:
    address = str(_pick(mapping, "address") or "").strip()
    price = _number(_pick(mapping, "price"))
    if not address or not price or price <= 0:
        return None

    claimed_roi = _percent(_pick(mapping, "claimed_roi_pct"))
    monthly_cf = _number(_pick(mapping, "claimed_monthly_cash_flow"))
    initial_cash = _number(_pick(mapping, "claimed_initial_cash"))
    incentive_text = str(_pick(mapping, "incentive_text") or "").strip()
    incentives = parse_incentives(incentive_text)
    for incentive in incentives:
        if (
            incentive.get("type") == "unallocated_seller_funds"
            and incentive.get("amount") is None
        ):
            percent_match = re.search(r"(\d+(?:\.\d+)?)\s*%", incentive["label"])
            if percent_match:
                incentive["amount"] = price * float(percent_match.group(1)) / 100
    monthly_rent = _number(_pick(mapping, "monthly_rent"))

    deal = {
        "source_row": source_row,
        "source": source,
        "state": str(_pick(mapping, "state") or "").strip() or None,
        "asset_type": str(_pick(mapping, "asset_type") or "").strip() or None,
        "address": address,
        "deal_type": str(_pick(mapping, "deal_type") or "").strip() or None,
        "brochure_url": str(_pick(mapping, "brochure_url") or "").strip() or None,
        "price": price,
        "claimed_roi_pct": claimed_roi,
        "claimed_monthly_cash_flow": monthly_cf,
        "claimed_initial_cash": initial_cash,
        "beds": _number(_pick(mapping, "beds")),
        "baths": _number(_pick(mapping, "baths")),
        "year_built": _integer(_pick(mapping, "year_built")),
        "sqft": _integer(_pick(mapping, "sqft")),
        "monthly_rent": monthly_rent,
        "incentive_text": incentive_text or None,
        "incentives": incentives,
        "roi_basis": _roi_basis(claimed_roi, incentive_text, incentives),
        "address_quality": "exact" if _has_exact_address(address) else "market_only",
        "warnings": [],
        "field_sources": {},
    }
    _calculate_screens(deal)
    return deal


def _calculate_screens(deal: dict) -> None:
    generated_warnings = {
        "Claimed ROI mixes one-time promotional benefits with recurring returns.",
        "Exact address required for property-level verification.",
    }
    deal["warnings"] = [
        warning for warning in deal.get("warnings") or []
        if warning not in generated_warnings
    ]
    cash = _number(deal.get("claimed_initial_cash"))
    monthly_cf = _number(deal.get("claimed_monthly_cash_flow"))
    rent = _number(deal.get("monthly_rent"))
    stabilized_cf = monthly_cf
    pm_uplift = 0.0

    for incentive in deal.get("incentives") or []:
        if incentive.get("type") != "property_management_discount" or rent is None:
            continue
        promo = incentive.get("promotional_rate_pct")
        normal = incentive.get("normal_rate_pct")
        if promo is None:
            continue
        if normal is None:
            normal = 8.0
            incentive["normal_rate_pct"] = normal
            incentive["normal_rate_source"] = "default"
            deal.setdefault("warnings", []).append(
                "Stabilized property-management rate was not stated; 8% used."
            )
        pm_uplift += rent * (float(normal) - float(promo)) / 100

    if stabilized_cf is not None:
        stabilized_cf -= pm_uplift
    deal["year1_monthly_cash_flow"] = monthly_cf
    deal["stabilized_monthly_cash_flow"] = stabilized_cf
    deal["temporary_pm_uplift_monthly"] = pm_uplift or None
    deal["year1_coc_pct"] = (
        monthly_cf * 12 / cash * 100
        if monthly_cf is not None and cash and cash > 0 else None
    )
    deal["stabilized_coc_pct"] = (
        stabilized_cf * 12 / cash * 100
        if stabilized_cf is not None and cash and cash > 0 else None
    )
    deal["confidence"] = (
        "medium" if deal.get("address_quality") == "exact" else "low"
    )
    if deal.get("roi_basis") == "first_year_promotional":
        deal.setdefault("warnings", []).append(
            "Claimed ROI mixes one-time promotional benefits with recurring returns."
        )
    if deal.get("address_quality") != "exact":
        deal.setdefault("warnings", []).append(
            "Exact address required for property-level verification."
        )


def parse_csv_text(text: str) -> dict:
    if len(text.encode("utf-8")) > MAX_IMPORT_BYTES:
        raise BatchReviewError("CSV is larger than the 10 MB import limit.")
    sample = text.lstrip("\ufeff")
    try:
        rows = list(csv.reader(io.StringIO(sample)))
    except csv.Error as exc:
        raise BatchReviewError(f"Could not read CSV: {exc}") from exc
    return _normalize_rows(rows, source="csv")


def _best_header_row(rows: list[list], limit=20) -> tuple[int, dict[int, str]]:
    best_index = -1
    best_map: dict[int, str] = {}
    for index, row in enumerate(rows[:limit]):
        mapping = {}
        for col, value in enumerate(row):
            field = _field_for_header(value)
            if _header_key(value) == "type" and "asset_type" in mapping.values():
                field = "deal_type"
            if field and field not in mapping.values():
                mapping[col] = field
        required = {"address", "price"}.issubset(mapping.values())
        if required and len(mapping) > len(best_map):
            best_index, best_map = index, mapping
    if best_index < 0:
        raise BatchReviewError(
            "Could not find Address and Price headers in the first 20 rows."
        )
    return best_index, best_map


def _normalize_rows(rows: list[list], *, source: str, links=None) -> dict:
    header_index, columns = _best_header_row(rows)
    workbook_text = " ".join(
        str(value or "") for row in rows for value in row
    ).lower()
    roi_basis_hint = (
        "ten_year_projection"
        if re.search(r"10\s*(?:-|\s)?(?:year|yr)\s+roi", workbook_text)
        else None
    )
    deals = []
    skipped = 0
    for index, row in enumerate(rows[header_index + 1 :], start=header_index + 2):
        mapping = {
            field: row[col] if col < len(row) else None
            for col, field in columns.items()
        }
        if links and index in links:
            mapping["brochure_url"] = links[index]
        deal = normalize_deal(mapping, index, source=source)
        if deal:
            if (
                roi_basis_hint
                and deal.get("roi_basis") == "seller_claimed_unspecified"
            ):
                deal["roi_basis"] = roi_basis_hint
            deals.append(deal)
        elif any(str(value or "").strip() for value in row):
            skipped += 1
        if len(deals) >= MAX_DEALS:
            break
    return {
        "deals": deals,
        "mapping": {str(col + 1): field for col, field in columns.items()},
        "header_row": header_index + 1,
        "skipped_rows": skipped,
        "truncated": len(deals) >= MAX_DEALS,
        "roi_basis_hint": roi_basis_hint,
    }


def parse_xlsx_bytes(data: bytes) -> dict:
    if len(data) > MAX_IMPORT_BYTES:
        raise BatchReviewError("Spreadsheet is larger than the 10 MB import limit.")
    try:
        workbook = load_workbook(io.BytesIO(data), data_only=False, read_only=False)
    except Exception as exc:
        raise BatchReviewError("Could not read the exported Google Sheet.") from exc

    candidates = []
    for worksheet in workbook.worksheets:
        rows = [list(row) for row in worksheet.iter_rows(values_only=True)]
        try:
            header_index, columns = _best_header_row(rows)
        except BatchReviewError:
            continue
        candidates.append((len(columns), worksheet, rows, header_index, columns))
    if not candidates:
        raise BatchReviewError("No worksheet contains recognizable Address and Price columns.")
    _, worksheet, rows, header_index, columns = max(candidates, key=lambda item: item[0])

    link_column = next((col for col, field in columns.items() if field == "brochure_url"), None)
    links = {}
    if link_column is not None:
        for row_number in range(header_index + 2, worksheet.max_row + 1):
            cell = worksheet.cell(row=row_number, column=link_column + 1)
            if cell.hyperlink and cell.hyperlink.target:
                links[row_number] = cell.hyperlink.target
            elif isinstance(cell.value, str) and cell.value.startswith("http"):
                links[row_number] = cell.value

    result = _normalize_rows(rows, source="google_sheet", links=links)
    result["sheet_name"] = worksheet.title
    result["available_sheets"] = workbook.sheetnames
    return result


def google_sheet_id(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.netloc not in {"docs.google.com", "drive.google.com"}:
        raise BatchReviewError("Use a valid https://docs.google.com spreadsheet URL.")
    match = re.search(r"/spreadsheets/d/([A-Za-z0-9_-]+)", parsed.path)
    if not match:
        raise BatchReviewError("Could not identify the Google Sheet ID.")
    return match.group(1)


async def fetch_google_sheet(url: str, client: httpx.AsyncClient | None = None) -> dict:
    sheet_id = google_sheet_id(url)
    export_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=xlsx"
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=25, follow_redirects=True)
    try:
        response = await client.get(export_url)
        if response.status_code != 200:
            raise BatchReviewError(
                "Google Sheet could not be downloaded. Share it as anyone-with-link viewer or upload CSV."
            )
        result = parse_xlsx_bytes(response.content)
        result["spreadsheet_id"] = sheet_id
        return result
    except httpx.HTTPError as exc:
        raise BatchReviewError("Could not connect to Google Sheets.") from exc
    finally:
        if owns_client:
            await client.aclose()


_brochure_cache: dict[str, tuple[float, str]] = {}


def google_doc_id(url: str) -> str | None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != "docs.google.com":
        return None
    match = re.search(r"/document/d/([A-Za-z0-9_-]+)", parsed.path)
    return match.group(1) if match else None


async def fetch_brochure_text(url: str, client: httpx.AsyncClient) -> str:
    document_id = google_doc_id(url)
    if not document_id:
        raise BatchReviewError("Only Google Docs brochure links are supported.")
    cached = _brochure_cache.get(document_id)
    if cached and time.time() - cached[0] < BROCHURE_CACHE_SECONDS:
        return cached[1]
    response = await client.get(
        f"https://docs.google.com/document/d/{document_id}/export?format=txt"
    )
    if response.status_code != 200:
        raise BatchReviewError("Brochure is not publicly readable.")
    text = response.text[:250_000]
    _brochure_cache[document_id] = (time.time(), text)
    return text


def _extract_labeled_number(text: str, labels: list[str]) -> float | None:
    joined = "|".join(re.escape(label) for label in labels)
    match = re.search(rf"(?:{joined})\s*:\s*\$?\s*([\d,.]+)", text, re.I)
    return _number(match.group(1)) if match else None


def augment_from_brochure(deal: dict, text: str) -> dict:
    result = dict(deal)
    result["incentives"] = list(deal.get("incentives") or [])
    result["warnings"] = list(deal.get("warnings") or [])
    result["field_sources"] = dict(deal.get("field_sources") or {})

    extracted = {
        "monthly_rent": _extract_labeled_number(text, ["Rent"]),
        "claimed_initial_cash": _extract_labeled_number(
            text, ["Total Cash Investment", "Total Cash"]
        ),
        "sqft": _extract_labeled_number(text, ["Square Footage", "Sq Ft"]),
        "beds": _extract_labeled_number(text, ["Bedrooms", "Beds"]),
        "baths": _extract_labeled_number(text, ["Bathrooms", "Baths"]),
        "year_built": _extract_labeled_number(text, ["Year Built"]),
    }
    for field, value in extracted.items():
        if value is not None and not result.get(field):
            result[field] = int(value) if field in {"sqft", "year_built"} else value
            result["field_sources"][field] = "brochure"

    if not result.get("claimed_monthly_cash_flow"):
        annual_cash_flow = _extract_labeled_number(text, ["Annual Cash Flow"])
        headline_cash_flow = re.search(
            r"\$\s*([\d,.]+)\s*/\s*month\s+Cash\s+Flow", text, re.I
        )
        if annual_cash_flow is not None:
            result["claimed_monthly_cash_flow"] = annual_cash_flow / 12
            result["field_sources"]["claimed_monthly_cash_flow"] = "brochure"
        elif headline_cash_flow:
            result["claimed_monthly_cash_flow"] = _number(headline_cash_flow.group(1))
            result["field_sources"]["claimed_monthly_cash_flow"] = "brochure"

    location = re.search(r"(?:^|\n)\s*Location\s*:\s*([^\n\r]+)", text, re.I)
    if location and result.get("address_quality") != "exact":
        brochure_address = location.group(1).strip()
        if _has_exact_address(brochure_address):
            result["address"] = brochure_address
            result["address_quality"] = "exact"
            result["field_sources"]["address"] = "brochure"

    status = re.search(r"Rental\s+Status\s*:\s*([^\n\r]+)", text, re.I)
    neighborhood = re.search(r"Neighborhood\s+Class\s*:\s*([^\n\r]+)", text, re.I)
    completion = re.search(r"Estimated\s+Completion\s+Time\s*:\s*([^\n\r]+)", text, re.I)
    result["rental_status"] = status.group(1).strip() if status else result.get("rental_status")
    result["neighborhood_class_claim"] = neighborhood.group(1).strip() if neighborhood else result.get("neighborhood_class_claim")
    result["completion_claim"] = completion.group(1).strip() if completion else result.get("completion_claim")

    brochure_incentives = parse_incentives(text)
    existing = {(item.get("type"), item.get("amount"), item.get("label")) for item in result["incentives"]}
    for item in brochure_incentives:
        key = (item.get("type"), item.get("amount"), item.get("label"))
        if key not in existing:
            item["source"] = "brochure"
            result["incentives"].append(item)
            existing.add(key)
    for index, item in enumerate(result["incentives"], start=1):
        item["id"] = f"incentive-{index}"

    # Preserve conflicting seller values instead of silently choosing one.
    amounts = sorted({
        int(item["amount"])
        for item in result["incentives"]
        if item.get("type") in {
            "cash_back", "closing_credit", "unallocated_seller_funds"
        }
        and item.get("amount")
    })
    if len(amounts) > 1:
        result["warnings"].append(
            "Brochure contains conflicting seller-fund amounts: "
            + ", ".join(_money_label(amount) for amount in amounts) + "."
        )

    result["brochure_status"] = "augmented"
    brochure_basis = _roi_basis(
        result.get("claimed_roi_pct"),
        " ".join([result.get("incentive_text") or "", text]),
        result["incentives"],
    )
    if brochure_basis != "seller_claimed_unspecified":
        result["roi_basis"] = brochure_basis
    _calculate_screens(result)
    return result


async def augment_brochures(deals: list[dict]) -> dict:
    semaphore = asyncio.Semaphore(6)
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        async def augment(deal):
            url = deal.get("brochure_url")
            if not url:
                result = dict(deal)
                result["brochure_status"] = "missing"
                return result
            try:
                async with semaphore:
                    text = await fetch_brochure_text(url, client)
                return augment_from_brochure(deal, text)
            except BatchReviewError as exc:
                result = dict(deal)
                result["brochure_status"] = "unavailable"
                result["brochure_error"] = str(exc)
                return result

        augmented = await asyncio.gather(*(augment(deal) for deal in deals[:MAX_DEALS]))
    return {
        "deals": augmented,
        "augmented_count": sum(d.get("brochure_status") == "augmented" for d in augmented),
        "unavailable_count": sum(d.get("brochure_status") == "unavailable" for d in augmented),
    }
