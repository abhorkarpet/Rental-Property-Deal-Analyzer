"""HUD gross-rent benchmarks, kept separate from property rent estimates.

API: https://www.huduser.gov/portal/dataset/fmr-api.html
Geocoder: https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html
"""
import asyncio
from datetime import date
import math
import os
from pathlib import Path
import re

import httpx

from .base import TTLCache, extract_zip, extract_state, STATE_NAMES

BASE_URL = 'https://www.huduser.gov/hudapi/public/fmr'
SOURCE_URL = 'https://www.huduser.gov/portal/datasets/fmr.html'
_cache = TTLCache(86400, Path(__file__).resolve().parent.parent / '.hud_cache.json')
_geo_cache = TTLCache(30 * 86400, Path(__file__).resolve().parent.parent / '.hud_geo_cache.json')
_locks = {}
BED_FIELDS = ['Efficiency', 'One-Bedroom', 'Two-Bedroom', 'Three-Bedroom', 'Four-Bedroom']


class HUDError(Exception):
    """Only fixed, credential-free messages may be exposed to callers."""


def is_configured():
    return bool(os.getenv('HUD_API_TOKEN', '').strip())


def default_year():
    today = date.today()
    try:
        year = int(os.getenv('HUD_FMR_YEAR', today.year + (today.month >= 9)))
        return year if 2017 <= year <= today.year + 1 else today.year
    except ValueError:
        return today.year


async def _request(path, year=None):
    if not is_configured():
        raise HUDError('HUD is not configured. Add HUD_API_TOKEN to the local .env file and restart the app.')
    key = f'{path}:{year or "directory"}'
    cached = _cache.get(key)
    if cached is not None:
        return cached
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        cached = _cache.get(key)
        if cached is not None:
            return cached
        try:
            async with httpx.AsyncClient(timeout=12, follow_redirects=False) as client:
                response = await client.get(f'{BASE_URL}/{path}',
                    params={'year': year} if year else None,
                    headers={'Authorization': 'Bearer ' + os.getenv('HUD_API_TOKEN', '').strip(),
                             'Accept': 'application/json'})
            if response.status_code in (401, 403):
                raise HUDError('HUD rejected the token. Check that it has Fair Market Rents API access.')
            if response.status_code == 404:
                raise HUDError('HUD has no data for this area and fiscal year. Try another year.')
            if response.status_code != 200:
                raise HUDError('HUD is temporarily unavailable. Try again later.')
            raw = response.json()
            data = raw.get('data', raw) if isinstance(raw, dict) else raw
            if not isinstance(data, (dict, list)) or not data:
                raise HUDError('HUD returned no usable data for this request.')
        except (httpx.HTTPError, ValueError):
            raise HUDError('Could not read HUD data. Check your connection and try again.') from None
        _cache.set(key, data)
        return data


async def areas(state):
    if state not in STATE_NAMES.values():
        raise HUDError('Choose a valid state.')
    rows = await _request(f'listCounties/{state}')
    if not isinstance(rows, list):
        raise HUDError('HUD returned an unexpected area list.')
    return [{'id': r['fips_code'], 'name': ', '.join(filter(None, [r.get('town_name'), r.get('county_name')]))}
            for r in rows if isinstance(r, dict) and re.fullmatch(r'\d{10}', str(r.get('fips_code', '')))]


async def resolve_area(address):
    cached = _geo_cache.get(address)
    if cached:
        return cached
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            response = await client.get('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress',
                params={'address': address, 'benchmark': 'Public_AR_Current',
                        'vintage': 'Current_Current', 'format': 'json'})
        response.raise_for_status()
        matches = response.json().get('result', {}).get('addressMatches', [])
        if len(matches) != 1:
            raise HUDError('Address could not be matched uniquely. Choose a HUD county or town manually.')
        match = matches[0]
        subject_zip = extract_zip(address)
        matched_zip = match.get('addressComponents', {}).get('zip')
        if subject_zip and matched_zip and subject_zip != matched_zip:
            raise HUDError('The matched address has a different ZIP. Choose the HUD area manually.')
        geos = match.get('geographies', {})
        counties = geos.get('Counties', [])
        if len(counties) != 1:
            raise HUDError('County could not be resolved. Choose a HUD county or town manually.')
        county = counties[0]
        state = extract_state(address)
        # Use HUD's own directory, which also handles town-level New England IDs
        # and changing county definitions, instead of guessing an entity ID.
        if not state:
            state = match.get('addressComponents', {}).get('state')
        directory = await areas(state)
        county_prefix = county['STATE'] + county['COUNTY']
        candidates = [r for r in directory if r['id'].startswith(county_prefix)]
        subdivisions = geos.get('County Subdivisions', [])
        town_id = county_prefix + subdivisions[0].get('COUSUB', '') if len(subdivisions) == 1 else None
        selected = next((r for r in candidates if r['id'] == town_id), None)
        if selected is None:
            selected = next((r for r in candidates if r['id'] == county_prefix + '99999'), None)
        if selected is None:
            raise HUDError('HUD area could not be matched reliably. Choose a county or town manually.')
        _geo_cache.set(address, selected['id'])
        return selected['id']
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        raise HUDError('Address lookup is unavailable. Choose a HUD county or town manually.') from None


def normalize(data, zip_code, beds, year):
    if not isinstance(data, dict):
        raise HUDError('HUD returned an unexpected rent table.')
    basic = data.get('basicdata')
    actual_year = data.get('year') or (basic.get('year') if isinstance(basic, dict) else None)
    if str(actual_year) != str(year):
        raise HUDError('HUD returned a different fiscal year. No benchmark was applied.')
    level = 'area'
    if isinstance(basic, list):
        row = next((r for r in basic if str(r.get('zip_code')) == zip_code), None) if zip_code else None
        if row is not None:
            level = 'zip'
        else:
            row = next((r for r in basic if str(r.get('zip_code', '')).lower() == 'msa level'), None)
    else:
        row = basic
    if not isinstance(row, dict):
        raise HUDError('No matching ZIP or area benchmark is available.')
    field = BED_FIELDS[min(beds, 4)]
    try:
        rent = float(row[field])
        if not math.isfinite(rent) or rent <= 0:
            raise ValueError
    except (ValueError, TypeError, KeyError):
        raise HUDError('No HUD benchmark is available for this bedroom count.') from None
    # HUD's published large-unit rule: add 15% of 4BR FMR per extra bedroom.
    derived = beds > 4
    if derived:
        rent *= 1 + .15 * (beds - 4)
    start = date(year - 1, 10, 1)
    return {'gross_rent': round(rent), 'bedrooms': beds, 'year': year,
            'geography_level': level, 'zip': zip_code if level == 'zip' else None,
            'area_name': data.get('area_name') or data.get('metro_name') or data.get('county_name') or 'HUD area',
            'source': 'hud_safmr' if level == 'zip' else 'hud_fmr',
            'source_url': SOURCE_URL, 'fiscal_year_start': start.isoformat(),
            'future_fiscal_year': date.today() < start, 'derived_bedrooms': derived,
            'note': 'Gross rent includes utilities. Deduct tenant-paid utility allowance before using as rental income. This is not a guaranteed voucher payment.'}


async def benchmark(address, beds, year=None, entity_id=None, zip_code=None):
    if not is_configured():
        raise HUDError('HUD is not configured. Add HUD_API_TOKEN to the local .env file and restart the app.')
    if beds is None or not isinstance(beds, int) or not 0 <= beds <= 10:
        raise HUDError('Choose a bedroom count from studio through 10.')
    year = year or default_year()
    if not 2017 <= year <= date.today().year + 1:
        raise HUDError('Choose a supported fiscal year.')
    if entity_id and not re.fullmatch(r'\d{10}|METRO[A-Z0-9]{5,20}', entity_id):
        raise HUDError('Invalid HUD area ID.')
    entity_id = entity_id or await resolve_area(address)
    data = await _request(f'data/{entity_id}', year)
    result = normalize(data, zip_code or extract_zip(address), beds, year)
    result['entity_id'] = entity_id
    return result
