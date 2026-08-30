"""Percentage-based estimates for carrying costs the listing doesn't provide.

Property tax here is deliberately **rate-driven, not bill-driven**. On sale a
property is reassessed at roughly the purchase price, so what the buyer will
pay is `purchase price x local effective rate`. The seller's current bill is
the wrong basis — under an assessment cap like California's Prop 13 a
long-held home is assessed far below market, and its bill can understate the
post-sale bill by thousands a year. The rate transfers across a sale; the
bill does not.
"""

from .base import extract_state

# Effective property tax rates as a share of value, used as the fallback when
# no zip-level rate is available. Figures track published state medians.
#
# CA is the deliberate exception: its published effective rate (~0.71%) is
# depressed by Prop 13 assessments on long-held homes and does NOT describe
# what a new buyer pays. A post-sale California assessment is the purchase
# price at the 1% base rate plus local levies, so ~1.15% is the honest number
# for this calculation.
STATE_TAX_RATES = {
    "AL": 0.0040, "AK": 0.0107, "AZ": 0.0062, "AR": 0.0061, "CA": 0.0115,
    "CO": 0.0051, "CT": 0.0179, "DC": 0.0057, "DE": 0.0057, "FL": 0.0082,
    "GA": 0.0090, "HI": 0.0029, "IA": 0.0152, "ID": 0.0063, "IL": 0.0207,
    "IN": 0.0083, "KS": 0.0140, "KY": 0.0084, "LA": 0.0055, "MA": 0.0114,
    "MD": 0.0105, "ME": 0.0124, "MI": 0.0138, "MN": 0.0111, "MO": 0.0095,
    "MS": 0.0079, "MT": 0.0076, "NC": 0.0078, "ND": 0.0098, "NE": 0.0161,
    "NH": 0.0209, "NJ": 0.0223, "NM": 0.0078, "NV": 0.0053, "NY": 0.0169,
    "OH": 0.0153, "OK": 0.0089, "OR": 0.0093, "PA": 0.0153, "RI": 0.0140,
    "SC": 0.0056, "SD": 0.0117, "TN": 0.0066, "TX": 0.0168, "UT": 0.0058,
    "VA": 0.0080, "VT": 0.0186, "WA": 0.0093, "WI": 0.0168, "WV": 0.0057,
    "WY": 0.0056,
}
DEFAULT_TAX_RATE = 0.0110

# Homeowners insurance.
#
# Priced off **dwelling coverage** — the cost to rebuild the structure — because
# that is how insurers actually rate a policy. Land is not insured, so a share
# of purchase price is the wrong basis and fails hardest exactly where land is
# expensive: the same house in California and Ohio needs similar coverage while
# its market prices differ by a factor of three.
#
# Figures are 2026 state averages at $300,000 dwelling coverage with a $1,000
# deductible (insurance.com). Unlike the earlier version of this table, these
# are sourced rather than estimated. AK, DC and WV are not in that dataset and
# fall back to the national average.
STATE_INSURANCE_300K = {
    "AL": 3716, "AZ": 2397, "AR": 3195, "CA": 1653, "CO": 5511,
    "CT": 2132, "DE": 1461, "FL": 8471, "GA": 2301, "HI": 738,
    "IA": 3148, "ID": 2412, "IL": 2802, "IN": 2869, "KS": 5289,
    "KY": 4471, "LA": 5185, "MA": 2112, "MD": 2242, "ME": 1299,
    "MI": 3071, "MN": 3333, "MO": 3783, "MS": 2602, "MT": 3221,
    "NC": 3799, "ND": 2846, "NE": 5513, "NH": 1324, "NJ": 1449,
    "NM": 3497, "NV": 1876, "NY": 1844, "OH": 2109, "OK": 5378,
    "OR": 1647, "PA": 1434, "RI": 2379, "SC": 2870, "SD": 3740,
    "TN": 3198, "TX": 4582, "UT": 1771, "VA": 1939, "VT": 1017,
    "WA": 1766, "WI": 1836, "WY": 2075,
}
NATIONAL_INSURANCE_300K = 2872
BASE_COVERAGE = 300_000

# Premiums rise more slowly than coverage — doubling the sum insured does not
# double the price, because a large share of the premium covers the likelihood
# of a claim rather than its size.
COVERAGE_EXPONENT = 0.65

# A landlord policy (DP-3) costs more than the owner-occupied HO-3 the averages
# above describe: liability exposure is higher and the property is unoccupied
# between tenants. This is the conventional uplift, not a quote.
LANDLORD_UPLIFT = 1.15

# When square footage is unknown there is no replacement cost to rate against,
# so coverage is guessed as a share of price. Crude, and labelled as such —
# structure share of value runs far lower in land-expensive markets.
COVERAGE_SHARE_OF_PRICE = 0.60

DEFAULT_INSURANCE_RATE = 0.0050  # legacy fallback, share of price

# A derived zip rate outside this band is treated as bad data (bad assessment
# records, a zip dominated by exempt parcels) and the state table is used.
TAX_RATE_SANITY_BAND = (0.002, 0.035)


def is_plausible_tax_rate(rate: float | None) -> bool:
    low, high = TAX_RATE_SANITY_BAND
    return rate is not None and low <= rate <= high


def state_tax_rate(state: str | None) -> tuple[float, str, str]:
    """Fallback tax rate from the state table. Returns (rate, source, label)."""
    if state and state.upper() in STATE_TAX_RATES:
        state = state.upper()
        return STATE_TAX_RATES[state], "state", f"{state} state average"
    return DEFAULT_TAX_RATE, "default", "US average"


def resolve_tax_rate(
    zip_rate: float | None, address: str | None, state: str | None = None
) -> dict:
    """Pick the best available tax rate.

    Prefers a zip-level rate derived from real assessment records, which
    captures county and special-district levies (Mello-Roos and the like)
    that a state average cannot see. Falls back to the state table.
    """
    if is_plausible_tax_rate(zip_rate):
        return {
            "rate": zip_rate,
            "source": "zip",
            "label": "local rate from area tax records",
        }
    rate, source, label = state_tax_rate(state or extract_state(address))
    return {"rate": rate, "source": source, "label": label}


def insurance_estimate(
    price: float | None = None,
    sqft: float | None = None,
    state: str | None = None,
    address: str | None = None,
) -> dict:
    """Annual landlord insurance premium, rated on rebuild cost.

    Returns an absolute dollar figure rather than a rate, because the premium
    tracks the structure and not the purchase price. A ``rate`` is still
    included for display and for callers that want it back as a percentage.
    """
    st = (state or extract_state(address) or "").upper() or None
    base = STATE_INSURANCE_300K.get(st or "", NATIONAL_INSURANCE_300K)

    if sqft and sqft > 0:
        coverage = float(sqft) * build_cost_per_sqft(st)
        basis = "rebuild"
        label = (
            f"{int(sqft):,} sqft rebuild cost ~${int(coverage):,}"
            + (f", {st} average" if st else ", US average")
        )
    elif price and price > 0:
        coverage = float(price) * COVERAGE_SHARE_OF_PRICE
        basis = "price"
        label = (
            (f"{st} average" if st else "US average")
            + " — rough, add square footage to rate it on rebuild cost"
        )
    else:
        return {
            "annual": None, "rate": DEFAULT_INSURANCE_RATE, "coverage": None,
            "source": "default", "basis": "none", "label": "no property details yet",
        }

    premium = base * (coverage / BASE_COVERAGE) ** COVERAGE_EXPONENT * LANDLORD_UPLIFT
    return {
        "annual": int(round(premium)),
        "coverage": int(round(coverage)),
        "rate": (premium / price) if price else None,
        "source": "state" if st in STATE_INSURANCE_300K else "default",
        "basis": basis,
        "label": label,
    }


def insurance_rate(address: str | None, state: str | None = None) -> dict:
    """Backwards-compatible share-of-value view, for callers without size."""
    est = insurance_estimate(price=1_000_000, address=address, state=state)
    return {
        "rate": (est["annual"] / 1_000_000) if est["annual"] else DEFAULT_INSURANCE_RATE,
        "source": est["source"],
        "label": est["label"],
    }


def annual_cost(price: float | None, rate: float) -> int | None:
    """Apply a rate to purchase price. Purchase price is the right basis for
    tax because that is approximately the post-sale assessed value."""
    if not price or price <= 0:
        return None
    return int(round(price * rate))


# ---------------------------------------------------------------------------
# Vacancy
# ---------------------------------------------------------------------------
# Vacancy is turnover time, so it follows from how fast the local market
# re-lets a unit. A flat rate ignores that a zip where rentals sit 154 days is
# a different business from one where they go in 11.

AVG_TENANCY_DAYS = 730        # ~2 years between turnovers
TURNOVER_PREP_DAYS = 14       # clean, repair and list before it can re-let
# Days-on-market reflects only the current snapshot, so a hot month must not
# produce a 1% assumption; and a stale listing shouldn't imply near-total
# vacancy either.
VACANCY_FLOOR_PCT = 4.0
VACANCY_CEILING_PCT = 25.0
DEFAULT_VACANCY_PCT = 8.0


def vacancy_from_days_on_market(days_on_market: float | None) -> dict:
    """Vacancy percentage implied by how long local rentals take to let.

    One turnover cycle is (days to re-let + prep time) out of the whole
    holding cycle (tenancy + that gap), which is the share of the year the
    unit earns nothing.
    """
    if not days_on_market or days_on_market <= 0:
        return {
            "rate_pct": DEFAULT_VACANCY_PCT,
            "days_on_market": None,
            "source": "default",
            "label": "national default",
        }
    gap = float(days_on_market) + TURNOVER_PREP_DAYS
    rate = gap / (AVG_TENANCY_DAYS + gap) * 100
    clamped = max(VACANCY_FLOOR_PCT, min(VACANCY_CEILING_PCT, rate))
    return {
        "rate_pct": round(clamped, 1),
        "days_on_market": int(days_on_market),
        "source": "market",
        "label": f"local rentals let in ~{int(days_on_market)} days",
        "floored": clamped != round(rate, 1),
    }


# ---------------------------------------------------------------------------
# Maintenance and CapEx reserves
# ---------------------------------------------------------------------------
# These are sized off the **building**, not the rent.
#
# A percentage of rent is the wrong basis and fails in a specific direction: a
# roof does not cost less in a cheap market. The same house needs 9.9% of rent
# in Manteca and 14.1% in Columbus purely because the rents differ, so a flat
# rate under-reserves wherever rent is low relative to construction cost —
# which is exactly where a screener is most likely to report a strong deal.
#
# The rates below come from a component build-up rather than a rule of thumb.
# Roof, HVAC, water heater, appliances, flooring, interior and exterior paint,
# windows, plumbing, electrical, a kitchen/bath refresh and site work, each at
# replacement cost over its service life, total roughly 1.2% of replacement
# cost per year for a mid-life single-family house. Routine maintenance —
# service calls, leaks, turnover repairs — adds roughly another 0.5%.

# Construction cost per square foot, excluding land.
#
# HONEST LIMIT: only a few of these are measured figures. The NAHB national
# average ($162/sqft) and the observed spread — roughly $154 in Mississippi and
# Oklahoma up to $230 in Hawaii, with Texas ~$162 and Colorado ~$172 — are
# sourced. Every other state is a regional interpolation between those anchors,
# not a survey result. Treat differences of a few dollars per foot as noise.
STATE_BUILD_COST = {
    "AL": 156, "AK": 200, "AZ": 165, "AR": 155, "CA": 215,
    "CO": 172, "CT": 185, "DC": 200, "DE": 172, "FL": 168,
    "GA": 162, "HI": 230, "IA": 160, "ID": 168, "IL": 170,
    "IN": 160, "KS": 158, "KY": 158, "LA": 158, "MA": 205,
    "MD": 175, "ME": 172, "MI": 165, "MN": 172, "MO": 160,
    "MS": 154, "MT": 170, "NC": 163, "ND": 162, "NE": 160,
    "NH": 175, "NJ": 190, "NM": 162, "NV": 170, "NY": 200,
    "OH": 162, "OK": 158, "OR": 185, "PA": 168, "RI": 180,
    "SC": 160, "SD": 158, "TN": 160, "TX": 162, "UT": 168,
    "VA": 168, "VT": 175, "WA": 195, "WI": 168, "WV": 156,
    "WY": 165,
}
DEFAULT_BUILD_COST = 162  # NAHB national average

# How much of a state's deviation from the national average to actually apply.
#
# Only part of a regional cost premium reaches a reserve. Shingles, water
# heaters and appliances are national commodities at roughly national prices;
# what varies regionally is labour, and in the priciest states a large share of
# the headline gap is land, permitting and regulatory cost that never appears
# in a roof replacement. Applying California's full $215/sqft to a reserve
# assumes a CA roof costs 33% more than a Texas one, which overstates it.
REGIONAL_WEIGHT = 0.5

# Annual reserve as a share of replacement cost, for a mid-life house.
#
# The CapEx figure is deliberately below the raw component build-up. That
# build-up double-counted about 23%: interior paint is turnover work already
# carried by maintenance, and a periodic kitchen/bath refresh is value-add
# rehab rather than a routine reserve. Stripping both leaves roughly 0.94% of
# replacement cost a year, so 0.9% is the honest number rather than the 1.1%
# the inflated build-up implied.
BASE_CAPEX_RATE = 0.009
BASE_MAINT_RATE = 0.005

# Age multipliers. A new house is under warranty with every component at the
# start of its life; an old one is replacing something most years.
# The top band was an arbitrary round number and compounded with everything
# else; 1.30 keeps old houses meaningfully more expensive without the curve
# doing the work of three separate assumptions at once.
AGE_FACTORS = ((10, 0.55), (25, 0.80), (50, 1.00), (80, 1.15), (10**4, 1.30))

# Used when square footage is unknown, so replacement cost cannot be computed.
# Percentages of rent, by age: (maintenance, capex).
AGE_ONLY_PCT = ((10, 3.0, 3.0), (30, 5.0, 5.0), (60, 7.0, 8.0), (10**4, 9.0, 10.0))

# What the app assumed before any of this existed. Still the answer when
# neither size nor age is known.
FLAT_MAINT_PCT = 5.0
FLAT_CAPEX_PCT = 5.0

# Guard rails. A reserve outside this share of rent means an input is wrong
# (a garage listed as living area, a rent typed as annual) more often than it
# means the property is unusual.
RESERVE_FLOOR_PCT = 4.0
RESERVE_CEILING_PCT = 25.0


def build_cost_per_sqft(state: str | None) -> int:
    st = (state or "").upper()
    full = STATE_BUILD_COST.get(st, DEFAULT_BUILD_COST)
    return int(round(DEFAULT_BUILD_COST + (full - DEFAULT_BUILD_COST) * REGIONAL_WEIGHT))


def age_factor(age: int) -> float:
    return next(f for cutoff, f in AGE_FACTORS if age <= cutoff)


def _age_only(age: int | None) -> tuple[float, float]:
    if age is None:
        return FLAT_MAINT_PCT, FLAT_CAPEX_PCT
    for cutoff, maint, capex in AGE_ONLY_PCT:
        if age <= cutoff:
            return maint, capex
    return FLAT_MAINT_PCT, FLAT_CAPEX_PCT


def reserve_rates(
    sqft: float | None = None,
    year_built: int | None = None,
    state: str | None = None,
    address: str | None = None,
    monthly_rent: float | None = None,
    current_year: int | None = None,
) -> dict:
    """Maintenance and CapEx reserves for a property.

    Returned as percentages of rent because that is what the form fields and
    every downstream metric expect — but derived from replacement cost and age
    wherever the data allows, so the percentage differs property to property
    instead of being the same 5% for a new condo and a 1910 house.

    Degrades in two steps: without square footage it falls back to an age-only
    table, and without age to the flat rates the app used before.
    """
    import datetime

    year_now = current_year or datetime.date.today().year
    age = None
    if year_built and 1500 < int(year_built) <= year_now + 3:
        age = max(0, year_now - int(year_built))

    st = (state or extract_state(address) or "").upper() or None

    # Without size or rent there is nothing to scale against.
    if not sqft or sqft <= 0 or not monthly_rent or monthly_rent <= 0:
        maint, capex = _age_only(age)
        return {
            "maintenance_pct": maint,
            "capex_pct": capex,
            "monthly_dollars": None,
            "replacement_cost": None,
            "age": age,
            "age_factor": None,
            "source": "age" if age is not None else "default",
            "label": (
                f"{age} years old — sized by age; add square footage for a "
                "building-cost estimate"
                if age is not None
                else "general assumption — no size or age available"
            ),
        }

    factor = age_factor(age) if age is not None else 1.0
    cost_per_sqft = build_cost_per_sqft(st)
    replacement = float(sqft) * cost_per_sqft

    annual_maint = replacement * BASE_MAINT_RATE * factor
    annual_capex = replacement * BASE_CAPEX_RATE * factor
    rent_year = float(monthly_rent) * 12

    maint_pct = annual_maint / rent_year * 100
    capex_pct = annual_capex / rent_year * 100

    # Clamp the pair together so their ratio survives the guard rail.
    total = maint_pct + capex_pct
    clamped = max(RESERVE_FLOOR_PCT, min(RESERVE_CEILING_PCT, total))
    if total > 0 and clamped != total:
        maint_pct *= clamped / total
        capex_pct *= clamped / total

    if age is None:
        label = f"{int(sqft):,} sqft at ${cost_per_sqft}/sqft; age unknown"
    else:
        label = (
            f"built {int(year_built)}, {age} yrs — {int(sqft):,} sqft at "
            f"${cost_per_sqft}/sqft{f' ({st})' if st else ''}"
        )

    return {
        "maintenance_pct": round(maint_pct, 1),
        "capex_pct": round(capex_pct, 1),
        "monthly_dollars": int(round((annual_maint + annual_capex) / 12)),
        "replacement_cost": int(round(replacement)),
        "cost_per_sqft": cost_per_sqft,
        "age": age,
        "age_factor": factor,
        "source": "building",
        "label": label,
        "clamped": clamped != total,
    }
