"""Zillow listing extraction strategies.

This module owns Zillow's changing page shapes. HTTP routes only decide which
provider to call and never depend on the embedded JSON layout.
"""

import json
import re

def _safe_get(obj, *keys, default=None):
    """Safely traverse nested dicts/lists."""
    current = obj
    for key in keys:
        try:
            if isinstance(current, dict):
                current = current[key]
            elif isinstance(current, (list, tuple)):
                current = current[int(key)]
            else:
                return default
        except (KeyError, IndexError, TypeError, ValueError):
            return default
    return current


def _format_address(addr_obj):
    """Build a single-line address from Zillow address dict."""
    if not addr_obj or not isinstance(addr_obj, dict):
        return None
    parts = [
        addr_obj.get("streetAddress", ""),
        addr_obj.get("city", ""),
    ]
    state = addr_obj.get("state", "")
    zipcode = addr_obj.get("zipcode", "")
    state_zip = f"{state} {zipcode}".strip()
    line = ", ".join(p for p in parts if p)
    if state_zip:
        line = f"{line}, {state_zip}" if line else state_zip
    return line or None


def _extract_tax_history(raw_history):
    """Normalise Zillow taxHistory array."""
    if not raw_history or not isinstance(raw_history, list):
        return []
    result = []
    for entry in raw_history:
        if not isinstance(entry, dict):
            continue
        year = entry.get("time") or entry.get("year")
        amount = entry.get("taxPaid") or entry.get("amount")
        # 'time' is sometimes an epoch-ms; convert to year
        if isinstance(year, (int, float)) and year > 3000:
            from datetime import datetime, timezone
            try:
                year = datetime.fromtimestamp(year / 1000, tz=timezone.utc).year
            except Exception:
                pass
        if year is not None:
            result.append({"year": int(year) if year else None, "amount": amount})
    return result


def _get_image_url(prop):
    """Extract a representative image URL."""
    url = prop.get("hiResImageLink")
    if url:
        return url
    photos = prop.get("responsivePhotos") or prop.get("photos") or []
    if photos and isinstance(photos, list):
        first = photos[0]
        if isinstance(first, dict):
            # Try multiple known sub-paths
            for subkey in ("mixedSources", "sources"):
                sources = first.get(subkey)
                if sources and isinstance(sources, dict):
                    for quality in ("jpeg", "webp", "png"):
                        imgs = sources.get(quality)
                        if imgs and isinstance(imgs, list):
                            # pick the largest
                            best = max(imgs, key=lambda x: x.get("width", 0) if isinstance(x, dict) else 0)
                            if isinstance(best, dict) and best.get("url"):
                                return best["url"]
            # Direct url on photo object
            if first.get("url"):
                return first["url"]
    return None


def _build_result(prop):
    """Build the flat result dict from a Zillow property dict."""
    tax_history = _extract_tax_history(prop.get("taxHistory"))
    annual_tax = None
    if tax_history:
        annual_tax = tax_history[0].get("amount")

    lot_size = prop.get("lotSize") or prop.get("lotAreaValue")
    # lotSize sometimes comes as a string like "6,000 sqft"
    if isinstance(lot_size, str):
        nums = re.findall(r"[\d,]+", lot_size)
        if nums:
            try:
                lot_size = int(nums[0].replace(",", ""))
            except ValueError:
                lot_size = None

    return {
        "address": _format_address(prop.get("address")),
        "price": prop.get("price") or prop.get("listPrice"),
        "beds": prop.get("bedrooms"),
        "baths": prop.get("bathrooms"),
        "sqft": prop.get("livingArea"),
        "lotSize": lot_size,
        "yearBuilt": prop.get("yearBuilt"),
        "propertyType": prop.get("homeType"),
        "zestimate": prop.get("zestimate"),
        "rentZestimate": prop.get("rentZestimate"),
        "taxHistory": tax_history,
        "annualTax": annual_tax,
        "hoaFee": prop.get("monthlyHoaFee") or 0,
        "description": prop.get("description"),
        "imageUrl": _get_image_url(prop),
    }


# ---------------------------------------------------------------------------
# Extraction strategies
# ---------------------------------------------------------------------------

def _extract_from_next_data(soup):
    """Primary: parse __NEXT_DATA__ -> gdpClientCache / apiCache."""
    script_tag = soup.find("script", id="__NEXT_DATA__")
    if not script_tag or not script_tag.string:
        return None

    try:
        next_data = json.loads(script_tag.string)
    except (json.JSONDecodeError, TypeError):
        return None

    # Strategy A: gdpClientCache (most common)
    gdp_cache = _safe_get(next_data, "props", "pageProps", "gdpClientCache")
    if gdp_cache and isinstance(gdp_cache, (dict, str)):
        # gdpClientCache may itself be a JSON string
        if isinstance(gdp_cache, str):
            try:
                gdp_cache = json.loads(gdp_cache)
            except json.JSONDecodeError:
                gdp_cache = {}

        if isinstance(gdp_cache, dict):
            for _key, value in gdp_cache.items():
                # Each value is often a stringified JSON blob
                parsed = value
                if isinstance(value, str):
                    try:
                        parsed = json.loads(value)
                    except json.JSONDecodeError:
                        continue

                # Look for property data
                prop = None
                if isinstance(parsed, dict):
                    prop = parsed.get("property")
                    if not prop:
                        # Sometimes nested under data -> property
                        prop = _safe_get(parsed, "data", "property")
                if prop and isinstance(prop, dict):
                    return _build_result(prop)

    # Strategy B: apiCache
    api_cache = _safe_get(next_data, "props", "pageProps", "apiCache")
    if api_cache and isinstance(api_cache, (dict, str)):
        if isinstance(api_cache, str):
            try:
                api_cache = json.loads(api_cache)
            except json.JSONDecodeError:
                api_cache = {}

        if isinstance(api_cache, dict):
            for _key, value in api_cache.items():
                parsed = value
                if isinstance(value, str):
                    try:
                        parsed = json.loads(value)
                    except json.JSONDecodeError:
                        continue
                if isinstance(parsed, dict):
                    prop = parsed.get("property")
                    if not prop:
                        prop = _safe_get(parsed, "data", "property")
                    if prop and isinstance(prop, dict):
                        return _build_result(prop)

    # Strategy C: direct pageProps.property (newer layouts)
    prop = _safe_get(next_data, "props", "pageProps", "property")
    if prop and isinstance(prop, dict) and (prop.get("address") or prop.get("price")):
        return _build_result(prop)

    # Strategy D: componentProps (may contain its own gdpClientCache)
    comp_props = _safe_get(next_data, "props", "pageProps", "componentProps")
    if comp_props and isinstance(comp_props, dict):
        # D1: direct property on componentProps values
        for _key, value in comp_props.items():
            if isinstance(value, dict):
                prop = value.get("property")
                if prop and isinstance(prop, dict):
                    return _build_result(prop)

        # D2: gdpClientCache nested inside componentProps
        gdp_nested = comp_props.get("gdpClientCache")
        if gdp_nested:
            if isinstance(gdp_nested, str):
                try:
                    gdp_nested = json.loads(gdp_nested)
                except json.JSONDecodeError:
                    gdp_nested = {}
            if isinstance(gdp_nested, dict):
                for _key, value in gdp_nested.items():
                    parsed = value
                    if isinstance(value, str):
                        try:
                            parsed = json.loads(value)
                        except json.JSONDecodeError:
                            continue
                    if isinstance(parsed, dict):
                        prop = parsed.get("property")
                        if not prop:
                            prop = _safe_get(parsed, "data", "property")
                        if prop and isinstance(prop, dict):
                            return _build_result(prop)

    return None


def _extract_from_ld_json(soup):
    """Fallback: parse application/ld+json structured data."""
    ld_scripts = soup.find_all("script", type="application/ld+json")
    for tag in ld_scripts:
        if not tag.string:
            continue
        try:
            data = json.loads(tag.string)
        except (json.JSONDecodeError, TypeError):
            continue

        # Can be a list or single object
        items = data if isinstance(data, list) else [data]
        for item in items:
            if not isinstance(item, dict):
                continue
            item_type = item.get("@type", "")
            if item_type in ("SingleFamilyResidence", "Residence", "Product", "House", "Apartment"):
                # ld+json has a different shape; map what we can
                address_obj = item.get("address", {})
                if isinstance(address_obj, dict):
                    addr = {
                        "streetAddress": address_obj.get("streetAddress", ""),
                        "city": address_obj.get("addressLocality", ""),
                        "state": address_obj.get("addressRegion", ""),
                        "zipcode": address_obj.get("postalCode", ""),
                    }
                else:
                    addr = None

                floor_size = item.get("floorSize", {})
                sqft = None
                if isinstance(floor_size, dict):
                    sqft = floor_size.get("value")
                elif isinstance(floor_size, (int, float)):
                    sqft = floor_size

                price = None
                offers = item.get("offers", {})
                if isinstance(offers, dict):
                    price = offers.get("price")
                if not price:
                    price = item.get("price")

                return {
                    "address": _format_address(addr) if addr else item.get("name"),
                    "price": price,
                    "beds": item.get("numberOfRooms") or item.get("bedrooms"),
                    "baths": item.get("bathrooms"),
                    "sqft": sqft,
                    "lotSize": None,
                    "yearBuilt": item.get("yearBuilt"),
                    "propertyType": item_type,
                    "zestimate": None,
                    "rentZestimate": None,
                    "taxHistory": [],
                    "annualTax": None,
                    "hoaFee": 0,
                    "description": item.get("description"),
                    "imageUrl": item.get("image"),
                }
    return None


def _extract_from_dom(soup):
    """Fallback: extract property data from rendered DOM elements and meta tags."""
    result = {
        "address": None, "price": None, "beds": None, "baths": None,
        "sqft": None, "lotSize": None, "yearBuilt": None, "propertyType": None,
        "zestimate": None, "rentZestimate": None, "taxHistory": [],
        "annualTax": None, "hoaFee": 0, "description": None, "imageUrl": None,
    }

    # Try og:title for address
    og_title = soup.find("meta", property="og:title")
    if og_title and og_title.get("content"):
        result["address"] = og_title["content"].split("|")[0].strip()

    # Try og:image
    og_image = soup.find("meta", property="og:image")
    if og_image and og_image.get("content"):
        result["imageUrl"] = og_image["content"]

    # Try meta description for details
    meta_desc = soup.find("meta", attrs={"name": "description"})
    if meta_desc and meta_desc.get("content"):
        desc = meta_desc["content"]
        result["description"] = desc

        # Parse common patterns like "$350,000 - 3 bed, 2 bath, 1,500 sqft"
        price_m = re.search(r"\$[\d,]+", desc)
        if price_m:
            try:
                result["price"] = int(price_m.group().replace("$", "").replace(",", ""))
            except ValueError:
                pass

        beds_m = re.search(r"(\d+)\s*(?:bed|br)", desc, re.IGNORECASE)
        if beds_m:
            result["beds"] = int(beds_m.group(1))

        baths_m = re.search(r"(\d+(?:\.\d+)?)\s*(?:bath|ba)", desc, re.IGNORECASE)
        if baths_m:
            result["baths"] = float(baths_m.group(1))

        sqft_m = re.search(r"([\d,]+)\s*(?:sq\s*ft|sqft)", desc, re.IGNORECASE)
        if sqft_m:
            try:
                result["sqft"] = int(sqft_m.group(1).replace(",", ""))
            except ValueError:
                pass

    # Search for JSON-like data blobs in script tags (Zillow often embeds property
    # data in various script tags beyond __NEXT_DATA__)
    for script in soup.find_all("script"):
        text = script.string or ""
        if not text or len(text) < 100:
            continue

        # Look for common Zillow data patterns
        for pattern in [r'"price"\s*:\s*(\d+)', r'"listPrice"\s*:\s*(\d+)']:
            m = re.search(pattern, text)
            if m and not result["price"]:
                try:
                    result["price"] = int(m.group(1))
                except ValueError:
                    pass

        if not result["beds"]:
            m = re.search(r'"bedrooms"\s*:\s*(\d+)', text)
            if m:
                result["beds"] = int(m.group(1))

        if not result["baths"]:
            m = re.search(r'"bathrooms"\s*:\s*([\d.]+)', text)
            if m:
                result["baths"] = float(m.group(1))

        if not result["sqft"]:
            m = re.search(r'"livingArea"\s*:\s*(\d+)', text)
            if m:
                result["sqft"] = int(m.group(1))

        if not result["yearBuilt"]:
            m = re.search(r'"yearBuilt"\s*:\s*(\d{4})', text)
            if m:
                result["yearBuilt"] = int(m.group(1))

        if not result["zestimate"]:
            m = re.search(r'"zestimate"\s*:\s*(\d+)', text)
            if m:
                result["zestimate"] = int(m.group(1))

        if not result["rentZestimate"]:
            m = re.search(r'"rentZestimate"\s*:\s*(\d+)', text)
            if m:
                result["rentZestimate"] = int(m.group(1))

    # Only return if we found at least an address or price
    if result["address"] or result["price"]:
        return result

    return None

def extract(soup):
    """Try Zillow's structured sources from strongest to weakest."""
    return (
        _extract_from_next_data(soup)
        or _extract_from_ld_json(soup)
        or _extract_from_dom(soup)
    )
