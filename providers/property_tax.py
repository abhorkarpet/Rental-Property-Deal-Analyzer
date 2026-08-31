"""Property-tax projection policies for non-owner-occupied rentals.

The local effective rate and the annual change in the tax base are different
questions.  ``estimates.py`` answers the first; this module answers the second.
Policies here intentionally describe a conventional arm's-length purchase of
an investment property.  Homestead exemptions and senior/veteran programs are
not assumed.

The frontend performs the actual projection so its what-if controls remain
instantaneous.  This module supplies a small, versioned policy payload and the
official source that explains it.
"""

from copy import deepcopy


DEFAULT_POLICY = {
    "model": "market_value",
    "label": "Projected market-value reassessment",
    "annual_cap_pct": None,
    "reassesses_on_sale": None,
    "coverage": "general",
    "as_of": "2026-08-30",
    "detail": (
        "No statewide rental-property cap is modeled for this state. Taxes "
        "follow projected property value; county levy changes, reassessment "
        "cycles, exemptions, and special assessments can differ."
    ),
    "source_url": None,
    "source_label": None,
}


# Only rules verified from official state or county sources are specialized.
# The numerical cap is an upper bound on assessed value (or on the bill where
# explicitly marked), not a promise that the bill will rise by that amount.
STATE_POLICIES = {
    "CA": {
        "model": "assessed_value_cap",
        "label": "California Proposition 13",
        "annual_cap_pct": 2.0,
        "reassesses_on_sale": True,
        "detail": (
            "A purchase generally establishes a new market-value base. The "
            "factored base may then rise by California CPI or 2%, whichever "
            "is lower. Decline-in-value assessments, new construction, voter "
            "levies, and special assessments can change the actual bill."
        ),
        "source_url": "https://www.boe.ca.gov/proptaxes/pdf/pub29.pdf",
        "source_label": "California Board of Equalization",
    },
    "OR": {
        "model": "assessed_value_cap",
        "label": "Oregon Measure 50",
        "annual_cap_pct": 3.0,
        "reassesses_on_sale": False,
        "detail": (
            "Maximum assessed value generally rises no more than 3% and does "
            "not reset merely because the property is sold. Improvements, "
            "changed use, partitions, local-option levies, and bonds can add "
            "tax beyond this simplified path."
        ),
        "source_url": "https://www.oregon.gov/DOR/programs/property/Pages/personal-property.aspx",
        "source_label": "Oregon Department of Revenue",
    },
    "MI": {
        "model": "assessed_value_cap",
        "label": "Michigan Proposal A",
        "annual_cap_pct": 5.0,
        "reassesses_on_sale": True,
        "detail": (
            "A transfer generally uncaps taxable value in the following year. "
            "After that, taxable value may rise by inflation or 5%, whichever "
            "is lower, and cannot exceed state equalized value. Additions and "
            "local millage changes can alter the bill."
        ),
        "source_url": "https://www.michigan.gov/taxtrib/faq/glossary-of-terms",
        "source_label": "Michigan Tax Tribunal",
    },
    "AZ": {
        "model": "assessed_value_cap",
        "label": "Arizona limited property value",
        "annual_cap_pct": 5.0,
        "reassesses_on_sale": False,
        "detail": (
            "Limited property value generally grows by no more than 5% and "
            "cannot exceed full cash value. Rule B events, physical changes, "
            "classifications, and levy-rate changes can produce a different bill."
        ),
        "source_url": "https://azdor.gov/sites/default/files/2023-03/PROPERTY_LimitedPropertyValue.pdf",
        "source_label": "Arizona Department of Revenue",
    },
    "FL": {
        "model": "assessed_value_cap",
        "label": "Florida non-homestead assessment limit",
        "annual_cap_pct": 10.0,
        "reassesses_on_sale": True,
        "detail": (
            "A purchased rental is generally assessed at just value, then its "
            "non-homestead assessed value is limited to 10% annual increases. "
            "The limit does not cap every levy (including school levies), and "
            "ownership changes and improvements can reset or add value."
        ),
        "source_url": "https://floridarevenue.com/property/Pages/Taxpayers.aspx",
        "source_label": "Florida Department of Revenue",
    },
    "NV": {
        "model": "tax_bill_cap",
        "label": "Nevada investment-property tax abatement",
        "annual_cap_pct": 8.0,
        "reassesses_on_sale": False,
        "detail": (
            "A non-owner-occupied property's tax bill generally receives an "
            "abatement limiting annual growth to no more than 8%. New "
            "construction, changes of use, and qualifying low-income rentals "
            "have different treatment."
        ),
        "source_url": "https://www.leg.state.nv.us/nrs/nrs-361.html",
        "source_label": "Nevada Revised Statutes, Chapter 361",
    },
    "TX": {
        "model": "assessed_value_cap",
        "label": "Texas non-homestead circuit breaker",
        "annual_cap_pct": 20.0,
        "reassesses_on_sale": True,
        "detail": (
            "Eligible non-homestead real property is limited to a 20% annual "
            "appraised-value increase, subject to the statutory value ceiling "
            "and exclusions. The program's current statutory period ends after "
            "2026, so later years use projected market value unless extended."
        ),
        "source_url": "https://comptroller.texas.gov/taxes/property-tax/valuing-property.php",
        "source_label": "Texas Comptroller",
        "expires_after": 2026,
    },
}


def resolve_policy(state: str | None) -> dict:
    """Return a JSON-safe rental-property projection policy for a state."""
    st = (state or "").strip().upper() or None
    policy = deepcopy(DEFAULT_POLICY)
    if st in STATE_POLICIES:
        policy.update(STATE_POLICIES[st])
        policy["coverage"] = "verified_state_rule"
    policy["state"] = st
    return policy
