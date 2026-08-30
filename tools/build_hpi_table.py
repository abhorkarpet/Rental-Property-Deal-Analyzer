#!/usr/bin/env python3
"""Precompute per-ZIP appreciation statistics from the FHFA House Price Index.

Run this offline, roughly once a year after FHFA refreshes the series (they
stamp a "Last updated" line inside the workbook, which this script records as
the vintage). It writes two small gzipped tables into ``data/`` which are
committed to the repo. The app reads only those tables, so it needs no network
call, no API key and no openpyxl at runtime.

    python tools/build_hpi_table.py            # download, parse, write
    python tools/build_hpi_table.py --keep     # cache the workbooks locally

Why FHFA rather than a listings feed: this is a *repeat-sales* index. It is
built from the same houses transacting more than once, so it measures what an
individual property does over time. A median list or sale price moves with
whatever happened to come on the market that month, which is a different and
much noisier quantity.
"""

import argparse
import gzip
import json
import re
import sys
import urllib.request
from pathlib import Path

ZIP5_URL = "https://www.fhfa.gov/hpi/download/annual/hpi_at_zip5.xlsx"
STATE_URL = "https://www.fhfa.gov/hpi/download/annual/hpi_at_state.xlsx"

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

# The workbooks carry five banner rows before the column names.
HEADER_ROW = 5

# Exact column names expected on that header row. FHFA revises these files;
# a renamed or reordered column would silently shift every number we derive,
# so the parse aborts rather than guessing.
ZIP5_HEADER = [
    "Five-Digit ZIP Code", "Year", "Annual Change (%)",
    "HPI", "HPI with 1990 base", "HPI with 2000 base",
]
STATE_HEADER = [
    "State", "Abbreviation", "FIPS", "Year", "Annual Change (%)",
    "HPI", "HPI with 1990 base", "HPI with 2000 base",
]

# Cap the lookback so every area is measured over the same recent stretch.
# Without a cap, one ZIP's series starts in 1984 and its neighbour's in 2005,
# and their "long-run" rates are not comparable — the older one carries the
# high-inflation late 1980s and the newer one starts at the 2006 peak.
WINDOW_YEARS = 30

# Below this there is not enough history to say anything about a distribution,
# and the caller falls back to the state tier.
MIN_YEARS = 15

# Holding periods the percentile bands describe. The app lets you pick a hold,
# and the band has to be built from windows of that same length — a 5-year
# spread says nothing useful about a 15-year hold.
#
# Stops at 20: with ~31 annual observations there are only 11 overlapping
# 20-year windows and a single 30-year one, which is not a distribution. Longer
# holds reuse the 20-year band, and the app says so.
HOLD_PERIODS = (5, 10, 15, 20)

# Per-ZIP row layout: the three area-level fields, then four numbers for each
# holding period in HOLD_PERIODS order.
BASE_FIELDS = ["cagr_bp", "start_year", "n_years"]
HOLD_FIELDS = ["p10_bp", "p50_bp", "p90_bp", "worst_bp"]
FIELDS = BASE_FIELDS + [f"h{h}_{f}" for h in HOLD_PERIODS for f in HOLD_FIELDS]

# A holding period needs at least this many overlapping windows to describe a
# spread rather than an anecdote.
MIN_WINDOWS = 6


def percentile(sorted_values, q):
    """Linear-interpolated percentile. Avoids a numpy dependency for one call."""
    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return sorted_values[0]
    pos = (len(sorted_values) - 1) * q
    low = int(pos)
    high = min(low + 1, len(sorted_values) - 1)
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (pos - low)


def _clean(value):
    """FHFA writes a literal '.' where a value is missing."""
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
        if value in ("", "."):
            return None
        try:
            value = float(value)
        except ValueError:
            return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def summarize(series, latest_year):
    """Turn one area's {year: index} into the row the app consumes.

    Returns None when the area lacks the history to support a distribution.
    """
    cutoff = latest_year - WINDOW_YEARS
    years = sorted(y for y in series if y >= cutoff)
    # A gap in the middle would make the compounding arithmetic wrong, so
    # only use the unbroken run ending at the most recent observation.
    if not years:
        return None
    contiguous = [years[-1]]
    for year in reversed(years[:-1]):
        if year == contiguous[0] - 1:
            contiguous.insert(0, year)
        else:
            break
    years = contiguous
    if len(years) < MIN_YEARS:
        return None

    start, end = years[0], years[-1]
    span = end - start
    cagr = (series[end] / series[start]) ** (1.0 / span) - 1.0

    bp = lambda x: int(round(x * 10000))
    row = [bp(cagr), start, len(years)]

    # For each holding period, every overlapping window of that length. This is
    # the empirical spread of outcomes for someone who bought at an arbitrary
    # point and sold N years later — which is the actual question, and it has a
    # different answer for every N.
    for hold in HOLD_PERIODS:
        annualized, totals = [], []
        for year in years:
            exit_year = year + hold
            if exit_year not in series or exit_year > end:
                continue
            ratio = series[exit_year] / series[year]
            annualized.append(ratio ** (1.0 / hold) - 1.0)
            totals.append(ratio - 1.0)
        if len(annualized) < MIN_WINDOWS:
            # Not enough history for this horizon; the caller falls back to the
            # longest horizon that does have data.
            row.extend([None, None, None, None])
            continue
        annualized.sort()
        row.extend([
            bp(percentile(annualized, 0.10)),
            bp(percentile(annualized, 0.50)),
            bp(percentile(annualized, 0.90)),
            bp(min(totals)),
        ])
    return row


def read_sheet(path, sheet, header, key_col, year_col, hpi_col):
    """Stream one workbook into {key: {year: index}}."""
    import openpyxl

    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    if sheet not in workbook.sheetnames:
        sys.exit(f"{path.name}: expected a '{sheet}' sheet, found {workbook.sheetnames}")
    worksheet = workbook[sheet]

    vintage = None
    series = {}
    for index, row in enumerate(worksheet.iter_rows(values_only=True)):
        if index < HEADER_ROW:
            text = str(row[0] or "")
            match = re.search(r"Last updated:\s*([^.]+)", text)
            if match:
                vintage = match.group(1).strip()
            continue
        if index == HEADER_ROW:
            actual = [str(c).strip() if c is not None else None for c in row[:len(header)]]
            if actual != header:
                sys.exit(
                    f"{path.name}: unexpected columns.\n  expected {header}\n  found    {actual}\n"
                    "FHFA changed the layout; fix the header constant before trusting the output."
                )
            continue
        key = row[key_col]
        if key is None:
            continue
        value = _clean(row[hpi_col])
        year = row[year_col]
        if value is None or not isinstance(year, (int, float)):
            continue
        series.setdefault(str(key).strip(), {})[int(year)] = value
    workbook.close()
    return series, vintage


def fetch(url, path, keep):
    if keep and path.exists():
        print(f"  using cached {path.name}")
        return
    print(f"  downloading {url}")
    urllib.request.urlretrieve(url, path)


def write_table(path, payload):
    # sort_keys and a fixed separator keep the output byte-identical across
    # runs; mtime=0 keeps gzip from stamping the current time into the header.
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    with gzip.GzipFile(path, "wb", compresslevel=9, mtime=0) as handle:
        handle.write(raw)
    print(f"  wrote {path.relative_to(ROOT)}  ({path.stat().st_size / 1024:.0f} KB, {len(raw) / 1024:.0f} KB raw)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="reuse workbooks already downloaded")
    parser.add_argument("--workdir", default=None, help="where to put the downloaded workbooks")
    args = parser.parse_args()

    workdir = Path(args.workdir) if args.workdir else DATA_DIR / ".fhfa"
    workdir.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(exist_ok=True)

    zip_path, state_path = workdir / "hpi_at_zip5.xlsx", workdir / "hpi_at_state.xlsx"
    print("FHFA House Price Index -> data/")
    fetch(ZIP5_URL, zip_path, args.keep)
    fetch(STATE_URL, state_path, args.keep)

    print("  parsing states")
    state_series, vintage = read_sheet(state_path, "state", STATE_HEADER, 1, 3, 5)
    print("  parsing ZIP codes (this takes a minute)")
    zip_series, _ = read_sheet(zip_path, "ZIP5", ZIP5_HEADER, 0, 1, 3)

    latest_year = max(max(years) for years in state_series.values())

    states = {k: v for k, v in ((s, summarize(d, latest_year)) for s, d in state_series.items()) if v}
    zips = {k: v for k, v in ((z, summarize(d, latest_year)) for z, d in zip_series.items()) if v}

    # No national row ships in the workbook, so synthesize one as the median
    # state. It is only ever the last-resort tier for an unrecognized address.
    def median_col(i):
        vals = sorted(r[i] for r in states.values() if r[i] is not None)
        return int(round(percentile(vals, 0.5))) if vals else None
    national = [median_col(i) for i in range(len(FIELDS))]

    common = {
        "source": "FHFA House Price Index, annual all-transactions (developmental)",
        "url": ZIP5_URL,
        "vintage": vintage,
        "latest_year": latest_year,
        "window_years": WINDOW_YEARS,
        "hold_periods": list(HOLD_PERIODS),
        "fields": FIELDS,
        "national": national,
    }
    write_table(DATA_DIR / "hpi_state.json.gz", {**common, "url": STATE_URL, "rows": states})
    write_table(DATA_DIR / "hpi_zip5.json.gz", {**common, "rows": zips})

    print(f"\n  vintage {vintage} | latest year {latest_year}")
    print(f"  {len(zips):,} of {len(zip_series):,} ZIP codes had {MIN_YEARS}+ contiguous years")
    print(f"  {len(states)} states | national median {national[0] / 100:.2f}%/yr")


if __name__ == "__main__":
    main()
