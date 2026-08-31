<div align="center">

# Rental Property Deal Analyzer

**Know if it's a good deal — before you buy.**

Free, open-source rental property investment calculator with AI-powered analysis.

![Python](https://img.shields.io/badge/python-3.9+-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![GitHub release](https://img.shields.io/github/v/release/berkcankapusuzoglu/Rental-Property-Deal-Analyzer)

[**Try the Live Demo**](https://rental-property-deal-analyzer.onrender.com) · [**Run Locally for Full Features**](#quick-start)

<a href="https://buymeacoffee.com/bkapu"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee"></a>
<a href="https://github.com/sponsors/berkcankapusuzoglu"><img src="https://img.shields.io/badge/Sponsor-ea4aaa?style=for-the-badge&logo=github-sponsors&logoColor=white" alt="GitHub Sponsors"></a>

</div>

<br>

<div align="center">
  <img src="examples/demo.gif" alt="Rental Property Deal Analyzer — Demo" width="900">
  <br>
  <em>One click from empty form to full investment analysis</em>
</div>

<br>

## What You Get

- **20+ investment metrics** calculated instantly (CoC, Cap Rate, DSCR, NOI, GRM, and more)
- **AI-powered analysis** — free local models or Claude API
- **Point-based deal scorecard** — 14-point system with factor-by-factor reasoning
- **Holding-period return breakdown** — Cash Flow + Appreciation + Debt Paydown − Upfront Costs, reported consistently before income tax and after selling costs
- **Strategy fit analysis** — Cash Flow / Wealth Building / Low Risk / BRRRR
- **Save, compare, and export** — localStorage scenarios, side-by-side comparison (up to 3), PDF + HTML export
- **Zillow & Redfin scraping** — auto-fill property data from a listing URL
- **What-If mode** — sliders for 23 modelled underwriting assumptions, grouped and collapsible, with cash flow, pre-tax profit, IRR, a 30-year chart and a full annual projection moving live as you drag
- **Visible version number** — shown on the page so you always know which build you are looking at
- **Neighborhood Search** — search a zip code or city, score listings by investor metrics, then analyze the best ones
- **Sensitivity analysis** — what-if tables for interest rate, vacancy, rent, purchase price, and appreciation
- **Rent estimation** — a property-specific RentCast estimate with a low/high range, or scraped Redfin rental comps without a key
- **Locally-sourced assumptions** — property tax rate, vacancy, appreciation and repair reserves derived from the property's own ZIP, state, age and size instead of national guesses
- **Law-aware property-tax projection** — property tax grows separately from other expenses, applying verified rental-property assessment rules for CA, OR, MI, AZ, FL, NV and TX, with official-source links and a manual override for county or parcel exceptions
- **PDF & screenshot upload** — when scraping is blocked, drop in a printed listing page and Claude reads the fields off it
- **Mortgage rate auto-fill** — fetch current 30-year fixed rate from Freddie Mac with one click
- **Deal alerts & CSV export** — highlight matching listings, export search results to spreadsheet
- **Model selector** — switch between AI models on the fly

Every metric and input carries a **(?)** with a plain-English definition and a
link to a reference article, so you do not have to already know what DSCR or GRM
means to read the output.

## Quick Start

### 1. Install

Use a virtual environment. The app needs several packages (FastAPI, Playwright,
pypdf, Pillow, the Anthropic SDK) and installing them into your system Python is
the usual cause of "it worked yesterday" startup failures.

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m playwright install chromium
```

### 2. Configure AI (optional)

```bash
cp .env.example .env
```

Choose your AI provider:

| Provider | Speed | Quality | Cost | Setup |
|----------|-------|---------|------|-------|
| **LM Studio** + qwen3.5-4b | ~30s | Excellent | Free | [Download LM Studio](https://lmstudio.ai) + load model |
| **LM Studio** + liquid/lfm2.5-1.2b | ~6s | Good | Free | [Download LM Studio](https://lmstudio.ai) + load model |
| **Ollama** + llama3.2:3b | ~7s | Good | Free | `ollama pull llama3.2:3b` |
| **Anthropic Claude** | ~5s | Excellent | ~$0.01/query | Set `ANTHROPIC_API_KEY` in `.env` |

**LM Studio** (recommended for GPU acceleration — works with AMD + NVIDIA via Vulkan):
```bash
AI_PROVIDER=lmstudio
```

**Ollama** (free, local):
```bash
AI_PROVIDER=ollama
OLLAMA_MODEL=llama3.2:3b
```

**Anthropic Claude** (paid, highest quality):
```bash
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

### 3. Run

```bash
source .venv/bin/activate          # if not already active
python app.py
```

Opens a browser automatically at **http://localhost:8000**. No build step required.
Stop it with `Ctrl-C`.

If you skipped the virtualenv activation, run it explicitly so you get the right
interpreter:

```bash
.venv/bin/python app.py
```

The version number shown under the page title tells you which build you are
looking at — check it after restarting to confirm your changes are live.

> **Restart after changing Python code.** `index.html` is re-read from disk on
> every request, and files under `static/` are served directly, so front-end
> edits appear on refresh. API routes in `app.py`
> and the `providers/` modules are only registered at startup, so a stale
> process serves the new page against the old endpoints and every new call
> returns `404 Not Found`.

### Testing

The suite covers the calculation engine, API contracts, provider fallbacks,
automatic listing hydration, all three browser entry paths, What-If, scenarios,
comparison, CSV/HTML export, AI streaming, and mobile/print layouts.

```bash
.venv/bin/python -m pip install -r requirements.txt -r requirements-dev.txt
.venv/bin/python -m playwright install chromium
node --test tests/core-calculation.test.js
.venv/bin/python -m pytest -q
```

GitHub Actions runs the same commands on every push and pull request. The test
suite also fails if `APP_VERSION` and the direct-file version in `index.html`
do not match, so every release change must include a version bump.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_PROVIDER` | `auto` | `auto`, `lmstudio`, `ollama`, or `anthropic` |
| `LMSTUDIO_URL` | `http://localhost:1234` | LM Studio server URL |
| `LMSTUDIO_MODEL` | _(auto)_ | Model ID from LM Studio |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.2:3b` | Any Ollama model name |
| `ANTHROPIC_API_KEY` | — | Anthropic provider, and required to read screenshots / printed listing pages |
| `RENTCAST_API_KEY` | — | Optional. Enables per-listing rent estimates and local tax rates |
| `RENTCAST_MONTHLY_LIMIT` | `50` | Free-tier request budget. The app asks before spending past ~90% of it |
| `RENTCAST_HARD_LIMIT` | — | Optional absolute stop, in requests per month |

## How It Works

The app has three ways to start an analysis, selected on the first step:

### Single Property (default)

A **6-step wizard** for analyzing a specific property:

1. **Property Info** — Address, price, type, ARV, rehab budget (paste a Zillow/Redfin URL, or upload a listing PDF or screenshot if scraping is blocked)
2. **Financing** — Down payment, rate, term, points, closing costs (or toggle cash purchase). Click **Current Rate** to auto-fill the latest 30-year fixed mortgage rate from Freddie Mac.
3. **Income** — Monthly rent (multi-unit support), other income, growth rate. Rent is estimated automatically: a property-specific RentCast AVM with a low/high range when a key is set, otherwise the ZIP's market data or scraped Redfin comps.
4. **Expenses** — Taxes, insurance, HOA, utilities, percentage-based costs, expense growth. Property tax, insurance, vacancy, maintenance and CapEx all arrive pre-filled from the property's ZIP, state, age and size, each badged with its source and editable. Property-tax growth is projected separately under the displayed state rule; leave the override blank for automatic treatment or enter a fixed annual rate for a known local exception.
5. **Review** — Summary of all inputs before calculating
6. **Results** — A concise decision summary, with separate **What-If** and **Full Details** views for stress testing and deeper underwriting

### Neighborhood Search

Search a zip code or city to **discover** deals — enter a location and target rent, get a scored table of listings, then click **Analyze →** on any result to jump into the full wizard with data pre-filled. See the [Neighborhood Search](#neighborhood-search) section below for details.

### Smart Deal Finder

Fully automated deal discovery — enter a location and the app will:
1. Pull market rents for the area — RentCast when configured, scraped Redfin rentals otherwise
2. Calculate a smart price cap based on median rent (see [Smart Price Cap](#smart-price-cap))
3. Search for-sale listings under that cap
4. Score each listing with a [6-star Quick Score](#quick-score-6-stars) using estimated rent
5. Show all results ranked by deal quality

### Results: What-If

What-If is available after a deal has been calculated because it stress-tests that
deal; it is not a separate way to begin an analysis. Open it from the **What-If**
tab on Results, while the default **Summary** stays focused on the verdict and key
returns. Supporting ratios, projections, financing detail and AI analysis live in
the separate **Full Details** tab.

Every assumption the model uses is on a slider — 25 of them — grouped the way the
wizard groups its steps, so the panel stays a control rather than a wall:

| Group | Sliders |
|---|---|
| **Purchase** | Purchase price, closing costs, rehab budget |
| **Loan** | Down payment, interest rate, loan term, points |
| **Income** | Monthly rent, other income, vacancy, rent growth |
| **Operating expenses** | Property taxes, insurance, maintenance, CapEx reserve, management, HOA, utilities, other expenses, expense growth |
| **Assumptions & exit** | Appreciation, hold period and selling costs |

Purchase, Loan and Income are open by default; the other two are one click away
and show a count of what you have changed inside them, so nothing hides in a
collapsed group. ARV, building % and square footage are deliberately absent —
they feed the 70% rule and the depreciation split rather than the return path,
so dragging them would move nothing the page shows.

The whole deal recomputes as you drag: headline metrics against your saved
analysis (cash flow, CoC, cap rate, DSCR, pre-tax profit and IRR), a 30-year
value/equity/loan chart, and a full annual projection. A $300K house at 20% down
and 7% renting for $3,400, held ten years:

| Year | Income | Expenses | Operating income | Cash flow | CoC | Property value | Loan balance | Equity | Profit if sold | Annualized |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | $41,616 | $14,876 | $26,740 | $7,580 | 11.48% | $307,500 | $237,562 | $69,938 | $-1,826 | -2.77% |
| 5 | $45,046 | $16,102 | $28,945 | $9,784 | 14.82% | $339,422 | $225,916 | $113,507 | $71,652 | 15.84% |
| **10** | $49,735 | $17,778 | $31,957 | $12,796 | 19.39% | $384,025 | $205,950 | $178,076 | $184,714 | 14.28% |

The exit year is marked in the app. Two things this table shows that an equity
curve cannot. Income and expenses compound at different rates, so cash flow and
CoC drift steadily apart from where they started — CoC nearly doubles over the
hold without a single assumption changing. And selling in year 1 **loses money**
even though the property gained $7,500: selling costs at 7% of $307,500 come to
$21,525, three times the gain. Income taxes are outside the underwriting model;
the hold period is a slider
precisely because that crossover is not where most people guess.

**IRR is a true IRR**, solved from the actual cash flow vector — the cash in at
year 0, each year's cash flow, and the sale net of loan payoff and selling costs
in the final year. It is reported alongside the annualized return rather than
in place of it, because the annualized figure is a CAGR on total return and
ignores *when* the cash arrived. A deal whose flows never turn positive has no
IRR, and the page shows none rather than inventing one.

It opens seeded from whatever you have entered on the Single Property tab and
**changes nothing until you press Apply**, so exploring costs you nothing. Applied
values are marked as hand-entered, so a later auto-fill will not overwrite them.
Multi-unit rent is one figure on the slider and several inputs on the form, so
applying it scales every unit by the same factor and keeps the split you entered.

Both views run the identical engine — `computeDeal()` is a pure function and the
only place the deal maths lives — so the what-if page and the wizard cannot
report different numbers for the same inputs.

> **Note:** Neighborhood Search and Smart Deal Finder require **running locally** — Redfin blocks requests from cloud servers. The [live demo](https://rental-property-deal-analyzer.onrender.com) supports Single Property mode with manual entry and the "Try Example Deal" button.

## Metrics Reference

### Core Metrics

| Metric | What It Means | Good Target |
|--------|---------------|-------------|
| **Monthly Cash Flow** | Rent minus ALL expenses (operating + mortgage) | > $100-200/unit |
| **Cash-on-Cash Return** | Annual cash flow / total cash invested | > 8% |
| **Cap Rate** | NOI / purchase price (financing-independent) | > 5-6% |
| **DSCR** | NOI / annual mortgage (debt coverage) | > 1.25 |
| **GRM** | Purchase price / annual rent | < 12-15 |
| **Break-Even Occupancy** | Min occupancy to cover all costs | < 85% |
| **OER** | Operating expenses / gross income | < 50% |
| **Rough Annual Depreciation** | Optional tax context only; excluded from returns | Informational |
| **Pre-Tax Annualized Return** | CAGR on reconciled pre-tax profit over the hold — ignores *when* cash arrived | > 10-12% |
| **Pre-Tax IRR** | Solved from the actual pre-tax cash-flow vector: full cash invested at year 0, each year's cash flow, and sale proceeds after selling costs and loan payoff. Undefined when no root exists | > 12-15% |

### Return Reconciliation

The displayed profit reconciles four components over your chosen holding period
(default 10 years, selectable from 5 to 30):

| Pillar | What It Is |
|--------|-----------|
| **Cash Flow** | Net rental income after all expenses and mortgage |
| **Appreciation after selling costs** | Value growth over the hold less commissions, title, escrow and transfer costs |
| **Debt Paydown** | Principal reduction — tenants pay down your loan |
| **Closing, rehab and points** | Upfront non-equity costs, shown as a subtraction so total profit reconciles to the full initial cash investment |

Income taxes are deliberately separate from underwriting. The app does not add
assumed depreciation savings or subtract capital-gains, depreciation-related,
state, passive-activity or other taxpayer-specific income taxes. Property tax
remains an operating expense.

### Deal Scorecard (14-Point System)

| Metric | 2 pts (Strong) | 1 pt (OK) | 0 pts (Weak) |
|--------|---------------|-----------|--------------|
| CoC Return | >= 8% | >= 4% | < 4% |
| Cap Rate | >= 6% | >= 4% | < 4% |
| DSCR | >= 1.25 | >= 1.0 | < 1.0 |
| CF per Unit/mo | >= $200 | >= $100 | < $100 |
| Break-even Occ. | <= 75% | <= 85% | > 85% |
| 1% Rule | Pass (2pts) | — | Fail (0pts) |
| 50% Rule | Pass (2pts) | — | Fail (0pts) |

**Verdict:** >= 75% = Great Deal | >= 45% = Borderline | < 45% = Pass

### Rules of Thumb

| Rule | Formula | Purpose |
|------|---------|---------|
| **1% Rule** | Monthly rent >= 1% of price | Quick cash flow filter |
| **50% Rule** | Operating expenses ~ 50% of rent | Expense reality check. Now a real test rather than a tautology: reserves are sized off the building, so a property in a cheap market can genuinely fail it |
| **70% Rule** | Price + rehab <= 70% of ARV | BRRRR / flip viability |

### Strategy Fit

| Strategy | Key Metrics | What Makes It Work |
|----------|-------------|-------------------|
| **Cash Flow** | CoC >= 8%, CF/unit >= $200, DSCR >= 1.25 | High rent-to-price, low expenses |
| **Wealth Building** | 5yr total return, appreciation, equity growth | Growing markets, value-add |
| **Low Risk** | BEO < 75%, DSCR >= 1.5, 50% rule pass | Conservative margins |
| **BRRRR** | 70% rule pass, ARV spread | Below-market purchase + forced appreciation |

### Sensitivity Analysis

The results page includes **5 what-if tables** showing how key metrics change under different assumptions:

| Table | Variable | Range | Metrics Shown |
|-------|----------|-------|---------------|
| **Interest Rate** | ±2% from your rate | 5 steps | Monthly Cash Flow, CoC Return |
| **Vacancy Rate** | ±5% from your assumption | 5 steps | Monthly Cash Flow, Break-even Occupancy |
| **Rent Change** | ±10% | 5 steps | Monthly Cash Flow, CoC Return |
| **Purchase Price** | ±10% | 5 steps | Cap Rate, CoC Return |
| **Appreciation** | Downturn / Conservative / Historical / Strong | 4 steps + your own rate | Appreciation after selling costs, pre-tax profit |

The appreciation table is the only one that moves **total return** rather than cash flow — the other four hold the sale flat. Its rates come from the ZIP's own FHFA history, so the spread reflects how volatile that market actually is.

The current (base) values are highlighted. This helps you stress-test deals — if the deal only works at exactly 5% vacancy and 6% rates, it may be riskier than one that survives 10% vacancy and 8% rates.

## Example Scenarios

All three are the same 1995-built house in Columbus, OH 43201, run through the
app with every default left alone — so property tax, vacancy, appreciation and
repair reserves are the ones the ZIP, state, age and size produce, not round
numbers chosen to make a point. Reproduce them by entering the address, price,
rent and square footage and clicking through.

### Good Deal — Cash Flow Rental

| | |
|---|---|
| **Property** | $250,000, $2,800/mo rent, 1,600 sqft |
| **Auto-filled** | 2.5% growth · 3.9% maintenance · 6.9% CapEx · 8% vacancy |
| **Results** | Cash Flow **$244/mo** · CoC **4.18%** · Cap Rate **7.16%** · DSCR **1.20** · GRM **7.4** |
| **Score** | **11/14 — Great Deal** |
| **10-Year Pre-Tax Profit** | **$116,861** after selling costs (10.32% annualized · 12.06% IRR) |

### Borderline Deal — Thin But Positive

| | |
|---|---|
| **Property** | $265,000, $2,700/mo rent, 1,700 sqft |
| **Auto-filled** | 2.5% growth · 4.2% maintenance · 7.6% CapEx · 8% vacancy |
| **Results** | Cash Flow **$44/mo** · CoC **0.71%** · Cap Rate **6.19%** · DSCR **1.03** · BEO **90.4%** |
| **Score** | **7/14 — Borderline** |
| **10-Year Pre-Tax Profit** | **$95,181** after selling costs (8.60% annualized · 9.17% IRR) |
| **Why borderline** | Only $15,000 more than the good deal, and cash flow drops by more than half. Break-even occupancy of 87% leaves almost no room for a bad tenant or a dead furnace. |

### Bad Deal — Overpriced, Negative Cash Flow

| | |
|---|---|
| **Property** | $500,000, $2,000/mo rent, 2,400 sqft (0.4% rule — far below 1%) |
| **Auto-filled** | 2.5% growth · 8.1% maintenance · 14.6% CapEx · 8% vacancy |
| **Results** | Cash Flow **-$2,186/mo** · CoC **-18.73%** · DSCR **0.12** · BEO **201.3%** |
| **Score** | **0/14 — Pass** |
| **10-Year Pre-Tax Profit** | **-$124,496** after selling costs |
| **Why** | The mortgage alone exceeds rent. Even a long hold at the conservative appreciation assumption does not overcome the operating losses. |

> **These numbers move when the model does.** Earlier versions of this README
> documented **14/14 and a $104,189 five-year return** for a property at this
> price and rent. The gap is not a correction to the property — it is repair
> reserves now sized off the building, and appreciation now reported after
> selling costs. The earlier figure counted money that a roof
> replacement and a 7% commission were always going to take. (Those older
> figures also used slightly different financing inputs, so the two are not a
> controlled comparison.) If you saved scenarios under an older version, re-run
> them.

## Assumptions & Defaults

| Assumption | Default | Notes |
|-----------|---------|-------|
| Building value % | 80% | Optional context for a rough depreciation figure; excluded from returns |
| Depreciation | 27.5 years straight-line | Informational shortcut only; not a tax calculation |
| Vacancy | 8%, or derived from local re-let speed | With `RENTCAST_API_KEY`, set from the zip's median rental days-on-market (floor 4%, ceiling 25%) |
| Maintenance | ~0.5% of replacement cost/yr | Sized off the building, not the rent — scaled by age, shown as a % of rent. Falls back to an age table, then to a flat 5% |
| CapEx reserve | ~0.9% of replacement cost/yr | Same basis. A roof does not cost less in a cheap market, so a flat % of rent under-reserves wherever rent is low relative to construction cost |
| Holding period | **10 years** | Selectable: 5 / 10 / 15 / 20 / 30. Drives every return metric, the projection table and the appreciation band. Five years is short enough that transaction costs dominate the answer |
| Year built | From the listing, or enter it | Drives the reserve more than any other input. When unknown the model assumes a mid-life house and says so |
| Insurance | State average, rated on rebuild cost | 2026 state averages at $300K dwelling coverage (insurance.com), scaled sub-linearly to the property's rebuild cost, plus 15% for a landlord policy. Land is not insured, so purchase price is the wrong basis |
| Reserve ceiling | 25% of rent combined | A reserve above a quarter of rent almost always means a bad input rather than an unusual property |
| Management | 10% | Flat assumption — no data source publishes this by zip. Replace with a real quote; add a leasing fee separately, which this app does not model |
| Closing costs | 3% of price | Varies by state (1-5%) |
| Value growth | 2.5%/yr, or the ZIP's rate if lower | Held near long-run inflation on purpose, so appreciation is upside rather than an assumption the deal leans on. The ZIP's measured FHFA rate drives the what-if scenarios and lowers this further in weaker markets. Always editable |
| Selling costs | 7% of sale price | Commission, title, escrow, transfer tax |
| Income growth | 2%/yr | Conservative rent increases |
| Expense growth | 2%/yr | Roughly tracks CPI |
| Loan terms | 30yr fixed, 25% down, 7% | 25% is the usual conventional minimum for a non-owner-occupied investment property. Click "Current Rate" for live Freddie Mac rate |

Selling costs are modelled directly. Income taxes are intentionally excluded
from the underwriting return path rather than represented by a simplified
estimate.

**Not accounted for:** income-tax savings or liabilities, passive-loss rules,
capital-gains tax, depreciation-related tax, cost segregation, 1031 exchanges,
state income tax, refinancing, PMI, rent-ready costs, legal/accounting fees,
and leasing fees on turnover.

## Tech Stack

- **Backend:** Python, FastAPI, uvicorn, httpx, BeautifulSoup, Playwright, pypdf, Pillow
- **Frontend:** Vanilla HTML/CSS/JS (single file, no frameworks, no build step)
- **AI:** LM Studio (free, GPU) / Ollama (free, local) / Anthropic Claude (paid, cloud)
- **Data providers:** `providers/` — `redfin.py` (scraping), `rentcast.py` (API),
  `upload.py` (PDF/screenshot), `estimates.py` (tax, insurance and repair reserves),
  `appreciation.py` (FHFA price history)
- **Offline data:** `data/*.json.gz`, built by `tools/build_hpi_table.py`

Two different jobs use two different models. Deal commentary is prose, so a small
local model is fine. Extraction produces the numbers every metric is computed
from, where a hallucinated bedroom count looks exactly like a correct one — so it
is pinned to Claude Opus 5 and never reads the UI's model selector.

## Property Data Scraping

The app can auto-fill property data from **Redfin** and **Zillow** listing URLs.

| Source | Reliability | Notes |
|--------|-------------|-------|
| **Redfin** | High | Extracts price, beds, baths, sqft, year built, description, and photo from structured ld+json data |
| **Zillow** | Low | Aggressively blocked by PerimeterX/HUMAN bot detection; may fail even with Playwright fallback |

The scraper tries httpx first, then Playwright headless Chromium as fallback.
A response only counts as the real page if it carries structured listing data —
Redfin answers bots with HTTP 202 and a small AWS WAF challenge page, and
trusting the status code alone made the app accept that stub and skip the
Playwright fallback that actually works.

### When scraping fails: upload the listing

Rather than retyping everything, upload what you have. Every extracted value is
shown for confirmation before it reaches the form, and each field is badged with
where it came from.

| Upload | Needs a key? | How it is read |
|--------|--------------|----------------|
| **Printed listing page** (browser "Save as PDF" of a Redfin/Zillow page) | Yes (`ANTHROPIC_API_KEY`) | Sent to the model, which reads the page layout |
| **MLS sheet / flyer PDF** | No | Regex over the text layer; falls back to the model only if it finds too little |
| **Screenshot** (PNG/JPEG/GIF/WebP) | Yes | Downsampled to 2576px, sent as an image |

Printed web pages are routed to the model on purpose. They are ten pages of site
chrome, plat maps, payment calculators and *other properties'* comps, and text
matching picks the wrong numbers out of that with no way to know it did — in
testing it read a survey label `8729SF` as living area and a calculator's monthly
tax as the annual bill. Only the first three pages are sent, since the facts are
at the top and the rest is comps that cost tokens and mislead. Roughly 2-4c per
upload; MLS sheets stay free.

Without an Anthropic key, printed pages still parse but are flagged as low
confidence — check every value.

### Additional Data Sources

| Feature | Source | Notes |
|---------|--------|-------|
| **Mortgage Rate** | [Freddie Mac PMMS](https://www.freddiemac.com/pmms) | Current 30-year fixed rate, cached 6 hours |
| **Rent Estimates** | RentCast AVM, else Redfin rentals | Property-specific estimate with a low/high range; falls back to scraped rental comps |
| **Per-listing rent** | RentCast `/markets` | Per-bedroom rent and rent/sqft for a zip, so each listing is priced by its own size |
| **Property tax rate** | RentCast `/properties`, else state table | Local effective rate from real assessment records |
| **Vacancy rate** | RentCast `/markets` | Derived from the zip's median rental days-on-market; no extra request |
| **Appreciation rate** | [FHFA House Price Index](https://www.fhfa.gov/data/hpi) | Per-ZIP repeat-sales index shipped in `data/`. No API key, no network call, no request cost |
| **Insurance** | [insurance.com](https://www.insurance.com/home-and-renters-insurance/home-insurance-basics/average-homeowners-insurance-rates-by-state) 2026 state averages | Per $300K dwelling coverage, rated against the property's own rebuild cost |
| **Neighborhood Search** | Redfin search API | Structured JSON from `stingray/api/gis` endpoint |

### Property value growth

Appreciation is the largest line in a five-year return and used to be the last
input still using a flat national guess. It now comes from the ZIP code's own
price history, and it is presented as a range rather than a single curve.

**Where the rate comes from.** The [FHFA House Price
Index](https://www.fhfa.gov/data/hpi) — a *repeat-sales* index, built from the
same houses transacting more than once, so it measures what an individual
property does over time. A median sale or list price moves with whatever
happened to come on the market that month, which is a different and much
noisier quantity. The tables in `data/` cover ~15,000 ZIP codes over the last
30 years and ship with the repo: no API key, no network call, no request cost.

The cascade is ZIP → state → US median. A ZIP's rate is blended toward its
state average (70/30 with 25+ years of history, 50/50 below that), because one
ZIP over one window is a small sample, and capped at 8%/yr — compounding a
historical outlier for thirty years produces fantasy, not a forecast.

**Both figures are always on screen.** The headline reports the conservative base
case and, directly beneath it, what the same deal returns if the ZIP repeats its
measured history — so the cautious default never hides the upside.

**The default is not the historical rate.** Projections run at ~2.5%/yr — roughly
long-run inflation — rather than at what the area averaged. A rate measured over
1995–2025 is what a market *did*, and that window contains a long decline in
mortgage rates that cannot repeat. Underwriting near inflation forces the deal to
work on cash flow and leaves real appreciation as upside. Local history is not
discarded: it drives the range, the worst case, the Historical scenario, and it
lowers the default further in the ~3% of ZIPs that did worse than 2.5%.

**Four what-if scenarios.** One click reruns every number below it — cash flow,
deal score, exit math, ROI:

| Scenario | For ZIP 95337 | What it is |
|---|---|---|
| Downturn | −10.9%/yr | Weakest 10% of five-year windows |
| **Conservative** (default) | **2.5%/yr** | Near inflation |
| Historical | 4.4%/yr | What this area averaged |
| Strong | 13.0%/yr | Strongest 10% of five-year windows |

Typing your own rate drops out of scenario mode and says so. The same
$700K property swings from −$334,636 to +$403,561 of net appreciation across
that range, which is the point: appreciation is the assumption worth stress-testing.

**The band matches your holding period, and that matters enormously.** Percentile
bands are built from overlapping windows the same length as the hold, because a
five-year spread says nothing useful about a fifteen-year one. Time collapses
the risk:

| ZIP 95337 (Manteca) | 10th percentile | Worst window on record |
|---|---|---|
| 5-year hold | −11.2%/yr | **−59.3%** |
| 10-year | −3.3%/yr | −30.0% |
| 15-year | **+0.6%/yr** | −4.8% |
| 20-year | +2.8%/yr | +30.2% |

Bands stop at 20 years: with ~31 annual observations there are only 11
overlapping 20-year windows and a single 30-year one, which is not a
distribution. A 30-year hold reuses the 20-year band and the app says so.

**The worst case is stated outright.** ZIP 95337 averaged 4.2%/yr since 1995 —
and still lost 59% of its value in its worst five-year window. A point estimate
cannot express that, so the app names it in dollars at your purchase price.

*A note on percentiles:* the 5-year window distribution is left-skewed, so a
median or p25 is *higher* than the geometric mean in volatile markets (95337's
p25 is 5.7% against a 4.2% mean). The mean already carries the compounding drag
of a crash; percentiles do not. That is why the conservative default is an
inflation anchor and not a low percentile.

**What selling costs you.** The sale path is deliberately pre-income-tax and
shows only transaction economics:

```
sale price
  − selling costs          (7% default: commission, title, escrow, transfer)
  − loan payoff
  = pre-tax net sale proceeds
```

Pre-tax profit then adds cumulative operating cash flow and subtracts the full
initial cash investment. Income-tax effects are not estimated or mixed into the
cash-flow vector. The optional depreciation figure is context only and changes
no underwriting result.

**A consistency check you will see.** If value growth outruns rent growth, the
price-to-rent ratio expands every year — a large unstated bet that cap rates
keep compressing. The app now says so rather than compounding it quietly.

**Refreshing the data.** FHFA updates the index quarterly. To rebuild:

```bash
pip install -r requirements-dev.txt
python tools/build_hpi_table.py
```

It downloads ~40 MB, rewrites `data/hpi_zip5.json.gz` (~200 KB) and
`data/hpi_state.json.gz`, and aborts if FHFA has changed the column layout
rather than emitting silently shifted numbers. Output is byte-identical across
runs, so an unchanged upstream produces no diff. `openpyxl` is only needed for
this step and is deliberately kept out of `requirements.txt` — the app reads the
committed tables and never parses a workbook.

---

### Insurance

Rated on **dwelling coverage** — what it costs to rebuild the structure — not on
purchase price. Land is not insured, so a share of price is the wrong basis and
fails hardest exactly where land is expensive: the same house needs similar
coverage in California and Ohio while its market price differs threefold.

```
premium = state average at $300K coverage
          x (rebuild cost / $300,000) ^ 0.65     premiums rise slower than coverage
          x 1.15                                 landlord policy vs owner-occupied
```

State figures are 2026 averages at $300,000 dwelling coverage with a $1,000
deductible. Without square footage there is no rebuild cost to rate against, so
coverage falls back to a crude share of price and the note says so.

**On comparing against listing-site calculators:** they disagree with each other
far more than either disagrees with this app. For 728 Villa Ticino, Redfin's
payment calculator shows $123/mo; BiggerPockets' equivalent on a comparable
California property implies $507/mo — a 4x spread. Both are flat-percentage
placeholders, not quotes. This app lands at $205/mo for that property, between
them and derived from state averages. Get a real quote before committing; the
field is editable and a manual figure is never overwritten.

### Repair reserves

Maintenance and CapEx are sized off the **building**, not the rent, because a
roof does not cost less in a cheap market. A flat percentage of rent
under-reserves wherever rent is low relative to construction cost — which is
exactly where a screener is most likely to report a strong deal.

```
reserve/yr = sqft x construction cost/sqft x 1.4% x age factor
age factor:  <=10yr 0.55 · <=25 0.80 · <=50 1.00 · <=80 1.15 · 80+ 1.30
```

The rate comes from a component build-up rather than a rule of thumb — roof,
HVAC, water heater, appliances, flooring, exterior paint, windows, plumbing,
electrical and site work, each at replacement cost over its service life. That
totals about 0.94% of build cost a year for a mid-life house, with routine
maintenance adding roughly another 0.5%.

**Two items are deliberately excluded from that build-up.** Interior paint is
turnover work already carried by the maintenance line, and a periodic
kitchen/bath refresh is value-add rehab rather than a routine reserve. Counting
them inflated CapEx by about 23%, which is why the rate is 0.9% and not the
1.1% the raw build-up implied.

As a cross-check the result lands below the classic "1% of property value per
year" rule on an expensive house and above it on a cheap one, which is the
intended correction.

**Regional cost is damped by half.** Shingles, water heaters and appliances are
national commodities; only labour is really regional, and much of the headline
gap in expensive states is land, permitting and regulation that never shows up in
a roof replacement. Applying California's full $215/sqft would assume a CA roof
costs 33% more than a Texas one. The table blends halfway to the national
average instead, so CA enters at $188.

Both figures are shown as a percentage of rent, badged, annotated with what drove
them, and fully editable. `sqft` and `yearBuilt` both come from the listing, so
this costs no extra typing — and when either is missing it degrades to an
age-only table and then to the old flat 5%.

---

### RentCast (optional)

Set `RENTCAST_API_KEY` to replace the app's weakest inputs with real data.
Everything works without it — the app falls back to Redfin scraping and
state-average rates.

- **Per-listing rent.** Search results are scored against a rent estimated from
  each listing's own bedroom count and size, instead of one figure applied to
  every row. With one rent for all rows, cash flow, the 1% rule and GRM all
  become monotonic in price and the ranking collapses into "cheapest first".
- **Local tax rates.** The effective rate is derived from real assessment
  records in the zip, which picks up county and special-district levies
  (Mello-Roos) that a state average misses — 1.49% vs the 1.15% CA average in
  one Manteca zip, a $2,300/yr difference on a $669K home.
- **Rent AVM** on the property you open, with a low/high range. The range is the
  underwriting signal: does the deal still work at the low end?
- **Vacancy from local re-let speed.** Vacancy is turnover time, so it is
  derived from the zip's median rental days-on-market rather than assumed flat:
  `(days_on_market + 14 prep days) / (730 day tenancy + that gap)`, floored at
  4% and capped at 25%. A zip where rentals sit 154 days implies ~19% vacancy;
  one where they go in 10 days floors at 4%. It reuses the same cached market
  call as the rent estimate, so it costs no extra requests.

**Property management is not localized, and cannot be.** RentCast returns no
management pricing, and no API publishes it by zip — it is a vendor quote that
varies by company, door count and what is bundled. It stays a flat 10%
assumption; get two or three local quotes and enter the real number. Note also
that the leasing fee charged on turnover (typically half to a full month's rent)
is not modelled at all, which understates cost in a high-turnover market.

**Tax is rate-driven, not bill-driven.** A sale reassesses the property at
roughly the purchase price, so the estimate is `purchase price x local rate`. Any
tax found on the listing is shown separately as context ("current owner pays
$X/yr"), because under an assessment cap like California's Prop 13 the seller's
bill can understate yours by thousands a year.

**Spending past the limit.** "Spend 1 request" authorizes that one call — you do
not need to tick "don't ask again" for it to work. The checkbox only stops the
prompt reappearing for the rest of the session, and it is never persisted.

**Quota.** The free tier is 50 requests/month with a per-request overage fee
beyond that, so the app never silently spends past ~90% of the limit and never
silently degrades — it stops and asks, offering the free zip-level estimate or
one paid request. Zip-scoped data is cached to disk for 24 hours, so restarting
the app does not re-buy statistics it already has. A counter in the UI shows
usage. Typical cost is one request per zip explored plus one per property you
analyse in depth.

---

## Neighborhood Search

Search an entire zip code or city to **discover** investment deals — not just analyze ones you already know about.

### How It Works

1. Click **Neighborhood Search** on Step 1 (the toggle next to "Single Property")
2. Enter a **location** (zip code like `78701` or city like `Austin, TX`)
3. Enter your **target monthly rent** for the area (what you'd charge a tenant)
4. Optionally set filters: price range, min beds, property type
5. Click **Search Listings** — the app loads Redfin's search page and extracts all active listings
6. Results appear in a sortable table with a **Quick Score** for each listing
7. Click **Analyze →** on any listing to switch to the full single-property wizard with data pre-filled

### Search Filters

| Filter | Required | Default | Notes |
|--------|----------|---------|-------|
| Location | Yes | — | Zip code (e.g. `78701`) or city + state (e.g. `Austin, TX`) |
| Min Price | No | None | Set a floor to skip low-quality inventory |
| Max Price | No | None | Your budget cap |
| Min Beds | No | Any | Investors typically want 2+ bedrooms |
| Property Type | No | Any | House, Condo/Townhouse, or Multi-family |
| Override Rent | No | Auto | Leave blank to estimate rent per listing. Set it to force one figure onto every row |
| Max Results | No | 20 | 10, 15, 20, or 25 |

### Quick Score (6 Stars)

Each listing is scored on six investor checks, aligned with the full [14-point scorecard](#deal-scorecard-14-point-system) so high quick scores reliably predict good full-analysis results:

| Check | ★ Condition | What It Tells You |
|-------|-------------|-------------------|
| **Est. Cap Rate** | >= 6% | Decent return after estimated expenses |
| **Est. DSCR** | >= 1.25 | NOI comfortably covers debt service |
| **Est. Cash Flow** | >= $100/mo | Positive cash flow after mortgage |
| **1% Rule** | rent/price >= 1% | Rent high enough relative to price |
| **GRM** | <= 12 | Low price relative to annual rent |
| **Est. Total Return** | >= 10% yr1 | Strong combined return (CF + appreciation + equity). Appreciation is the listing's own ZIP rate, held near inflation — not a flat 3% |

Stars are color-coded: **5-6 = green** (strong deal), **3-4 = yellow** (borderline), **1-2 = red** (weak), **0 = gray** (doesn't pass any check). Each check also has a numeric score (0-100) for ranking.

> **Where the rent comes from.** With `RENTCAST_API_KEY` set, each listing is
> scored against a rent estimated from its own bedroom count and square footage,
> and the row shows the sample size behind it. Without a key, enter an Override
> Rent — but note that one rent across every row makes cash flow, the 1% rule and
> GRM pure functions of price, so the ranking becomes "cheapest first" rather
> than a comparison of deals. Rows say which rent they used.
>
> Rent does not scale linearly with size: in one real zip 1-bed units rent at
> $2.53/sqft against $1.35/sqft for 4-beds. The estimate anchors on the bedroom
> class median and damps the size adjustment, then clamps to the range that
> class actually rents for.

### Analyze → Full Wizard

When you click **Analyze →** on a search result:

1. The app switches to **Single Property** mode
2. The Redfin listing URL is set and a full scrape runs automatically
3. Price, address, sqft, year built, and every dependent field (closing costs, tax, insurance, vacancy, maintenance, CapEx, appreciation) are pre-filled and badged with their source
4. You continue through the 6-step wizard as normal — add loan details, rent, expenses, then get full results

### Deal Alerts

Click **Deal Alerts** in the toolbar above search results to set thresholds:

| Filter | Default | What It Does |
|--------|---------|-------------|
| Min Stars | 2+ | Only highlight listings with this many quick score stars |
| Max Price | — | Budget cap |
| Min Beds | — | Minimum bedrooms |

Listings that match all criteria get a green **"Match"** badge and highlighted row. Preferences are saved to localStorage.

### Export CSV

Click **Export CSV** to download all search results as a spreadsheet with columns: Address, Price, Beds, Baths, Sqft, Quick Score, 1% Rule, Est. Cap Rate, Est. Cash Flow, and Listing URL.

### Saved Filters

Search filters (location, price range, beds, property type, rent, max results) are automatically saved to localStorage and restored when you return.

### Rate Limits

Neighborhood Search is limited to **3 searches per minute** to avoid overloading Redfin. If you hit the limit, wait 60 seconds and try again.

### Smart Price Cap

Smart Deal Finder calculates a maximum property price from median market rent to focus on listings that could actually pencil out as investments. The formula is:

```
smart_max_price = median_rent × 250    (rounded up to nearest $25K, min $75K)
```

The multiplier (250) corresponds to a GRM of ~20.8 — the upper bound of "worth analyzing" for rental investments. Here's how different multipliers translate:

| Multiplier | Implied Rent/Price | GRM | Example ($1,127 median rent) |
|---|---|---|---|
| 100 | 1.00% | 8.3 | $112,700 (strict 1% rule) |
| 150 | 0.67% | 12.5 | $169,050 |
| 200 | 0.50% | 16.7 | $225,400 |
| **250** | **0.40%** | **20.8** | **$281,750 (current default)** |
| 300 | 0.33% | 25.0 | $338,100 |

At current ~6-7% mortgage rates, almost nothing meets the 1% rule. The 250 multiplier balances showing enough listings to find deals while filtering out properties where the numbers can never work. Properties above this cap are almost certainly negative cash flow with no path to viability.

> **To change the multiplier:** Edit `smart_max_price = int(best_rent * 250)` in `app.py` (search for "smart_max_price"). Lower = stricter filtering, higher = more results.

### Known Limitations

- **Redfin only** — Zillow blocks automated search pages too aggressively
- **Cloud servers blocked** — Redfin blocks datacenter IPs; search features require running locally
- **No map view** — results are table-only for now
- **One search at a time** — no batch analysis of multiple listings simultaneously
- **City search** requires Redfin to recognize the city name — use zip codes for best reliability
- **A city spans several zips** with different rent profiles; each listing is scored against its own zip, capped at 3 zip lookups per search to protect the RentCast quota
- **Screenshots and printed listing pages need an Anthropic key** — there is no local-model path for extraction, because a small model that invents a bedroom count is worse than no answer
- **Rehab remains an assumption** — nothing auto-fills it
- **Insurance is a state average, not a quote** — it cannot see wildfire or flood zones, claims history, roof age, or the CA FAIR Plan. Sonoma County and inland California get the same number, which is wrong in a way no state-level table can fix
- **Replacement cost is estimated, not appraised** — maintenance and CapEx are sized from state-average construction cost per square foot, damped halfway toward the national average. Only the national figure ($162/sqft, NAHB) and a few state anchors are measured; the rest of the table is regional interpolation. A single state figure also cannot tell inland from coastal, so California is one number for both Manteca and Palo Alto
- **Age is a crude proxy for condition** — a renovated 1920s house and a neglected one get the same reserve. Year built is the only condition signal a listing reliably provides
- **Appreciation is measured backwards** — the FHFA rate is what a ZIP did over the last 30 years, not a forecast. That window contains a full boom and crash, but also a long decline in mortgage rates that will not repeat. This is why the default underwrites near inflation instead; the range is the honest part
- **~4,000 ZIP codes have no FHFA index** — FHFA omits areas with too few repeat sales, so those fall back to the state rate
- **Income taxes are excluded** — depreciation savings, passive-loss treatment, capital-gains tax, depreciation-related tax, state tax and 1031 exchanges require taxpayer-specific analysis

---

## Support the Project

If this tool helped you evaluate a deal, consider supporting its development:

<a href="https://buymeacoffee.com/bkapu">
  <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee" />
</a>

Your support helps keep this project free and actively maintained.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run locally and submit PRs.

## License

[MIT](LICENSE) — free to use, modify, and distribute.
