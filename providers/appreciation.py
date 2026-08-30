"""Local property appreciation from the FHFA House Price Index.

The rate a property appreciates at is the largest and least certain input to a
long-run return, and until now it was a flat 3% typed into a box. This module
replaces it with the ZIP code's own measured history.

Two deliberate choices:

**Repeat-sales, not median price.** FHFA builds its index from the same houses
transacting more than once, so it tracks what an individual property does. A
median sale or list price moves with whatever happened to come on the market,
which is a different quantity and a far noisier one.

**A range, not a number.** The same tables carry the spread of every
overlapping five-year window in that ZIP, so the caller can show what a bad
entry point looked like. This matters more than the average: ZIP 95337
averaged 4.2%/yr since 1995, and its worst five-year stretch still lost 59% of
value. A point estimate cannot express that and should not pretend to.

Reads only the precomputed tables in ``data/`` — see tools/build_hpi_table.py.
No network call, no API key, no per-request cost.
"""

import gzip
import json
from pathlib import Path

from .base import extract_state, extract_zip

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# Compounding a historical outlier for thirty years produces fantasy, not a
# forecast. A few ZIPs sit above this because their window opens at a local
# trough; the ceiling keeps that from becoming a projection.
RATE_CEILING_PCT = 8.0
RATE_FLOOR_PCT = 0.0
# The optimistic leg is a scenario rather than an expectation, so it is allowed
# more headroom than the central rate.
BAND_CEILING_PCT = 15.0

# One ZIP's rate is a small sample measured over one particular window, so it
# is pulled toward its state before being used. Standard shrinkage: the longer
# the local history, the more it is trusted on its own.
SHRINK_LONG_HISTORY = 0.70   # >= 25 years of data
SHRINK_SHORT_HISTORY = 0.50  # below that
LONG_HISTORY_YEARS = 25

# Last resort when an address resolves to neither a ZIP nor a state.
FALLBACK_RATE_PCT = 3.5

# What the app underwrites at by default.
#
# The historical rate is what a market *did*, not what it will do, and the
# window that produced it (1995-2025) contains a long decline in mortgage
# rates that cannot repeat. Underwriting at roughly long-run inflation instead
# means the deal has to work on cash flow, and any real appreciation is upside
# rather than a load-bearing assumption.
#
# Taking the lower of this and the local rate means local history can only ever
# make the default more cautious, never less. It binds for about 97% of ZIPs.
CONSERVATIVE_ANCHOR_PCT = 2.5

_cache: dict = {}


def _table(name: str) -> dict:
    """Load and memoize one gzipped table. A missing file is not an error —
    the app must still run for someone who cloned without the data."""
    if name not in _cache:
        path = _DATA_DIR / f"{name}.json.gz"
        try:
            with gzip.open(path, "rb") as handle:
                _cache[name] = json.loads(handle.read())
        except (OSError, ValueError):
            _cache[name] = {}
    return _cache[name]


DEFAULT_HOLD_YEARS = 10


def _row(table: dict, key: str | None, hold_years: int = DEFAULT_HOLD_YEARS) -> dict | None:
    """Expand a packed row, picking the band that matches the holding period.

    A five-year spread says nothing useful about a fifteen-year hold — time
    narrows the distribution dramatically, and using the wrong one would either
    invent risk or hide it. Holds longer than the longest measured period reuse
    that period's band, and ``band_years`` reports what was actually used.
    """
    if not key:
        return None
    fields = table.get("fields")
    values = (table.get("rows") or {}).get(str(key).strip())
    if not fields or not values:
        return None
    packed = dict(zip(fields, values))

    periods = table.get("hold_periods") or [5]
    # Nearest available period at or below the requested hold, so a 30-year
    # hold uses the 20-year band rather than a five-year one.
    eligible = [h for h in periods if h <= hold_years and packed.get(f"h{h}_p10_bp") is not None]
    if eligible:
        band = max(eligible)
    else:
        available = [h for h in periods if packed.get(f"h{h}_p10_bp") is not None]
        if not available:
            return None
        band = min(available)

    return {
        "rate_pct": packed["cagr_bp"] / 100,
        "p10_pct": packed[f"h{band}_p10_bp"] / 100,
        "p50_pct": packed[f"h{band}_p50_bp"] / 100,
        "p90_pct": packed[f"h{band}_p90_bp"] / 100,
        "worst_pct": packed[f"h{band}_worst_bp"] / 100,
        "band_years": band,
        "start_year": packed["start_year"],
        "n_years": packed["n_years"],
    }


def is_available() -> bool:
    return bool(_table("hpi_zip5").get("rows"))


def vintage() -> dict:
    table = _table("hpi_zip5")
    return {
        "source": table.get("source"),
        "vintage": table.get("vintage"),
        "latest_year": table.get("latest_year"),
        "hold_years": table.get("hold_years", 5),
    }


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _shape(rate_pct, band_source, source, label, extra=None):
    """Assemble the payload, recentering the band on the returned rate.

    The band is carried as offsets from the area's own average rather than as
    absolute percentiles. Shrinking a ZIP's rate toward its state and then
    pasting the ZIP's raw percentiles around it would produce a band that no
    longer brackets the number shown — so the spread travels with the rate.
    What the offsets preserve is local *volatility*, which is exactly the part
    that must not be averaged away: Ohio and Nevada have similar averages and
    nothing like the same risk.
    """
    rate = _clamp(rate_pct, RATE_FLOOR_PCT, RATE_CEILING_PCT)
    spread_low = band_source["p10_pct"] - band_source["rate_pct"]
    spread_high = band_source["p90_pct"] - band_source["rate_pct"]
    payload = {
        "rate_pct": round(rate, 2),
        "conservative_pct": round(min(rate, CONSERVATIVE_ANCHOR_PCT), 2),
        "low_pct": round(rate + spread_low, 2),
        "high_pct": round(_clamp(rate + spread_high, rate, BAND_CEILING_PCT), 2),
        "worst_pct": round(band_source["worst_pct"], 1),
        "band_years": band_source.get("band_years"),
        "window": f"{band_source['start_year']}–{_table('hpi_zip5').get('latest_year', '')}",
        "source": source,
        "label": label,
    }
    payload.update(extra or {})
    return payload


def resolve_appreciation(
    address: str | None = None,
    zip_code: str | None = None,
    state: str | None = None,
    hold_years: int = DEFAULT_HOLD_YEARS,
) -> dict:
    """Best available appreciation profile: ZIP, then state, then national.

    ``state`` is taken from the address rather than the ZIP because the FHFA
    ZIP workbook carries no state column. Without it the ZIP rate is still
    returned, just unshrunk — noted in the payload so the caller can say so.
    """
    zip_code = zip_code or extract_zip(address)
    state = (state or extract_state(address) or "").upper() or None

    zip_row = _row(_table("hpi_zip5"), zip_code, hold_years)
    state_row = _row(_table("hpi_state"), state, hold_years)

    if zip_row:
        if state_row:
            weight = (
                SHRINK_LONG_HISTORY
                if zip_row["n_years"] >= LONG_HISTORY_YEARS
                else SHRINK_SHORT_HISTORY
            )
            blended = weight * zip_row["rate_pct"] + (1 - weight) * state_row["rate_pct"]
            label = f"{zip_code} since {zip_row['start_year']}, blended toward {state}"
        else:
            blended = zip_row["rate_pct"]
            label = f"{zip_code} since {zip_row['start_year']}"
        return _shape(
            blended, zip_row, "zip", label,
            {"zip": zip_code, "state": state, "raw_zip_pct": round(zip_row["rate_pct"], 2)},
        )

    if state_row:
        return _shape(
            state_row["rate_pct"], state_row, "state",
            f"{state} average since {state_row['start_year']} — no ZIP-level index for "
            f"{zip_code or 'this area'}",
            {"zip": zip_code, "state": state},
        )

    table = _table("hpi_zip5")
    national = table.get("national")
    fields = table.get("fields")
    if national and fields:
        packed = dict(zip(fields, national))
        periods = table.get("hold_periods") or [5]
        eligible = [h for h in periods if h <= hold_years and packed.get(f"h{h}_p10_bp") is not None]
        band = max(eligible) if eligible else min(
            [h for h in periods if packed.get(f"h{h}_p10_bp") is not None] or [5])
        row = {
            "rate_pct": packed["cagr_bp"] / 100,
            "p10_pct": packed[f"h{band}_p10_bp"] / 100,
            "p90_pct": packed[f"h{band}_p90_bp"] / 100,
            "worst_pct": packed[f"h{band}_worst_bp"] / 100,
            "band_years": band,
            "start_year": packed["start_year"],
        }
        return _shape(row["rate_pct"], row, "national", "US median, no local index available",
                      {"zip": zip_code, "state": state})

    # No tables at all — someone cloned the repo without data/. Return
    # something usable and say plainly that it is not measured.
    return {
        "rate_pct": FALLBACK_RATE_PCT,
        "conservative_pct": min(FALLBACK_RATE_PCT, CONSERVATIVE_ANCHOR_PCT),
        "low_pct": 0.0,
        "high_pct": 7.0,
        "worst_pct": None,
        "band_years": None,
        "window": None,
        "source": "default",
        "label": "general assumption — local price history unavailable",
        "zip": zip_code,
        "state": state,
    }
