"""Extract listing fields from an uploaded PDF or screenshot.

Last resort in the fallback ladder: scrape -> PDF -> screenshot -> manual.

Extraction and commentary deliberately use different models. Commentary is
prose, and a small local model is fine at it. Extraction produces the numbers
every downstream metric is computed from, and a hallucinated bedroom count
looks exactly like a correctly parsed one — so it is pinned to a capable
model here and never reads the UI's model selector.
"""

import base64
import datetime
import io
import json
import os
import re

from .base import EMPTY_PROPERTY

EXTRACTION_MODEL = "claude-opus-5"

MAX_PDF_BYTES = 10 * 1024 * 1024
# Browser prints of a listing page run long. Only the first few pages are ever
# sent to the model, so a generous cap here costs nothing.
MAX_PDF_PAGES = 60

# A printed listing page is a different animal from an MLS sheet: ten pages of
# site chrome, plat maps, payment calculators and *other* properties' comps.
# Regex over that is unreliable — it read a survey label "8729SF" as living
# area and a calculator's monthly tax as the annual bill — so these go to the
# model, which reads the layout instead of pattern-matching loose numbers.
WEB_PRINT_MARKERS = (
    "payment calculator", "nearby similar homes", "redfin estimate",
    "zestimate", "nearby comparable homes", "new listings for sale",
    "days on redfin", "get prequalified", "walk score", "greatschools",
    "terms of use", "sale and tax history", "market insights",
)
# The facts live at the top of the page; the rest is comps and footer that
# cost tokens and supply distractor numbers.
WEB_PRINT_PAGES_TO_SEND = 3
# The API's per-image cap is 10MB *after* base64 expansion (~33%), so hold
# the raw upload lower.
MAX_IMAGE_BYTES = 8 * 1024 * 1024
# Opus 5 supports high-resolution vision to 2576px on the long edge and
# silently resizes anything larger. Doing it ourselves keeps control of the
# resampling quality on small text, which is the whole payload here.
MAX_IMAGE_EDGE = 2576

SUPPORTED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}

# Minimum fields the regex pass must find before we consider it good enough
# to skip the model.
MIN_REGEX_FIELDS = 3
CORE_FIELDS = ("price", "beds", "baths", "sqft")

EXTRACT_PROMPT = (
    "This is a real estate listing. Extract the property's facts.\n\n"
    "Rules:\n"
    "- Use null for anything not clearly stated. Never guess or infer a value.\n"
    "- sqft is interior living area. Do NOT use lot size, which is often "
    "labelled 'lot' and is usually the larger number.\n"
    "- price is the current list/asking price, not a sold price, estimate, "
    "or price per square foot.\n"
    "- annual_tax: use ONLY a figure the document states as an actual annual "
    "property tax bill or assessment. Do NOT take it from a mortgage or "
    "payment calculator, and do not multiply a monthly figure by 12 — those "
    "are estimates, not the bill. Use null if no real annual tax is stated.\n"
    "- hoa_fee is the MONTHLY HOA dues in dollars; divide if the document "
    "gives an annual figure.\n"
)

LISTING_SCHEMA = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {
            "address": {"type": ["string", "null"]},
            "price": {"type": ["number", "null"]},
            "beds": {"type": ["number", "null"]},
            "baths": {"type": ["number", "null"]},
            "sqft": {"type": ["number", "null"]},
            "year_built": {"type": ["number", "null"]},
            "annual_tax": {"type": ["number", "null"]},
            "hoa_fee": {"type": ["number", "null"]},
            "property_type": {"type": ["string", "null"]},
        },
        "required": [
            "address", "price", "beds", "baths", "sqft",
            "year_built", "annual_tax", "hoa_fee", "property_type",
        ],
        "additionalProperties": False,
    },
}

# Plausibility bounds. Anything outside these is dropped rather than shown.
_BOUNDS = {
    "price": (5_000, 100_000_000),
    "sqft": (100, 60_000),
    "beds": (0, 30),
    "baths": (0, 30),
    "yearBuilt": (1750, datetime.date.today().year + 3),
    "annualTax": (0, 1_000_000),
    "hoaFee": (0, 20_000),
}


class UploadError(Exception):
    """Rejected upload — the message is safe to show the user."""


def ai_available() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY"))


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _clean(field: str, value):
    """Keep a value only if it is a number inside a plausible range."""
    if value is None:
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    low, high = _BOUNDS.get(field, (None, None))
    if low is not None and not (low <= num <= high):
        return None
    if field in ("price", "sqft", "yearBuilt", "annualTax", "hoaFee", "beds"):
        return int(round(num))
    return num


def _validated(fields: dict) -> dict:
    """Apply the shared result shape, dropping implausible values."""
    result = dict(EMPTY_PROPERTY)
    for key in ("price", "sqft", "beds", "baths", "yearBuilt", "annualTax", "hoaFee"):
        cleaned = _clean(key, fields.get(key))
        if cleaned is not None:
            result[key] = cleaned
    for key in ("address", "propertyType"):
        value = fields.get(key)
        if isinstance(value, str) and value.strip():
            result[key] = value.strip()[:200]
    return result


def _found_count(fields: dict) -> int:
    return sum(1 for key in CORE_FIELDS if fields.get(key) is not None)


# ---------------------------------------------------------------------------
# Regex pass (free, local, no key needed)
# ---------------------------------------------------------------------------

# Square footage candidates. The unit must be separated from the number:
# Redfin's printed plat map carries parcel labels like "8729SF" glued
# together, and matching those reported a survey parcel as living area.
_SQFT_CANDIDATE_RE = re.compile(
    r"([\d,]{3,})\s*(?:sq\.?\s*(?:ft|feet)\b|\s(?:sf|square\s+feet)\b)", re.I
)


def _find_sqft(text: str) -> float | None:
    """First square-footage figure that is living area rather than lot size.

    Proximity alone cannot separate the two, because both layouts put "lot"
    just after the number:

        3 Beds | 2 Baths | 1,850 Sq Ft     <- living area, lot line follows
        Lot: 6,499 sq ft lot

        6,732 sq ft                        <- lot size, label on next line
        Lot Size

    What distinguishes them is line structure, so that is what we test: the
    number's own line, and whether that line is nothing but the measurement.
    """
    lines = text.split("\n")
    for index, line in enumerate(lines):
        match = _SQFT_CANDIDATE_RE.search(line)
        if not match:
            continue
        # "Lot: 6,499 sq ft lot" — the label shares the line.
        if "lot" in line.lower():
            continue
        # A line holding only the measurement is captioned by the next line,
        # print-layout style; if that caption says lot, this is the lot.
        if line.strip() == match.group(0).strip():
            following = lines[index + 1].strip().lower() if index + 1 < len(lines) else ""
            if following.startswith("lot"):
                continue
        return _num(match.group(1))
    return None


_PRICE_RE = re.compile(
    r"(?:list(?:ing)?\s*price|asking|price)\s*:?\s*\$\s*([\d,]{4,})", re.I
)
_PRICE_FALLBACK_RE = re.compile(r"\$\s*([\d,]{6,})")
_BEDS_RE = re.compile(r"(?:(\d+)\s*(?:beds?|bd|br|bedrooms?)\b|(?:beds?|bedrooms?)\s*:?\s*(\d+))", re.I)
_BATHS_RE = re.compile(
    r"(?:(\d+(?:\.\d)?)\s*(?:baths?|ba)\b|(?:baths?|bathrooms?)\s*:?\s*(\d+(?:\.\d)?))", re.I
)
_YEAR_RE = re.compile(r"year\s*built\s*:?\s*(\d{4})", re.I)
_TAX_RE = re.compile(
    r"(?:annual\s*)?(?:property\s*)?tax(?:es)?\s*:?\s*\$?\s*([\d,]{3,})", re.I
)
# A mortgage calculator prints taxes per month next to the monthly payment.
# Reading that as the annual bill understates it 12x, so anything far too
# small to be a year's tax on this price is discarded rather than guessed at.
MIN_PLAUSIBLE_TAX_RATE = 0.003
_HOA_RE = re.compile(r"hoa\s*(?:fee|dues)?\s*:?\s*\$?\s*([\d,]+)", re.I)
_ADDRESS_RE = re.compile(r"^(.{5,90}?,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)", re.M)


def _num(raw: str | None):
    if not raw:
        return None
    try:
        return float(raw.replace(",", ""))
    except ValueError:
        return None


def _first_group(match) -> str | None:
    if not match:
        return None
    return next((g for g in match.groups() if g), None)


def parse_text(text: str) -> dict:
    """Pull listing fields out of PDF text with regex. No model involved."""
    fields: dict = {}

    price = _num(_first_group(_PRICE_RE.search(text)))
    if price is None:
        price = _num(_first_group(_PRICE_FALLBACK_RE.search(text)))
    fields["price"] = price

    fields["beds"] = _num(_first_group(_BEDS_RE.search(text)))
    fields["baths"] = _num(_first_group(_BATHS_RE.search(text)))
    fields["sqft"] = _find_sqft(text)
    fields["yearBuilt"] = _num(_first_group(_YEAR_RE.search(text)))

    annual_tax = _num(_first_group(_TAX_RE.search(text)))
    if annual_tax and price and annual_tax < price * MIN_PLAUSIBLE_TAX_RATE:
        annual_tax = None   # a monthly figure, or some other number entirely
    fields["annualTax"] = annual_tax
    fields["hoaFee"] = _num(_first_group(_HOA_RE.search(text)))

    address = _ADDRESS_RE.search(text)
    if address:
        fields["address"] = " ".join(address.group(1).split())

    return fields


def _pdf_text(data: bytes) -> tuple[str, int]:
    """Return (text, page_count)."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    page_count = len(reader.pages)
    if page_count > MAX_PDF_PAGES:
        raise UploadError(
            f"PDF has too many pages (limit {MAX_PDF_PAGES})."
        )
    parts = []
    for page in reader.pages:
        try:
            parts.append(page.extract_text() or "")
        except Exception:
            continue
    return "\n".join(parts), page_count


def _is_web_print(text: str, page_count: int) -> bool:
    """Is this a printed listing web page rather than a clean MLS sheet?"""
    low = (text or "").lower()
    hits = sum(1 for marker in WEB_PRINT_MARKERS if marker in low)
    return hits >= 2 or page_count > 2


def _trim_pdf(data: bytes, max_pages: int) -> bytes:
    """Keep only the leading pages, where the listing's own facts live."""
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(io.BytesIO(data))
    if len(reader.pages) <= max_pages:
        return data
    writer = PdfWriter()
    for page in reader.pages[:max_pages]:
        writer.add_page(page)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def _pdf_block(data: bytes) -> dict:
    return {
        "type": "document",
        "source": {
            "type": "base64",
            "media_type": "application/pdf",
            "data": base64.standard_b64encode(data).decode("ascii"),
        },
    }


# ---------------------------------------------------------------------------
# Model-backed extraction
# ---------------------------------------------------------------------------

async def _extract_with_claude(content_block: dict) -> dict:
    """Send the document or image itself to Claude and get schema-valid fields.

    The file is sent natively rather than as extracted text: MLS sheets are
    column layouts, and flattening them to text is exactly where a model
    misreads which number belongs to which label.
    """
    import anthropic

    client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    response = await client.messages.create(
        model=EXTRACTION_MODEL,
        max_tokens=1024,
        # Field extraction is a simple task; deeper thinking doesn't repay
        # its cost here.
        output_config={"effort": "low", "format": LISTING_SCHEMA},
        messages=[{
            "role": "user",
            "content": [content_block, {"type": "text", "text": EXTRACT_PROMPT}],
        }],
    )

    text = next((b.text for b in response.content if b.type == "text"), None)
    if not text:
        return {}
    try:
        raw = json.loads(text)
    except ValueError:
        return {}

    return {
        "address": raw.get("address"),
        "price": raw.get("price"),
        "beds": raw.get("beds"),
        "baths": raw.get("baths"),
        "sqft": raw.get("sqft"),
        "yearBuilt": raw.get("year_built"),
        "annualTax": raw.get("annual_tax"),
        "hoaFee": raw.get("hoa_fee"),
        "propertyType": raw.get("property_type"),
    }


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------

async def extract_pdf(data: bytes) -> dict:
    """Read a PDF, routing by what kind of document it actually is.

    A clean MLS sheet parses reliably with regex — free and instant. A printed
    listing web page does not: it carries plat-map labels, a payment
    calculator and other properties' comps, and regex picks the wrong numbers
    out of that with no way to know it did. Those go to the model.
    """
    if len(data) > MAX_PDF_BYTES:
        raise UploadError("PDF is too large (limit 10MB).")
    if not data.startswith(b"%PDF"):
        raise UploadError("That file isn't a PDF.")

    try:
        text, page_count = _pdf_text(data)
    except UploadError:
        raise
    except Exception:
        text, page_count = "", 0

    web_print = _is_web_print(text, page_count)
    regex_fields = parse_text(text) if text else {}

    # --- Printed web page: the model reads it, regex is not trusted ---
    if web_print and ai_available():
        try:
            trimmed = _trim_pdf(data, WEB_PRINT_PAGES_TO_SEND)
        except Exception:
            trimmed = data
        try:
            fields = await _extract_with_claude(_pdf_block(trimmed))
            # If the facts weren't in the leading pages, pay for the rest once.
            if _found_count(fields) < MIN_REGEX_FIELDS and trimmed is not data:
                fields = await _extract_with_claude(_pdf_block(data))
        except Exception as exc:
            raise UploadError(f"Could not read the PDF: {exc}") from exc

        result = _validated(fields)
        result["_source"] = "pdf_ai"
        result["_document"] = "web_print"
        return result

    # --- Clean sheet: regex first, model only for what it missed ---
    fields = regex_fields
    source = "pdf"
    if _found_count(fields) < MIN_REGEX_FIELDS and ai_available():
        try:
            ai_fields = await _extract_with_claude(_pdf_block(data))
        except Exception as exc:
            raise UploadError(f"Could not read the PDF: {exc}") from exc
        # Regex wins where it found something — it cannot hallucinate.
        merged = dict(ai_fields)
        merged.update({k: v for k, v in fields.items() if v is not None})
        fields = merged
        source = "pdf_ai"

    result = _validated(fields)
    result["_source"] = source
    result["_document"] = "web_print" if web_print else "sheet"
    return result


def _prepare_image(data: bytes, media_type: str) -> tuple[bytes, str]:
    """Downsample oversized screenshots and normalize to PNG.

    PNG rather than JPEG on purpose: lossy artifacts do the most damage to
    exactly the small digits (price, beds, sqft) being read.
    """
    from PIL import Image

    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:
        raise UploadError("That image couldn't be opened.") from exc

    if max(image.size) > MAX_IMAGE_EDGE:
        scale = MAX_IMAGE_EDGE / max(image.size)
        new_size = (max(1, int(image.width * scale)), max(1, int(image.height * scale)))
        image = image.resize(new_size, Image.LANCZOS)

    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")

    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue(), "image/png"


async def extract_image(data: bytes, media_type: str) -> dict:
    """Screenshots have no text layer, so this path always needs the model."""
    if len(data) > MAX_IMAGE_BYTES:
        raise UploadError("Image is too large (limit 8MB).")
    if media_type not in SUPPORTED_IMAGE_TYPES:
        raise UploadError("Unsupported image type. Use PNG, JPEG, GIF, or WebP.")
    if not ai_available():
        raise UploadError(
            "Screenshot reading needs an Anthropic API key. "
            "Set ANTHROPIC_API_KEY, or upload a PDF instead."
        )

    prepared, prepared_type = _prepare_image(data, media_type)
    block = {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": prepared_type,
            "data": base64.standard_b64encode(prepared).decode("ascii"),
        },
    }
    try:
        fields = await _extract_with_claude(block)
    except Exception as exc:
        raise UploadError(f"Could not read the screenshot: {exc}") from exc

    result = _validated(fields)
    result["_source"] = "screenshot_ai"
    return result
