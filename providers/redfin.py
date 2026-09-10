"""Redfin scraping: single-listing extraction, neighborhood search, rent comps.

Moved out of app.py so endpoints don't have to know Redfin's URL formats.
"""

import asyncio
import json
import re

from .base import HEADERS

def _detect_source(hostname: str) -> str:
    """Detect data source from URL hostname."""
    if hostname and hostname.endswith("redfin.com"):
        return "redfin"
    if hostname and hostname.endswith("zillow.com"):
        return "zillow"
    return "unknown"


def _extract_redfin(soup) -> dict | None:
    """Extract property data from a Redfin listing page."""
    result = {
        "address": None, "price": None, "beds": None, "baths": None,
        "sqft": None, "lotSize": None, "yearBuilt": None, "propertyType": None,
        "zestimate": None, "rentZestimate": None, "taxHistory": [],
        "annualTax": None, "hoaFee": 0, "description": None, "imageUrl": None,
    }

    # Helper to extract address from a schema.org object
    def _extract_address(obj: dict) -> str | None:
        addr_obj = obj.get("address", {})
        if isinstance(addr_obj, dict):
            parts = [addr_obj.get("streetAddress", ""),
                     addr_obj.get("addressLocality", "")]
            state = addr_obj.get("addressRegion", "")
            zipcode = addr_obj.get("postalCode", "")
            addr = ", ".join(p for p in parts if p)
            if state:
                addr += f", {state} {zipcode}".rstrip()
            return addr if addr else None
        elif isinstance(addr_obj, str):
            return addr_obj
        return None

    # Helper to check if @type matches any known residential/listing type
    def _type_matches(item_type, targets) -> bool:
        if isinstance(item_type, list):
            return any(t in targets for t in item_type)
        return item_type in targets

    LISTING_TYPES = {"SingleFamilyResidence", "Residence", "Product",
                     "House", "Apartment", "RealEstateListing"}
    RESIDENTIAL_TYPES = {"SingleFamilyResidence", "Residence", "House",
                         "Apartment", "Condominium", "TownHouse"}

    # 1) ld+json (Redfin usually has good structured data)
    ld_scripts = soup.find_all("script", type="application/ld+json")
    for tag in ld_scripts:
        if not tag.string:
            continue
        try:
            data = json.loads(tag.string)
        except (json.JSONDecodeError, TypeError):
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if not isinstance(item, dict):
                continue
            item_type = item.get("@type", "")
            if not _type_matches(item_type, LISTING_TYPES):
                continue

            # Extract top-level data (address, image, description, price)
            if not result["address"]:
                result["address"] = _extract_address(item)
            result["description"] = result["description"] or item.get("description")
            img = item.get("image") or item.get("photo")
            if isinstance(img, list) and img:
                img = img[0]
            if isinstance(img, dict):
                img = img.get("contentUrl") or img.get("url")
            if not result["imageUrl"] and isinstance(img, str):
                result["imageUrl"] = img

            # Price from offers or top-level
            offers = item.get("offers", {})
            if isinstance(offers, dict) and not result["price"]:
                result["price"] = offers.get("price")
            if not result["price"]:
                result["price"] = item.get("price")

            # Direct property fields (if at top level)
            result["beds"] = result["beds"] or item.get("numberOfRooms") or item.get("numberOfBedrooms")
            result["baths"] = result["baths"] or item.get("numberOfBathroomsTotal") or item.get("numberOfFullBathrooms")
            result["yearBuilt"] = result["yearBuilt"] or item.get("yearBuilt")
            floor_size = item.get("floorSize", {})
            if not result["sqft"]:
                if isinstance(floor_size, dict):
                    result["sqft"] = floor_size.get("value")
                elif isinstance(floor_size, (int, float)):
                    result["sqft"] = int(floor_size)

            # Traverse mainEntity for nested residential data (Redfin pattern)
            main_entity = item.get("mainEntity", {})
            if isinstance(main_entity, dict):
                me_type = main_entity.get("@type", "")
                if _type_matches(me_type, RESIDENTIAL_TYPES) or main_entity.get("numberOfBedrooms"):
                    if not result["address"]:
                        result["address"] = _extract_address(main_entity)
                    result["beds"] = result["beds"] or main_entity.get("numberOfBedrooms") or main_entity.get("numberOfRooms")
                    result["baths"] = result["baths"] or main_entity.get("numberOfBathroomsTotal") or main_entity.get("numberOfFullBathrooms")
                    result["yearBuilt"] = result["yearBuilt"] or main_entity.get("yearBuilt")
                    me_floor = main_entity.get("floorSize", {})
                    if not result["sqft"]:
                        if isinstance(me_floor, dict):
                            result["sqft"] = me_floor.get("value")
                        elif isinstance(me_floor, (int, float)):
                            result["sqft"] = int(me_floor)

    # 2) Fallback: parse from meta tags
    if not result["address"]:
        og_title = soup.find("meta", property="og:title")
        if og_title and og_title.get("content"):
            result["address"] = og_title["content"].split("|")[0].strip()

    if not result["imageUrl"]:
        og_img = soup.find("meta", property="og:image")
        if og_img and og_img.get("content"):
            result["imageUrl"] = og_img["content"]

    # 3) Fallback: regex scan for Redfin's JS data
    for script in soup.find_all("script"):
        text = script.string or ""
        if len(text) < 50:
            continue

        if not result["price"]:
            m = re.search(r'"price(?:Info)?"\s*:\s*\{[^}]*"amount"\s*:\s*(\d+)', text)
            if not m:
                m = re.search(r'"listingPrice"\s*:\s*(\d+)', text)
            if m:
                try:
                    result["price"] = int(m.group(1))
                except ValueError:
                    pass

        if not result["beds"]:
            m = re.search(r'"beds"\s*:\s*(\d+)', text)
            if m:
                result["beds"] = int(m.group(1))

        if not result["baths"]:
            m = re.search(r'"baths"\s*:\s*([\d.]+)', text)
            if m:
                result["baths"] = float(m.group(1))

        if not result["sqft"]:
            m = re.search(r'"sqFt"\s*:\s*\{[^}]*"value"\s*:\s*(\d+)', text)
            if not m:
                m = re.search(r'"sqftInfo"\s*:\s*\{[^}]*"amount"\s*:\s*(\d+)', text)
            if m:
                result["sqft"] = int(m.group(1))

        if not result["yearBuilt"]:
            m = re.search(r'"yearBuilt"\s*:\s*\{[^}]*"value"\s*:\s*(\d{4})', text)
            if m:
                result["yearBuilt"] = int(m.group(1))

        if not result["annualTax"]:
            m = re.search(r'"taxInfo"\s*:\s*\{[^}]*"amount"\s*:\s*(\d+)', text)
            if m:
                result["annualTax"] = int(m.group(1))

        if result["hoaFee"] == 0:
            m = re.search(r'"hoaDues"\s*:\s*\{[^}]*"amount"\s*:\s*(\d+)', text)
            if m:
                result["hoaFee"] = int(m.group(1))

    # Price might come as string "$350,000" — normalize
    if isinstance(result["price"], str):
        try:
            result["price"] = int(re.sub(r"[^\d]", "", result["price"]))
        except ValueError:
            result["price"] = None

    if result["address"] or result["price"]:
        return result
    return None

# ---------------------------------------------------------------------------
# Neighborhood Search — Redfin search page scraping
# ---------------------------------------------------------------------------

# Global semaphore: max 3 concurrent Playwright browsers for search
_search_semaphore = asyncio.Semaphore(3)

_REDFIN_SEARCH_JS = """
() => {
    const cards = document.querySelectorAll('.MapHomeCardReact, [class*="HomeCard"]');
    const results = [];
    const seen = new Set();

    // Helper: extract beds/baths/sqft from a text string
    function parseStats(t) {
        const b = t.match(/(\\d+)\\s*(?:beds?|bd|BR)\\b/i);
        const bt = t.match(/(\\d+\\.?\\d*)\\s*(?:baths?|ba)\\b/i);
        // Negative lookahead skips lot size ("6,499 sq ft lot") — land cards
        // would otherwise report their parcel size as living area.
        const s = t.match(/(\\d[\\d,]*)\\s*(?:sq|SF)\\b(?![^]{0,8}lot)/i);
        return {
            beds: b ? parseInt(b[1]) : null,
            baths: bt ? parseFloat(bt[1]) : null,
            sqft: s ? parseInt(s[1].replace(/,/g, '')) : null
        };
    }

    cards.forEach(card => {
        const linkEl = card.querySelector('a[href*="/home/"]');
        const url = linkEl ? linkEl.href : null;
        if (!url || seen.has(url)) return;
        seen.add(url);

        // --- Price ---
        const priceDiv = card.querySelector('.bp-Homecard__Price, [class*="Price"]');
        let price = null;
        if (priceDiv) {
            const m = priceDiv.textContent.match(/\\$(\\d[\\d,]*)/);
            if (m) price = parseInt(m[1].replace(/,/g, ''));
        }

        // --- Address ---
        const addrEl = card.querySelector('.bp-Homecard__Address, [class*="homeAddressV2"], [class*="address"]');

        // --- Beds / Baths / Sqft ---
        let beds = null, baths = null, sqft = null;

        // Method 1: Dedicated stats element
        const statsEls = card.querySelectorAll('.bp-Homecard__Stats, [class*="HomeStats"], [class*="homeStat"], [class*="home-stat"], [class*="KeyStats"], [class*="keyStats"]');
        for (const el of statsEls) {
            const p = parseStats(el.textContent);
            if (p.beds !== null) beds = p.beds;
            if (p.baths !== null) baths = p.baths;
            if (p.sqft !== null) sqft = p.sqft;
            if (beds !== null) break;
        }

        // Method 2: Look for individual stat spans/divs inside the card
        if (beds === null) {
            const spans = card.querySelectorAll('span, div');
            for (const sp of spans) {
                const txt = sp.textContent.trim();
                // Match standalone "3 Beds" or "2 Baths" text nodes (short, focused)
                if (txt.length < 15) {
                    if (beds === null) {
                        const bm = txt.match(/^(\\d+)\\s*(?:beds?|bd|BR)$/i);
                        if (bm) beds = parseInt(bm[1]);
                    }
                    if (baths === null) {
                        const btm = txt.match(/^(\\d+\\.?\\d*)\\s*(?:baths?|ba)$/i);
                        if (btm) baths = parseFloat(btm[1]);
                    }
                    if (sqft === null) {
                        const sm = txt.match(/^(\\d[\\d,]*)\\s*(?:sq|SF)(?![^]{0,8}lot)/i);
                        if (sm) sqft = parseInt(sm[1].replace(/,/g, ''));
                    }
                }
            }
        }

        // Method 3: Card aria-label or title attribute (Redfin sometimes puts stats here)
        if (beds === null) {
            const ariaEl = card.querySelector('[aria-label]');
            if (ariaEl) {
                const p = parseStats(ariaEl.getAttribute('aria-label'));
                if (p.beds !== null && p.beds <= 20) beds = p.beds;
                if (p.baths !== null && baths === null) baths = p.baths;
                if (p.sqft !== null && sqft === null) sqft = p.sqft;
            }
        }

        // Method 4: Full card text fallback (with sanity checks)
        if (beds === null) {
            const fullText = card.textContent;
            const p = parseStats(fullText);
            if (p.beds !== null && p.beds <= 20) beds = p.beds;
            if (p.baths !== null && p.baths <= 20 && baths === null) baths = p.baths;
            if (p.sqft !== null && sqft === null) sqft = p.sqft;
        }

        // --- Image ---
        const imgEl = card.querySelector('img[src*="cdn-redfin"], img[src*="photos"], img[src*="ssl.cdn"], img[src*="rdcpix"]');

        results.push({
            address: addrEl ? addrEl.textContent.trim() : null,
            price: price,
            beds: beds,
            baths: baths,
            sqft: sqft,
            listingUrl: url,
            imageUrl: imgEl ? imgEl.src : null
        });
    });
    return results;
}
"""


def _build_redfin_filter_path(filters: dict) -> str:
    """Build Redfin filter path segments from filters dict."""
    filter_parts = []
    if filters.get("min_price"):
        filter_parts.append(f"min-price={int(filters['min_price'])}")
    if filters.get("max_price"):
        filter_parts.append(f"max-price={int(filters['max_price'])}")
    if filters.get("min_beds") and filters["min_beds"] > 0:
        filter_parts.append(f"min-beds={int(filters['min_beds'])}")
    ptype_map = {"house": "house", "condo": "condo,townhouse", "multi-family": "multifamily"}
    if filters.get("property_type") and filters["property_type"] in ptype_map:
        filter_parts.append(f"property-type={ptype_map[filters['property_type']]}")
    if filters.get("sort") == "price-asc":
        filter_parts.append("sort=lo-price")
    if filter_parts:
        return "/filter/" + ",".join(filter_parts)
    return ""


def _apply_filters_to_redfin_url(resolved_url: str, filters: dict) -> str:
    """Replace a resolved Redfin URL's filter segment with our own filters.

    Redfin's search bar always redirects to a URL that already carries a
    ``/filter/`` segment holding map state (sort, viewport, geo-address), so
    filters can't simply be appended. Those tokens are only map-view state —
    dropping them scopes results to the whole city, which is what the user
    asked for.
    """
    filter_path = _build_redfin_filter_path(filters)
    if not filter_path:
        return resolved_url
    base = resolved_url.split("?")[0].split("#")[0].rstrip("/")
    base = re.sub(r"(/filter/.*)?$", "", base)
    return base + filter_path


def _build_redfin_search_url(location: str, filters: dict) -> str:
    """Build a Redfin search URL from location and filters.

    For zip codes, we can construct the URL directly.
    For city names, returns None — caller must use Playwright search bar.
    """
    query = location.strip()

    # Detect zip code (direct URL) vs city name (needs search)
    if re.match(r"^\d{5}$", query):
        base = f"https://www.redfin.com/zipcode/{query}"
        return base + _build_redfin_filter_path(filters)

    # City names can't be constructed as URLs (Redfin uses numeric city IDs)
    return None


async def _search_redfin_page(location: str, filters: dict) -> dict:
    """Search Redfin by loading the search results page with Playwright.

    Scrolls down multiple times to load more listings via lazy-loading.
    """
    from playwright.async_api import async_playwright

    direct_url = _build_redfin_search_url(location, filters)
    max_results = filters.get("max_results", 40)

    async with _search_semaphore, async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = await browser.new_context(
            user_agent=HEADERS["User-Agent"],
            viewport={"width": 1280, "height": 900},
            locale="en-US",
            timezone_id="America/New_York",
        )
        page = await context.new_page()
        await page.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
        )

        if direct_url:
            # Zip code — navigate directly
            try:
                await page.goto(direct_url, wait_until="domcontentloaded", timeout=30000)
            except Exception:
                await browser.close()
                return {"error": "Could not connect to Redfin. Please try again later."}
        else:
            # City name — use Redfin search bar to resolve
            try:
                await page.goto("https://www.redfin.com", wait_until="domcontentloaded", timeout=20000)
                # Type in search box and pick first suggestion
                search_input = page.locator("input[type='text'][placeholder*='Search'], input[type='search'], #search-box-input, [data-testid='search-box-input']").first
                await search_input.fill(location.strip())
                await page.wait_for_timeout(1500)
                # Press Enter to search (autocomplete should resolve)
                await search_input.press("Enter")
                await page.wait_for_timeout(3000)
            except Exception:
                await browser.close()
                return {"error": "Could not connect to Redfin. Please try again later."}

            # Redfin's search bar resolves to a URL that already has a
            # /filter/ segment (map state), so swap in our filters rather
            # than appending. If this navigation fails, keep the unfiltered
            # page we already have — the price sanity filter below still
            # keeps the results honest.
            filtered_url = _apply_filters_to_redfin_url(page.url, filters)
            if filtered_url != page.url:
                try:
                    await page.goto(filtered_url, wait_until="domcontentloaded", timeout=20000)
                except Exception:
                    pass

        # Check for redirect to main page (bad location)
        final_url = page.url
        if "/zipcode/" not in final_url and "/city/" not in final_url and "/neighborhood/" not in final_url and "/filter/" not in final_url and "/county/" not in final_url and "/state/" not in final_url:
            await browser.close()
            return {"error": f'Could not find location "{location}". Try a zip code (e.g. "78701") or city + state (e.g. "Austin, TX").'}

        # Wait for listing cards to render
        try:
            await page.wait_for_selector(".MapHomeCardReact, [class*='HomeCard']", timeout=8000)
        except Exception:
            # No listings found or page didn't load cards
            html_text = await page.content()
            await browser.close()
            if "No results found" in html_text or "0 homes" in html_text:
                return {"listings": [], "total": 0}
            return {"error": "No listings found. Try adjusting your filters or searching a different area."}

        await page.wait_for_timeout(2000)

        # Scroll down to load more lazy-loaded listings
        # More scrolls = more listings. Stop early if no new content loaded.
        prev_count = 0
        for _ in range(8):
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await page.wait_for_timeout(1000)
            cur_count = await page.evaluate(
                "document.querySelectorAll('.MapHomeCardReact, [class*=\"HomeCard\"]').length"
            )
            if cur_count == prev_count and cur_count >= 10:
                break  # no new listings loaded
            prev_count = cur_count

        # Extract total count from page (e.g., "47 homes" in the results header)
        page_total = await page.evaluate("""
            () => {
                const el = document.querySelector('[class*="homes"], [class*="result"]');
                if (el) {
                    const m = el.textContent.match(/(\\d+)\\s*home/i);
                    if (m) return parseInt(m[1]);
                }
                return null;
            }
        """)

        # Extract location label from page title
        title = await page.title()
        label = location
        if title:
            # "78701, TX Real Estate & Homes for Sale | Redfin"
            # "Memphis, TN Homes for Sale & Real Estate | Redfin"
            label = re.sub(r"\s*\|.*$", "", title)
            label = re.sub(r"\s*(Real Estate|Homes for Sale|Houses for Sale|&).*$", "", label).strip()
            if not label:
                label = location

        listings = await page.evaluate(_REDFIN_SEARCH_JS)
        await browser.close()

    # Filter out listings without price, enforce the price bounds ourselves
    # (safety net if Redfin's URL filter format changes), and cap results.
    # Beds/sqft are intentionally not filtered here — the scraper often
    # returns None for them, which would discard valid rows.
    min_price = filters.get("min_price")
    max_price = filters.get("max_price")
    listings = [
        l
        for l in listings
        if l.get("price")
        and (not min_price or l["price"] >= min_price)
        and (not max_price or l["price"] <= max_price)
    ][:max_results]

    return {
        "listings": listings,
        "total": page_total or len(listings),
        "location_label": label,
    }

# ---------------------------------------------------------------------------
# Rent Estimation — Redfin rental listings search
# ---------------------------------------------------------------------------
_REDFIN_RENT_JS = """
() => {
    const cards = document.querySelectorAll('.MapHomeCardReact, [class*="HomeCard"]');
    const results = [];
    const seen = new Set();
    const addResult = item => {
        const key = item.address || [item.rent, item.beds, item.baths, item.sqft].join('|');
        if (seen.has(key)) return;
        seen.add(key);
        results.push(item);
    };
    cards.forEach(card => {
        const priceDiv = card.querySelector('.bp-Homecard__Price, [class*="Price"]');
        if (!priceDiv) return;
        const priceText = priceDiv.textContent;
        // Only include rental listings (contain /mo or /month)
        if (!/\\/mo/i.test(priceText) && !/rent/i.test(priceText)) {
            // Also check if it looks like a rent price (< $10k/mo typically)
            const m = priceText.match(/\\$(\\d[\\d,]*)/);
            if (m) {
                const p = parseInt(m[1].replace(/,/g, ''));
                if (p > 15000) return; // likely a sale price, skip
            }
        }
        const m = priceText.match(/\\$(\\d[\\d,]*)/);
        if (!m) return;
        const rent = parseInt(m[1].replace(/,/g, ''));
        if (rent <= 0 || rent > 50000) return;

        let beds = null, baths = null, sqft = null, daysOnMarket = null;
        const cardText = card.textContent || '';
        const domM = cardText.match(/(\\d+)\\s+days?\\s+(?:on\\s+Redfin|listed|on\\s+(?:the\\s+)?market)/i);
        if (domM) daysOnMarket = parseInt(domM[1]);
        // Try multiple stat selectors
        const statsEls = card.querySelectorAll('.bp-Homecard__Stats, [class*="HomeStats"], [class*="homeStat"], [class*="KeyStats"]');
        for (const el of statsEls) {
            const t = el.textContent;
            const bM = t.match(/(\\d+)\\s*(?:beds?|bd|BR)\\b/i);
            const btM = t.match(/(\\d+\\.?\\d*)\\s*(?:baths?|ba)\\b/i);
            const sM = t.match(/(\\d[\\d,]*)\\s*(?:sq|SF)\\b/i);
            if (bM) beds = parseInt(bM[1]);
            if (btM) baths = parseFloat(btM[1]);
            if (sM) sqft = parseInt(sM[1].replace(/,/g, ''));
            if (beds !== null) break;
        }
        // Fallback: individual short spans
        if (beds === null) {
            const spans = card.querySelectorAll('span, div');
            for (const sp of spans) {
                const txt = sp.textContent.trim();
                if (txt.length < 15) {
                    if (beds === null) { const bm = txt.match(/^(\\d+)\\s*(?:beds?|bd|BR)$/i); if (bm) beds = parseInt(bm[1]); }
                    if (baths === null) { const btm = txt.match(/^(\\d+\\.?\\d*)\\s*(?:baths?|ba)$/i); if (btm) baths = parseFloat(btm[1]); }
                }
            }
        }
        const addrEl = card.querySelector('.bp-Homecard__Address, [class*="homeAddressV2"]');
        const addr = addrEl ? addrEl.textContent.trim() : null;
        addResult({ rent: rent, beds: beds, baths: baths, sqft: sqft, address: addr, daysOnMarket: daysOnMarket });
    });

    // Redfin's current map-card markup omits some primary list cards while
    // still exposing them in accessible page text. Parse only the section
    // before "End of results" so the "Willing to be flexible" suggestions do
    // not contaminate a filtered rent estimate.
    const bodyText = document.body.innerText || '';
    const endMatch = bodyText.match(/\\nEnd of results[^\\n]*/i);
    const primaryText = endMatch ? bodyText.slice(0, endMatch.index) : '';
    primaryText.split(/ABOUT THIS HOME/i).slice(1).forEach(section => {
        const priceM = section.match(/\\$([\\d,]+)\\s*\\/\\s*mo\\b/i);
        const bedsM = section.match(/(\\d+)\\s*(?:beds?|bd)\\b/i);
        const bathsM = section.match(/(\\d+(?:\\.\\d+)?)\\s*(?:baths?|ba)\\b/i);
        const sqftM = section.match(/([\\d,]+)\\s*sq\\s*ft\\b/i);
        const addressM = section.match(/\\n([^\\n]+,\\s*[A-Z]{2}\\s+\\d{5})\\b/);
        const domM = section.match(/(\\d+)\\s+days?\\s+(?:on\\s+Redfin|listed|on\\s+(?:the\\s+)?market)/i);
        if (!priceM || !bedsM) return;
        addResult({
            rent: parseInt(priceM[1].replace(/,/g, '')),
            beds: parseInt(bedsM[1]),
            baths: bathsM ? parseFloat(bathsM[1]) : null,
            sqft: sqftM ? parseInt(sqftM[1].replace(/,/g, '')) : null,
            address: addressM ? addressM[1].trim() : null,
            daysOnMarket: domM ? parseInt(domM[1]) : null
        });
    });
    return results;
}
"""


def _median_rent(values: list[int]) -> int:
    """Return a conventional median instead of the upper middle value."""
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return round(ordered[middle])
    return round((ordered[middle - 1] + ordered[middle]) / 2)


def _qualify_redfin_rentals(
    rentals: list[dict], beds: int | None = None, sqft: int | None = None
) -> list[dict]:
    """Reject Redfin fallback cards that do not match the subject property."""
    qualified = [item for item in rentals if item.get("rent") and item["rent"] > 0]
    if beds and beds > 0:
        # Redfin can render unrelated "Willing to be flexible" cards despite
        # an exact bedroom URL filter. Unknown bedrooms are not safe evidence.
        qualified = [item for item in qualified if item.get("beds") == int(beds)]
    if sqft and sqft > 0:
        sized = [
            item for item in qualified
            if not item.get("sqft") or 0.5 <= item["sqft"] / sqft <= 1.75
        ]
        if sized:
            qualified = sized
    deduped = {}
    for item in qualified:
        key = (item.get("address") or "").strip().lower() or (
            item.get("rent"), item.get("beds"), item.get("baths"), item.get("sqft")
        )
        deduped[key] = item
    return list(deduped.values())


async def _search_redfin_rentals(
    location: str,
    beds: int | None = None,
    property_type: str | None = None,
    sqft: int | None = None,
) -> dict:
    """Search Redfin for rental listings to estimate market rent.

    For zip codes, navigates directly. For city names, uses Playwright
    search bar (Redfin uses numeric city IDs that can't be URL-constructed).
    """
    from playwright.async_api import async_playwright

    query = location.strip()
    is_zip = bool(re.match(r"^\d{5}$", query))

    normalized_type = (property_type or "").strip().lower()
    rental_segment = (
        "houses-for-rent"
        if normalized_type in {"sfh", "sfr", "single family", "single-family", "house"}
        else "apartments-for-rent"
    )

    async with _search_semaphore, async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = await browser.new_context(
            user_agent=HEADERS["User-Agent"],
            viewport={"width": 1280, "height": 900},
            locale="en-US",
            timezone_id="America/New_York",
        )
        page = await context.new_page()
        await page.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
        )

        if is_zip:
            # Zip code — navigate directly
            base = f"https://www.redfin.com/zipcode/{query}/{rental_segment}"
            try:
                await page.goto(base, wait_until="domcontentloaded", timeout=30000)
            except Exception:
                await browser.close()
                return {"error": "Could not connect to Redfin."}
        else:
            # City name — use Redfin search bar to resolve, then switch to rentals
            try:
                await page.goto("https://www.redfin.com", wait_until="domcontentloaded", timeout=20000)
                search_input = page.locator(
                    "input[type='text'][placeholder*='Search'], input[type='search'], "
                    "#search-box-input, [data-testid='search-box-input']"
                ).first
                await search_input.fill(query)
                await page.wait_for_timeout(1500)
                await search_input.press("Enter")
                await page.wait_for_timeout(3000)
                # Now on the for-sale page; switch to rentals
                current_url = page.url
                # Replace for-sale path with rental path
                rental_url = re.sub(
                    r"(/filter/.*)?$", "/" + rental_segment, current_url.rstrip("/")
                )
                if f"/{rental_segment}" not in rental_url:
                    rental_url = current_url.rstrip("/") + "/" + rental_segment
                await page.goto(rental_url, wait_until="domcontentloaded", timeout=20000)
            except Exception:
                await browser.close()
                return {"error": "Could not connect to Redfin."}

        try:
            await page.wait_for_selector(
                ".MapHomeCardReact, [class*='HomeCard']", timeout=8000
            )
        except Exception:
            await browser.close()
            return {"rentals": [], "total": 0}

        await page.wait_for_timeout(1500)

        # Scroll to load more rental listings
        for _ in range(4):
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await page.wait_for_timeout(800)

        rentals = await page.evaluate(_REDFIN_RENT_JS)
        await browser.close()

    rentals = _qualify_redfin_rentals(rentals, beds=beds, sqft=sqft)[:40]
    if not rentals:
        return {"rentals": [], "total": 0}

    rents = [r["rent"] for r in rentals]
    rents.sort()
    avg_rent = sum(rents) / len(rents)
    median_rent = _median_rent(rents)
    low_rent = rents[int(len(rents) * 0.25)] if len(rents) >= 4 else rents[0]
    high_rent = rents[int(len(rents) * 0.75)] if len(rents) >= 4 else rents[-1]
    market_days = sorted(
        r["daysOnMarket"] for r in rentals
        if r.get("daysOnMarket") is not None and r["daysOnMarket"] > 0
    )

    return {
        "rentals": rentals,
        "total": len(rentals),
        "stats": {
            "avg": round(avg_rent),
            "median": round(median_rent),
            "low": round(low_rent),
            "high": round(high_rent),
            "count": len(rents),
            "medianDaysOnMarket": (
                market_days[len(market_days) // 2] if market_days else None
            ),
        },
    }
