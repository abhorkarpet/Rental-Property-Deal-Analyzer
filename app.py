import os, json, re, traceback, webbrowser, threading, time, asyncio
from pathlib import Path
from urllib.parse import urlparse
from collections import defaultdict
from dotenv import load_dotenv
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import StreamingResponse
import httpx
from bs4 import BeautifulSoup
import uvicorn

from providers import (
    appreciation,
    estimates,
    page_fetch,
    property_tax,
    rentcast,
    upload,
    zillow,
)
from providers.base import HEADERS, extract_state
from providers.redfin import (
    _detect_source,
    _extract_redfin,
    _search_redfin_rentals,
)
from schemas import NeighborhoodSearchRequest, SmartSearchRequest
from services import search as search_service

load_dotenv()
app = FastAPI()
BASE_DIR = Path(__file__).resolve().parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

# Single source of truth for the version shown in the UI. Last release tag was
# v1.0.0. 1.1.0 added RentCast data, upload fallbacks and rate-based carrying
# costs; 1.2.0 routes printed listing pages to the model and adds glossary
# tooltips. 2.0.0 separates taxpayer-specific income taxes from the core
# pre-tax underwriting model. 2.1.0 adds law-aware property-tax projections.
# 2.2.0 separates UI, calculation and search services and unifies listing
# hydration across both search modes.
# 2.3.0 separates Summary, What-If and Full Details and adds comprehensive
# backend, provider and browser regression coverage with CI enforcement.
# 2.3.1 keeps RentCast decisions visible throughout the wizard and adds
# explicit RentCast and free-fallback retry paths for rent estimates.
# 2.3.2 caches property AVMs, derives vacancy from their rental comparables,
# and keeps quota continuations and cache hits out of the route rate limit.
# 2.3.3 makes localhost quota-aware but non-blocking and prefers free Redfin
# rent data before buying a new RentCast result.
# 2.3.4 formats dollar inputs consistently without changing calculation values.
# 2.3.5 fills missing Redfin vacancy from cached RentCast ZIP market data.
# Bump this and the served page follows automatically.
APP_VERSION = "2.3.5"


# ---------------------------------------------------------------------------
# Rate Limiter (in-memory, per-IP)
# ---------------------------------------------------------------------------
_rate_limits: dict[str, list[float]] = defaultdict(list)

def _check_rate_limit(ip: str, limit: int, window: int = 60) -> bool:
    """Return True if the request is within rate limits."""
    now = time.time()
    timestamps = _rate_limits[ip]
    _rate_limits[ip] = [t for t in timestamps if now - t < window]
    if len(_rate_limits[ip]) >= limit:
        return False
    _rate_limits[ip].append(now)
    return True


def _is_local_request(request: Request) -> bool:
    """Local desktop use is trusted and must not throttle its own workflow."""
    host = request.client.host if request.client else ""
    return host in {"127.0.0.1", "::1", "localhost"}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

IS_CLOUD = bool(os.environ.get("RENDER") or os.environ.get("RAILWAY_ENVIRONMENT"))


@app.get("/", response_class=HTMLResponse)
async def serve_frontend():
    html = (BASE_DIR / "index.html").read_text(encoding="utf-8")
    if IS_CLOUD:
        # Inject flag so frontend can disable scraping-dependent features
        html = html.replace("</head>", '<script>window.__CLOUD_DEMO__=true;</script></head>')
    html = html.replace(
        "</head>", f'<script>window.__APP_VERSION__="{APP_VERSION}";</script></head>'
    )
    # index.html ships a literal so the version still shows when the file is
    # opened directly; rewrite it here so the served page can never disagree
    # with APP_VERSION above.
    html = re.sub(
        r'(<div class="app-version" id="appVersion">)[^<]*(</div>)',
        rf'\g<1>v{APP_VERSION}\g<2>',
        html,
    )
    return html




@app.post("/api/search")
async def search_neighborhood(
    request: Request, payload: NeighborhoodSearchRequest
):
    client_ip = request.client.host if request.client else "unknown"
    if not _is_local_request(request) and not _check_rate_limit(
        f"search:{client_ip}", 3
    ):
        return JSONResponse(
            {"error": "Too many searches. Please wait a minute before trying again."},
            status_code=429,
        )

    location = payload.location.strip()
    if not location:
        return JSONResponse({"error": "Location is required."}, status_code=400)

    filters = {
        "min_price": payload.min_price,
        "max_price": payload.max_price,
        "min_beds": payload.min_beds,
        "property_type": payload.property_type,
        "max_results": payload.max_results,
    }
    try:
        result = await search_service.neighborhood_search(
            location, filters, payload.allow_overage or _is_local_request(request)
        )
    except search_service.SearchError as exc:
        return JSONResponse({"error": exc.message}, status_code=exc.status_code)
    return JSONResponse(result)


@app.post("/api/smart-search")
async def smart_search(request: Request, payload: SmartSearchRequest):
    client_ip = request.client.host if request.client else "unknown"
    if not _is_local_request(request) and not _check_rate_limit(
        f"smart:{client_ip}", 3
    ):
        return JSONResponse(
            {"error": "Too many searches. Please wait a minute before trying again."},
            status_code=429,
        )

    location = payload.location.strip()
    if not location:
        return JSONResponse({"error": "Location is required."}, status_code=400)

    try:
        result = await search_service.smart_deals(
            location=location,
            min_beds=payload.min_beds,
            property_type=payload.property_type,
            min_price=payload.min_price,
            max_results=payload.max_results,
            allow_overage=payload.allow_overage or _is_local_request(request),
            ensure_mortgage_rate=_ensure_mortgage_rate,
        )
    except search_service.SearchError as exc:
        return JSONResponse({"error": exc.message}, status_code=exc.status_code)
    return JSONResponse(result)



# Mortgage Rate — FRED API (free, no key required for this endpoint)
# ---------------------------------------------------------------------------
_mortgage_rate_cache: dict = {"rate": None, "fetched_at": 0}



async def _ensure_mortgage_rate() -> float | None:
    """Fetch and cache mortgage rate if not already cached. Returns the rate."""
    now = time.time()
    if _mortgage_rate_cache["rate"] is not None and now - _mortgage_rate_cache["fetched_at"] < 21600:
        return _mortgage_rate_cache["rate"]
    try:
        hdrs = {k: v for k, v in HEADERS.items() if k != "Accept-Encoding"}
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("https://www.freddiemac.com/pmms", headers=hdrs)
            if resp.status_code == 200:
                match = re.search(r"(\d+\.\d+)%", resp.text)
                if match:
                    rate = float(match.group(1))
                    if 2.0 <= rate <= 15.0:
                        _mortgage_rate_cache["rate"] = rate
                        _mortgage_rate_cache["fetched_at"] = now
                        return rate
    except Exception:
        pass
    return _mortgage_rate_cache.get("rate")


@app.get("/api/mortgage-rate")
async def get_mortgage_rate():
    """Fetch current average 30-year fixed mortgage rate from FRED."""
    rate = await _ensure_mortgage_rate()
    if rate is not None:
        return JSONResponse({"rate": rate})
    return JSONResponse({"rate": None, "error": "Could not fetch current rate."})



@app.post("/api/rent-estimate")
async def estimate_rent(request: Request):
    """Estimate rent without blocking local analysis on a provider quota."""
    body = await request.json()
    location = (body.get("location") or "").strip()
    if not location:
        return JSONResponse({"error": "Location is required."}, status_code=400)
    if len(location) > 200:
        return JSONResponse({"error": "Location too long."}, status_code=400)

    beds = body.get("beds")
    address = (body.get("address") or "").strip()
    local_auto_continue = _is_local_request(request)
    allow_overage = bool(body.get("allow_overage")) or local_auto_continue
    skip_rentcast = bool(body.get("skip_rentcast"))

    # The UI's explicit quota decision is a continuation of the original
    # analysis, not a new search. Cached AVMs are local reads. Neither should
    # consume the small public burst allowance or make the app throttle its
    # own normal workflow.
    cached_avm = (
        not skip_rentcast
        and rentcast.is_configured()
        and address
        and rentcast.has_cached_rent_estimate(
            address,
            beds=beds,
            baths=body.get("baths"),
            sqft=body.get("sqft"),
            property_type=body.get("property_type"),
        )
    )
    client_ip = request.client.host if request.client else "unknown"
    if (
        not local_auto_continue
        and not (allow_overage or skip_rentcast or cached_avm)
        and not _check_rate_limit(f"rent:{client_ip}", 3)
    ):
        return JSONResponse(
            {"error": "Too many new rent searches. Please wait a minute."},
            status_code=429,
        )

    # Tier 1: an exact AVM already bought for this property is the cheapest and
    # most specific answer. Reading it does not touch RentCast or Redfin.
    if cached_avm:
        avm = await rentcast.rent_estimate(
            address,
            beds=beds,
            baths=body.get("baths"),
            sqft=body.get("sqft"),
            property_type=body.get("property_type"),
            allow_overage=allow_overage,
        )
        if avm.get("data") and avm["data"].get("rent"):
            return JSONResponse(_rentcast_avm_payload(avm))

    # Tier 2: Redfin is free. Prefer its bedroom-filtered active rental set
    # whenever it produces a usable local median.
    redfin_result = await _search_redfin_rentals(location, beds)
    redfin_stats = redfin_result.get("stats") or {}
    if redfin_stats.get("count") and redfin_stats.get("median"):
        vacancy = estimates.vacancy_from_days_on_market(
            redfin_stats.get("medianDaysOnMarket")
        )
        # Redfin rental cards often omit days on market. Keep its free rent
        # median, but fill only the missing vacancy signal from the persisted
        # ZIP market cache. Local analysis may populate that cache without
        # stopping at the soft quota; remote callers must explicitly allow it.
        if (
            vacancy.get("source") == "default"
            and not skip_rentcast
            and rentcast.is_configured()
            and allow_overage
        ):
            vacancy = await _zip_market_vacancy(
                location, address, beds, allow_overage
            )
        return JSONResponse({
            "estimate": {
                "rent": redfin_stats["median"],
                "rent_low": redfin_stats.get("low"),
                "rent_high": redfin_stats.get("high"),
                "source": "redfin",
                "label": f"Redfin active rentals in {location}",
                "sample_size": redfin_stats["count"],
            },
            "comparables": redfin_result.get("rentals") or [],
            "vacancy": vacancy,
            "free_source": True,
            "usage": rentcast.usage(),
        })

    if skip_rentcast:
        if "error" in redfin_result:
            return JSONResponse({"error": redfin_result["error"]}, status_code=404)
        return JSONResponse(redfin_result)

    # Tier 3: property-specific RentCast AVM. Localhost is explicitly allowed
    # to continue past the configured monthly reserve; remote users still see
    # the quota decision before any potentially billable request.
    if rentcast.is_configured() and address:
        avm = await rentcast.rent_estimate(
            address,
            beds=beds,
            baths=body.get("baths"),
            sqft=body.get("sqft"),
            property_type=body.get("property_type"),
            allow_overage=allow_overage,
        )
        if avm.get("gate"):
            fallback = await _zip_market_rent(
                location, address, beds, body.get("sqft")
            )
            payload = {
                "quota_gate": avm["gate"],
                "usage": rentcast.usage(),
                "vacancy": estimates.vacancy_from_days_on_market(
                    fallback.get("days_on_market") if fallback else None
                ),
            }
            if fallback:
                payload["estimate"] = fallback
            return JSONResponse(payload)
        if avm.get("data") and avm["data"].get("rent"):
            return JSONResponse(_rentcast_avm_payload(avm))

    # Tier 4: ZIP market data is the last provider fallback. It is cached, and
    # localhost can buy it without interrupting the wizard if no free data or
    # property AVM was available.
    market_estimate = None
    if rentcast.is_configured():
        market_estimate = await _zip_market_rent(
            location, address, beds, body.get("sqft"), allow_overage
        )
    if market_estimate:
        return JSONResponse({
            "estimate": market_estimate,
            "vacancy": estimates.vacancy_from_days_on_market(
                market_estimate.get("days_on_market")
            ),
            "usage": rentcast.usage(),
        })

    if "error" in redfin_result:
        return JSONResponse({"error": redfin_result["error"]}, status_code=404)
    return JSONResponse(redfin_result)


def _rentcast_avm_payload(avm: dict) -> dict:
    """Normalize a fresh or cached property AVM into the API response shape."""
    data = avm["data"]
    return {
        "estimate": {
            "rent": data["rent"],
            "rent_low": data.get("rent_low"),
            "rent_high": data.get("rent_high"),
            "source": "rentcast_avm",
            "label": "RentCast property estimate",
        },
        "comparables": data.get("comparables") or [],
        "vacancy": estimates.vacancy_from_comparables(data.get("comparables")),
        "cached": bool(avm.get("cached")),
        "usage": rentcast.usage(),
    }


async def _zip_market_rent(
    location: str, address: str, beds, sqft, allow_overage: bool = False
) -> dict | None:
    """Zip-level rent estimate scaled by size. Free after the first call per zip."""
    if not rentcast.is_configured():
        return None
    zip_code = rentcast.zip_from_address(address) or rentcast.zip_from_address(location)
    if not zip_code:
        return None
    market = await rentcast.market_data(zip_code, allow_overage)
    if not market.get("data"):
        return None
    estimate = rentcast.rent_from_market(market["data"], beds, sqft)
    if not estimate:
        return None
    estimate["label"] = f"{zip_code} market estimate"
    return estimate


async def _zip_market_vacancy(
    location: str, address: str, beds, allow_overage: bool = False
) -> dict:
    """Return ZIP-level vacancy, using RentCast's persisted market cache."""
    fallback = estimates.vacancy_from_days_on_market(None)
    if not rentcast.is_configured():
        return fallback
    zip_code = rentcast.zip_from_address(address) or rentcast.zip_from_address(location)
    if not zip_code:
        return fallback

    market = await rentcast.market_data(zip_code, allow_overage)
    market_data = market.get("data")
    if not market_data:
        return fallback

    bedroom_stats = rentcast.rent_from_market(market_data, beds, None)
    days_on_market = (
        bedroom_stats.get("days_on_market") if bedroom_stats else None
    )
    if not days_on_market:
        days_on_market = (market_data.get("rentalData") or {}).get(
            "medianDaysOnMarket"
        )

    vacancy = estimates.vacancy_from_days_on_market(days_on_market)
    if vacancy.get("source") == "market":
        vacancy["zip"] = zip_code
        vacancy["label"] = (
            f"{vacancy['label']} in {zip_code} (RentCast market data)"
        )
    return vacancy


@app.post("/api/tax-rate")
async def tax_rate(request: Request):
    """Local effective rate plus the state's rental-property growth policy."""
    body = await request.json()
    address = (body.get("address") or "").strip()
    price = body.get("price")
    allow_overage = bool(body.get("allow_overage")) or _is_local_request(request)
    # Optional: present whenever the listing gave us size and age, which is
    # most of the time since both are scraped.
    sqft = body.get("sqft")
    year_built = body.get("yearBuilt")
    monthly_rent = body.get("rent")

    zip_rate = None
    gate = None
    if rentcast.is_configured():
        zip_code = rentcast.zip_from_address(address)
        if zip_code:
            result = await rentcast.zip_tax_rate(zip_code, allow_overage)
            if result.get("gate"):
                gate = result["gate"]
            elif result.get("data"):
                zip_rate = result["data"].get("rate")

    state = extract_state(address)
    resolved = estimates.resolve_tax_rate(zip_rate, address, state=state)
    insurance = estimates.insurance_estimate(price=price, sqft=sqft, address=address)

    payload = {
        "tax": {
            **resolved,
            "annual": estimates.annual_cost(price, resolved["rate"]),
            "policy": property_tax.resolve_policy(state),
        },
        "insurance": insurance,
        "reserves": estimates.reserve_rates(
            sqft=sqft,
            year_built=year_built,
            address=address,
            monthly_rent=monthly_rent,
        ),
        "state": state,
        "usage": rentcast.usage(),
    }
    if gate:
        payload["quota_gate"] = gate
    return JSONResponse(payload)


@app.post("/api/appreciation")
async def appreciation_rate(request: Request):
    """Local property appreciation profile for an address or ZIP code.

    Pure local lookup against the precomputed FHFA tables — no RentCast call,
    no quota gate, no cost, so this never competes with the metered endpoints
    for the monthly request budget.
    """
    body = await request.json()
    address = (body.get("address") or "").strip()
    zip_code = (body.get("zip") or "").strip() or None
    try:
        hold_years = int(body.get("holdYears") or appreciation.DEFAULT_HOLD_YEARS)
    except (TypeError, ValueError):
        hold_years = appreciation.DEFAULT_HOLD_YEARS

    payload = appreciation.resolve_appreciation(
        address=address, zip_code=zip_code, hold_years=hold_years
    )
    payload["meta"] = appreciation.vintage()
    return JSONResponse(payload)


@app.post("/api/extract-upload")
async def extract_upload(request: Request, file: UploadFile = File(...)):
    """Read listing fields from an uploaded PDF or screenshot.

    Last resort when Redfin/Zillow extraction is blocked. Everything returned
    is provisional — the frontend confirms it before it reaches the form.
    """
    client_ip = request.client.host if request.client else "unknown"
    if not _check_rate_limit(f"upload:{client_ip}", 5):
        return JSONResponse(
            {"error": "Too many uploads. Please wait a minute."}, status_code=429
        )

    content_type = (file.content_type or "").split(";")[0].strip().lower()
    data = await file.read()
    if not data:
        return JSONResponse({"error": "The file is empty."}, status_code=400)

    try:
        if content_type == "application/pdf" or data.startswith(b"%PDF"):
            result = await upload.extract_pdf(data)
        elif content_type in upload.SUPPORTED_IMAGE_TYPES:
            result = await upload.extract_image(data, content_type)
        else:
            return JSONResponse(
                {
                    "error": (
                        f"Unsupported file type '{content_type or 'unknown'}'. "
                        "Upload a PDF or a PNG/JPEG/GIF/WebP image. "
                        "iPhone HEIC screenshots need converting to PNG first."
                    )
                },
                status_code=400,
            )
    except upload.UploadError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:
        # Anything unexpected still has to reach the user as a real sentence
        # rather than an empty error the frontend cannot render.
        traceback.print_exc()
        return JSONResponse(
            {"error": f"Could not process that file ({type(exc).__name__}: {exc})."},
            status_code=500,
        )

    source = result.pop("_source", "pdf")
    document = result.pop("_document", None)
    found = [k for k, v in result.items() if v not in (None, 0, [])]
    if not found:
        return JSONResponse(
            {"error": "Couldn't read any property details from that file."},
            status_code=422,
        )

    return JSONResponse({
        "data": result,
        "source": source,
        "document": document,
        "fields_found": found,
        # A printed web page parsed without a model is the least reliable
        # combination we support; say so rather than presenting it as fact.
        "low_confidence": document == "web_print" and source == "pdf",
    })


@app.get("/api/rentcast-usage")
async def rentcast_usage(request: Request):
    """Monthly request counter for the UI."""
    return JSONResponse({
        "configured": rentcast.is_configured(),
        # Screenshot reading needs a capable model, so the UI hides that
        # control when no Anthropic key is present.
        "anthropic": upload.ai_available(),
        "local_auto_continue": _is_local_request(request),
        **rentcast.usage(),
    })


@app.post("/api/scrape")
async def scrape_property(request: Request):
    # Rate limit: 5 requests per minute per IP
    client_ip = request.client.host if request.client else "unknown"
    if not _check_rate_limit(f"scrape:{client_ip}", 5):
        return JSONResponse({"error": "Too many requests. Please wait a minute before trying again."}, status_code=429)

    body = await request.json()
    url = body.get("url", "").strip()

    # --- Validate URL ---
    if not url:
        return JSONResponse({"error": "URL is required."}, status_code=400)

    if len(url) > 2000:
        return JSONResponse({"error": "URL is too long."}, status_code=400)

    parsed = urlparse(url)
    source = _detect_source(parsed.hostname)

    if source == "unknown":
        return JSONResponse(
            {"error": "Unsupported URL. Paste a Zillow or Redfin listing URL."},
            status_code=400,
        )

    # Source-specific path validation
    if source == "zillow" and not re.search(r"/homedetails/|/zpid_|/homes/", parsed.path or ""):
        return JSONResponse(
            {"error": "Please provide a direct Zillow property listing URL (e.g. zillow.com/homedetails/...)."},
            status_code=400,
        )
    if source == "redfin" and not re.search(r"/home/\d+", parsed.path or ""):
        return JSONResponse(
            {"error": "Please provide a direct Redfin property listing URL (e.g. redfin.com/.../home/12345)."},
            status_code=400,
        )

    # --- Fetch page (try httpx first, fallback to Playwright) ---
    html_text = None
    site_label = "Redfin" if source == "redfin" else "Zillow"

    # Attempt 1: httpx (fast, but both sites often serve a challenge instead)
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=20) as client:
            resp = await client.get(url, headers=HEADERS)
        if resp.status_code < 400 and page_fetch.looks_like_listing_page(resp.text):
            html_text = resp.text
    except httpx.RequestError:
        pass

    # Attempt 2: Playwright headless browser
    if html_text is None:
        try:
            candidate = await page_fetch.fetch_with_playwright(url)
            if candidate and page_fetch.looks_like_listing_page(candidate):
                html_text = candidate
        except Exception:
            pass

    if not html_text:
        return JSONResponse(
            {"error": f"Could not fetch the {site_label} page. The site may be blocking automated requests. Try again later or enter data manually."},
            status_code=503,
        )

    # --- Parse HTML ---
    try:
        soup = BeautifulSoup(html_text, "lxml")
    except Exception:
        return JSONResponse(
            {"error": "Failed to parse the page HTML. The page may be malformed."},
            status_code=422,
        )

    # Check for CAPTCHA / bot block pages
    if (soup.find("div", class_="captcha-container")
            or "captcha" in html_text[:2000].lower()
            or "access to this page has been denied" in html_text[:3000].lower()):
        return JSONResponse(
            {"error": f"{site_label} blocked the request. Please try again later or enter data manually."},
            status_code=503,
        )

    # --- Extract property data ---
    if source == "redfin":
        result = _extract_redfin(soup)
        if result:
            return JSONResponse(result)
        return JSONResponse(
            {"error": "Could not extract property data from this Redfin listing."},
            status_code=422,
        )

    # Zillow extraction strategies
    result = zillow.extract(soup)
    if result:
        return JSONResponse(result)

    return JSONResponse(
        {"error": "Could not extract property data. Zillow may have changed their page structure. Try using a Redfin URL instead, or enter data manually."},
        status_code=422,
    )


AI_SYSTEM_PROMPT = (
    "You are a real estate investment analyst. Analyze this rental "
    "property deal and provide a plain-English investment summary "
    "with: 1) Overall Assessment, 2) Key Strengths, 3) Key Risks, "
    "4) Recommendation. Treat every reported return as pre-income-tax; "
    "do not infer tax savings or after-tax results. Be concise but thorough. "
    "Jump straight to the analysis."
)


def _strip_thinking(text: str) -> str:
    """Remove thinking/reasoning blocks from LLM output."""
    # Strip <think>...</think> blocks (qwen3, deepseek-r1)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    # Strip plain-text thinking blocks that appear before the actual analysis.
    # Look for the first analysis header pattern and discard everything before it.
    header = re.search(
        r"^(#{1,3}\s+|\*\*\s*|\d+[\.\)]\s*\*\*\s*)"
        r"(Overall|Investment|Key Strength|Key Risk|Recommendation|Summary|Assessment|Analysis)",
        text, re.MULTILINE | re.IGNORECASE,
    )
    if header and header.start() > 100:
        text = text[header.start():].strip()
    return text


async def _analyze_with_ollama(metrics: str, model_override: str | None = None) -> str:
    """Call local Ollama API."""
    ollama_url = os.getenv("OLLAMA_URL", "http://localhost:11434")
    ollama_model = model_override or os.getenv("OLLAMA_MODEL", "llama3.2:3b")
    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(
            f"{ollama_url}/api/chat",
            json={
                "model": ollama_model,
                "messages": [
                    {"role": "system", "content": AI_SYSTEM_PROMPT},
                    {"role": "user", "content": metrics},
                ],
                "stream": False,
            },
        )
    if resp.status_code != 200:
        raise Exception(f"Ollama error: {resp.status_code} - {resp.text[:200]}")
    data = resp.json()
    return _strip_thinking(data["message"]["content"])


async def _analyze_with_lmstudio(metrics: str, model_override: str | None = None) -> str:
    """Call LM Studio's OpenAI-compatible API."""
    lmstudio_url = os.getenv("LMSTUDIO_URL", "http://localhost:1234")
    lmstudio_model = model_override or os.getenv("LMSTUDIO_MODEL", "")  # empty = use whatever is loaded
    async with httpx.AsyncClient(timeout=300) as client:
        payload = {
            "messages": [
                {"role": "system", "content": AI_SYSTEM_PROMPT},
                {"role": "user", "content": metrics},
            ],
            "temperature": 0.7,
            "max_tokens": 8192,
            "stream": False,
        }
        if lmstudio_model:
            payload["model"] = lmstudio_model
        resp = await client.post(
            f"{lmstudio_url}/v1/chat/completions",
            json=payload,
        )
    if resp.status_code != 200:
        raise Exception(f"LM Studio error: {resp.status_code} - {resp.text[:200]}")
    data = resp.json()
    return _strip_thinking(data["choices"][0]["message"]["content"])


async def _analyze_with_anthropic(metrics: str, api_key: str, model_override: str | None = None) -> str:
    """Call Anthropic Claude API."""
    anthropic_model = model_override or DEFAULT_ANTHROPIC_MODEL
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json={
                "model": anthropic_model,
                "max_tokens": 1024,
                "system": AI_SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": metrics}],
            },
        )
    if resp.status_code != 200:
        raise Exception(f"Anthropic API error (HTTP {resp.status_code}): {resp.text[:200]}")
    data = resp.json()
    return data["content"][0]["text"]


def _resolve_provider():
    """Return (provider, api_key) based on env configuration."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    provider = os.getenv("AI_PROVIDER", "auto").lower()
    return provider, api_key


@app.post("/api/analyze-ai")
async def analyze_ai(request: Request):
    # Rate limit: 10 requests per minute per IP
    client_ip = request.client.host if request.client else "unknown"
    if not _check_rate_limit(f"ai:{client_ip}", 10):
        return JSONResponse({"error": "Too many requests. Please wait before trying again."}, status_code=429)

    body = await request.json()
    metrics = body.get("metrics", "")
    model = body.get("model")  # optional model override
    if not metrics:
        return JSONResponse(
            {"error": "Missing 'metrics' in request body."},
            status_code=400,
        )
    if len(metrics) > 50_000:
        return JSONResponse(
            {"error": "Input too large."},
            status_code=400,
        )

    # Determine AI provider
    provider, api_key = _resolve_provider()

    # LM Studio provider
    if provider == "lmstudio":
        try:
            text = await _analyze_with_lmstudio(metrics, model_override=model)
            return JSONResponse({"analysis": text, "provider": "lmstudio"})
        except Exception as exc:
            return JSONResponse(
                {"error": f"LM Studio is not running. Start LM Studio and load a model, then enable the local server.\n\nError: {exc}"},
                status_code=502,
            )

    # Auto mode: try lmstudio first, then ollama, then anthropic
    if provider == "auto":
        # Try LM Studio
        lmstudio_url = os.getenv("LMSTUDIO_URL", "http://localhost:1234")
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                probe = await client.get(f"{lmstudio_url}/v1/models")
            if probe.status_code == 200:
                try:
                    text = await _analyze_with_lmstudio(metrics, model_override=model)
                    return JSONResponse({"analysis": text, "provider": "lmstudio"})
                except Exception:
                    pass
        except Exception:
            pass

    # Ollama provider (explicit or auto-detected)
    if provider == "ollama" or (provider == "auto" and not api_key):
        try:
            text = await _analyze_with_ollama(metrics, model_override=model)
            return JSONResponse({"analysis": text, "provider": "ollama"})
        except Exception as exc:
            if api_key:
                pass  # fall through to Anthropic
            else:
                return JSONResponse(
                    {"error": f"Ollama is not running or model not available. Start Ollama with: ollama serve\nThen pull a model: ollama pull {os.getenv('OLLAMA_MODEL', 'llama3.2:3b')}\n\nError: {exc}"},
                    status_code=502,
                )

    if not api_key:
        return JSONResponse(
            {"error": f"No AI provider configured. Either:\n1) Set ANTHROPIC_API_KEY in .env (paid)\n2) Run LM Studio locally (free): set AI_PROVIDER=lmstudio\n3) Run Ollama locally (free): ollama serve && ollama pull {os.getenv('OLLAMA_MODEL', 'llama3.2:3b')}"},
            status_code=400,
        )

    try:
        text = await _analyze_with_anthropic(metrics, api_key, model_override=model)
        return JSONResponse({"analysis": text, "provider": "anthropic"})
    except (httpx.RequestError, httpx.TimeoutException):
        return JSONResponse(
            {"error": "Could not reach AI service. Check your connection and try again."},
            status_code=502,
        )
    except Exception as exc:
        return JSONResponse(
            {"error": str(exc)},
            status_code=502,
        )


# ---------------------------------------------------------------------------
# GET /api/models — list available models from the configured AI provider
# ---------------------------------------------------------------------------

ANTHROPIC_MODELS = [
    {"id": "claude-opus-5", "name": "Claude Opus 5"},
    {"id": "claude-sonnet-5", "name": "Claude Sonnet 5"},
    {"id": "claude-haiku-4-5", "name": "Claude Haiku 4.5"},
]
DEFAULT_ANTHROPIC_MODEL = "claude-opus-5"


async def _get_lmstudio_models() -> dict | None:
    """Fetch models from LM Studio. Returns dict or None on failure."""
    lmstudio_url = os.getenv("LMSTUDIO_URL", "http://localhost:1234")
    current = os.getenv("LMSTUDIO_MODEL", "")
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{lmstudio_url}/v1/models")
        if resp.status_code != 200:
            return None
        data = resp.json()
        models = []
        for m in data.get("data", []):
            mid = m.get("id", "")
            # Filter out embedding models
            if "embed" in mid.lower():
                continue
            models.append({"id": mid, "name": mid})
        if not current and models:
            current = models[0]["id"]
        return {"provider": "lmstudio", "models": models, "current": current}
    except Exception:
        return None


async def _get_ollama_models() -> dict | None:
    """Fetch models from Ollama. Returns dict or None on failure."""
    ollama_url = os.getenv("OLLAMA_URL", "http://localhost:11434")
    current = os.getenv("OLLAMA_MODEL", "llama3.2:3b")
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{ollama_url}/api/tags")
        if resp.status_code != 200:
            return None
        data = resp.json()
        models = []
        for m in data.get("models", []):
            mid = m.get("name", "") or m.get("model", "")
            models.append({"id": mid, "name": mid})
        return {"provider": "ollama", "models": models, "current": current}
    except Exception:
        return None


def _get_anthropic_models() -> dict | None:
    """Return hardcoded Anthropic models if API key is set."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return None
    return {
        "provider": "anthropic",
        "models": ANTHROPIC_MODELS,
        "current": DEFAULT_ANTHROPIC_MODEL,
    }


@app.get("/api/models")
async def list_models():
    provider, api_key = _resolve_provider()

    if provider == "lmstudio":
        result = await _get_lmstudio_models()
        if result:
            return JSONResponse(result)
        return JSONResponse({"error": "LM Studio is not reachable."}, status_code=502)

    if provider == "ollama":
        result = await _get_ollama_models()
        if result:
            return JSONResponse(result)
        return JSONResponse({"error": "Ollama is not reachable."}, status_code=502)

    if provider == "anthropic":
        result = _get_anthropic_models()
        if result:
            return JSONResponse(result)
        return JSONResponse({"error": "ANTHROPIC_API_KEY is not set."}, status_code=400)

    # auto: try lmstudio -> ollama -> anthropic
    result = await _get_lmstudio_models()
    if result:
        return JSONResponse(result)

    result = await _get_ollama_models()
    if result:
        return JSONResponse(result)

    result = _get_anthropic_models()
    if result:
        return JSONResponse(result)

    return JSONResponse(
        {"error": "No AI provider available."},
        status_code=502,
    )


# ---------------------------------------------------------------------------
# POST /api/analyze-ai-stream — SSE streaming version of analyze-ai
# ---------------------------------------------------------------------------

async def _stream_lmstudio(metrics: str, model_override: str | None = None):
    """Stream from LM Studio's OpenAI-compatible API."""
    lmstudio_url = os.getenv("LMSTUDIO_URL", "http://localhost:1234")
    lmstudio_model = model_override or os.getenv("LMSTUDIO_MODEL", "")

    payload = {
        "messages": [
            {"role": "system", "content": AI_SYSTEM_PROMPT},
            {"role": "user", "content": metrics},
        ],
        "temperature": 0.7,
        "max_tokens": 8192,
        "stream": True,
    }
    if lmstudio_model:
        payload["model"] = lmstudio_model

    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream(
            "POST", f"{lmstudio_url}/v1/chat/completions", json=payload
        ) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                yield f"data: {json.dumps({'error': f'LM Studio error: {resp.status_code} - {body[:200].decode()}'})}\n\n"
                return
            buffer = ""
            in_think = False
            found_header = False
            pending = ""
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue
                delta = chunk.get("choices", [{}])[0].get("delta", {})
                token = delta.get("content", "")
                if not token:
                    continue

                # Strip thinking: handle <think> tags
                processed = _process_stream_token(token, buffer, in_think, found_header, pending)
                buffer = processed["buffer"]
                in_think = processed["in_think"]
                found_header = processed["found_header"]
                pending = processed["pending"]
                if processed["output"]:
                    yield f"data: {json.dumps({'token': processed['output'], 'done': False})}\n\n"
    yield f"data: {json.dumps({'token': '', 'done': True})}\n\n"


async def _stream_ollama(metrics: str, model_override: str | None = None):
    """Stream from Ollama API."""
    ollama_url = os.getenv("OLLAMA_URL", "http://localhost:11434")
    ollama_model = model_override or os.getenv("OLLAMA_MODEL", "llama3.2:3b")

    payload = {
        "model": ollama_model,
        "messages": [
            {"role": "system", "content": AI_SYSTEM_PROMPT},
            {"role": "user", "content": metrics},
        ],
        "stream": True,
    }

    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream(
            "POST", f"{ollama_url}/api/chat", json=payload
        ) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                yield f"data: {json.dumps({'error': f'Ollama error: {resp.status_code} - {body[:200].decode()}'})}\n\n"
                return
            buffer = ""
            in_think = False
            found_header = False
            pending = ""
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue
                token = chunk.get("message", {}).get("content", "")
                if not token:
                    if chunk.get("done"):
                        break
                    continue

                processed = _process_stream_token(token, buffer, in_think, found_header, pending)
                buffer = processed["buffer"]
                in_think = processed["in_think"]
                found_header = processed["found_header"]
                pending = processed["pending"]
                if processed["output"]:
                    yield f"data: {json.dumps({'token': processed['output'], 'done': False})}\n\n"
    yield f"data: {json.dumps({'token': '', 'done': True})}\n\n"


async def _stream_anthropic(metrics: str, api_key: str, model_override: str | None = None):
    """Stream from Anthropic API."""
    anthropic_model = model_override or DEFAULT_ANTHROPIC_MODEL
    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream(
            "POST",
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json={
                "model": anthropic_model,
                "max_tokens": 1024,
                "system": AI_SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": metrics}],
                "stream": True,
            },
        ) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                yield f"data: {json.dumps({'error': f'Anthropic error: {resp.status_code} - {body[:200].decode()}'})}\n\n"
                return
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:].strip()
                if not data_str:
                    continue
                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue
                event_type = chunk.get("type", "")
                if event_type == "content_block_delta":
                    delta = chunk.get("delta", {})
                    token = delta.get("text", "")
                    if token:
                        yield f"data: {json.dumps({'token': token, 'done': False})}\n\n"
                elif event_type == "message_stop":
                    break
    yield f"data: {json.dumps({'token': '', 'done': True})}\n\n"


def _process_stream_token(
    token: str, buffer: str, in_think: bool, found_header: bool, pending: str
) -> dict:
    """Process a streaming token, stripping thinking blocks.

    Returns dict with keys: output, buffer, in_think, found_header, pending.
    """
    output = ""
    full = buffer + token

    # Handle <think> tags
    while True:
        if in_think:
            end_idx = full.find("</think>")
            if end_idx == -1:
                # Still inside think block, consume everything
                return {"output": output, "buffer": "", "in_think": True, "found_header": found_header, "pending": pending}
            else:
                full = full[end_idx + 8:]
                in_think = False
        else:
            start_idx = full.find("<think>")
            if start_idx != -1:
                # Text before <think> is real content
                before = full[:start_idx]
                if before:
                    pending += before
                full = full[start_idx + 7:]
                in_think = True
            else:
                break

    pending += full

    # If we haven't found the analysis header yet, check if the pending text
    # has enough content to determine it starts with "Thinking Process" or similar.
    if not found_header:
        # Check if the pending text contains an analysis header
        header = re.search(
            r"^(#{1,3}\s+|\*\*\s*|\d+[\.\)]\s*\*\*\s*)"
            r"(Overall|Investment|Key Strength|Key Risk|Recommendation|Summary|Assessment|Analysis)",
            pending, re.MULTILINE | re.IGNORECASE,
        )
        if header and header.start() > 100:
            # There's a thinking preamble — skip it
            pending = pending[header.start():]
            found_header = True
            output += pending
            pending = ""
        elif header:
            # Header found near the start — this is real content
            found_header = True
            output += pending
            pending = ""
        elif len(pending) > 300:
            # We've buffered enough without finding a thinking preamble, just emit
            found_header = True
            output += pending
            pending = ""
        # else: keep buffering
    else:
        output += pending
        pending = ""

    return {"output": output, "buffer": "", "in_think": in_think, "found_header": found_header, "pending": pending}


@app.post("/api/analyze-ai-stream")
async def analyze_ai_stream(request: Request):
    # Rate limit: 10 requests per minute per IP
    client_ip = request.client.host if request.client else "unknown"
    if not _check_rate_limit(f"ai-stream:{client_ip}", 10):
        return JSONResponse({"error": "Too many requests. Please wait before trying again."}, status_code=429)

    body = await request.json()
    metrics = body.get("metrics", "")
    model = body.get("model")  # optional model override
    if not metrics:
        return JSONResponse(
            {"error": "Missing 'metrics' in request body."},
            status_code=400,
        )
    if len(metrics) > 50_000:
        return JSONResponse(
            {"error": "Input too large."},
            status_code=400,
        )

    provider, api_key = _resolve_provider()

    async def _pick_generator():
        # LM Studio explicit
        if provider == "lmstudio":
            return _stream_lmstudio(metrics, model_override=model)

        # Auto: try lmstudio first
        if provider == "auto":
            lmstudio_url = os.getenv("LMSTUDIO_URL", "http://localhost:1234")
            try:
                async with httpx.AsyncClient(timeout=3) as client:
                    probe = await client.get(f"{lmstudio_url}/v1/models")
                if probe.status_code == 200:
                    return _stream_lmstudio(metrics, model_override=model)
            except Exception:
                pass

        # Ollama explicit or auto fallback
        if provider == "ollama" or (provider == "auto" and not api_key):
            return _stream_ollama(metrics, model_override=model)

        # Anthropic
        if api_key:
            return _stream_anthropic(metrics, api_key, model_override=model)

        return None

    gen = await _pick_generator()
    if gen is None:
        return JSONResponse(
            {"error": f"No AI provider available. Configure one in .env."},
            status_code=400,
        )

    async def _with_timeout(generator, timeout_seconds=300):
        """Wrap a streaming generator with a timeout."""
        try:
            async for chunk in generator:
                yield chunk
        except asyncio.CancelledError:
            yield f"data: {json.dumps({'error': 'Stream timed out.'})}\n\n"

    return StreamingResponse(
        _with_timeout(gen),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def open_browser():
    webbrowser.open("http://localhost:8000")


if __name__ == "__main__":
    threading.Timer(1.5, open_browser).start()
    uvicorn.run(app, host="127.0.0.1", port=8000)
