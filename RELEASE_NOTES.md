# Release Notes

## v3.4.1 — September 9, 2026

- Prefill HUD state and ZIP from the current property, retain manual corrections in drafts, and clear stale geography when properties change.
- Clarify HUD lookups for city/ZIP-only listings, require a county when using manual state selection, and prevent lookup while the county list is loading.
- Keep the current property address visible in the sticky navigation throughout analysis, including Income, Expenses, Review, and Results. The address follows edits and restored scenarios and clears for a new property.

## v3.4.0 — September 9, 2026

- Added Cash flow, Hybrid (default), and Appreciation profiles with editable targets, shared underwriting, and automatic re-scoring across search, batch, analysis, and comparison. Drafts and scenarios retain preferences.
- Added continuous weighted factors, scoring growth caps, no-appreciation IRR, downside analysis, and score ceilings for unfunded losses, limited rent evidence, and missing costs.
- Fixed mortgage payments after payoff and zero-interest quick screens omitting principal repayment.
- Replaced hidden Smart Deal Finder price heuristics with an optional explicit maximum price.
- Updated CSV exports and added scoring, persistence, comparison, and search-filter regressions.

## v3.3.0 — September 9, 2026

- Added server-side HUD FMR/SAFMR API support with cached, explicit fiscal-year lookups and a local-only token configuration.
- Added Census address geography resolution and manual HUD county/town selection. Exact ZIP benchmarks take precedence over area-level benchmarks when available.
- Added HUD benchmarks alongside search market rents without changing scores or rent inputs.
- Added a Rental Income lookup panel with explicit tenant-paid utility deductions before applying HUD rent. Saved scenarios retain the benchmark and adjustment.
- Added error handling for missing data, bad credentials, mismatched years, unmatched addresses, and delayed lookups. Large-bedroom derived values and future fiscal years are labeled.

## v3.2.1 — September 9, 2026

- Fixed Neighborhood Search and Smart Deal Finder treating minimum bedrooms as an exact rental filter and omitting the selected house type.
- Match Redfin asking rents by exact bedrooms, and within 25% of floor area when at least three comparable rentals are available. Use a conventional median and report the actual matched sample count.
- Leave unmatched homes without a Redfin rent instead of borrowing the closest bedroom group. Retain the bounded RentCast ZIP fallback, without substituting a different ZIP when data is unavailable.
- Display rent method, sample count, and confidence; label manual overrides. Refresh searches saved under the old estimation method.
- Added regression coverage for mixed bedroom searches, size matching, missing comps, ZIP fallback, manual overrides, and old saved results.

## v3.2.0 — September 9, 2026

- Replaced property-specific state consistently across listing URLs, uploads,
  search and batch analysis. Zero HOA and missing fields no longer inherit the
  previous property's values. Older estimate responses cannot overwrite a newer
  property.
- Applied confirmed upload property types and required per-unit rents for
  multifamily underwriting.
- Saved complete scenarios, including unit rents and source metadata. Added
  independent scenario names and Save as New. Comparisons recalculate saved
  inputs over a common selected holding period.
- Added local draft recovery for current inputs, searches, batch inventory,
  shortlist/incentive selections and unapplied What-If edits. Clearing the
  workspace leaves saved scenarios intact.
- Bound AI commentary to its input snapshot. Changes clear stale commentary,
  cancel in-flight analysis, and expose incomplete-stream errors.
- Made HTML reports self-contained with embedded styles and an input/source
  snapshot, removing controls that cannot work offline.
- Added import previews with recognized columns, sample rows and skipped-row
  counts. Batch rows show checking status and before/after property estimates.
- When the market mortgage-rate lookup is unavailable, batch screening uses
  the entered rate (or an explicit 7% default), rather than silently assuming 0%.
- Added mobile batch cards, shortlist filtering, explicit market/seller labels,
  readable search metrics, expandable screening reasons and ranking assumptions.
- Moved property type into the first step, grouped investment assumptions, added
  manual entry, input confidence/source summaries and editable stress presets.
- Added accessible field errors, focus management, status announcements and a
  keyboard-accessible comparison dialog.
- Fixed Docker's runtime file set, installed matching Playwright system
  dependencies, honored PORT, excluded local secrets/caches from the build
  context, and added a Docker image/HTTP smoke job to CI.

Older multifamily scenarios did not contain unit rents. Load them, enter the
missing rent roll, and save again before comparing. Drafts and scenarios remain
local to the browser/device; they are not cloud backups.

## v3.1.1 — September 1, 2026

- Fixed **Verify & Analyze** unexpectedly advancing Batch Review deals directly
  to Loan. Verified deals now land on the populated Property page so the user
  can inspect the address, price, listing facts, and automatic assumptions
  before continuing.
- Kept **Back to Batch Review** visible on that Property page, preserving the
  imported inventory and its scroll position.

## v3.1.0 — September 1, 2026

- Reorganized the app around three persistent workspaces: **Analyze Property**,
  **Find Deals**, and **Batch Review**. Batch inventory is no longer hidden
  under Smart Deal Finder.
- Kept the six-step wizard local to a property analysis, while Neighborhood
  Search and Smart Deal Finder now share a focused Find Deals sub-navigation.
- Added URL-backed navigation so browser Back and Forward move between
  workspaces, analysis steps, and Summary / What-If / Full Details views.
- Added origin-aware analysis controls. A deal opened from Neighborhood Search,
  Smart Deal Finder, or Batch Review can return to that exact workspace without
  discarding its imported or discovered results.
- Added an explicit **Analyze Another** action that clears the current property
  and automatic estimates while keeping batch/search results and investor-level
  assumptions.
- Made the primary workspace navigation sticky and responsive so Batch Review
  and Find Deals remain reachable from Results and on smaller screens.

## v3.0.11 — August 31, 2026

- Fixed Redfin rent estimates that could accidentally use unrelated
  **Willing to be flexible** cards despite an exact bedroom filter. The Fort
  Morgan failure was a one-bedroom $800 listing and a two-bedroom $1,100
  listing being treated as three-bedroom evidence.
- Added a second parser for Redfin's accessible primary-results text, excluded
  suggestions after **End of results**, and revalidated bedrooms and reasonable
  square-footage proximity after scraping.
- Single-family analyses now use Redfin's house-rental route and compute a true
  even-sample median. The current Fort Morgan 3-bedroom evidence resolves to
  $1,850–$2,100 with a $1,975 median.
- Batch Review caches rent evidence by ZIP, bedroom count, and property type,
  preventing one unfiltered ZIP median from being applied to dissimilar deals.
- A brochure's **Leased** label remains visible as a seller claim but no longer
  overrides independent market rent unless the lease is explicitly verified.

## v3.0.10 — August 31, 2026

- Fixed **Verify & Analyze** so a brochure-sourced rent on a leased property is
  retained as the underwriting input instead of being overwritten by RentCast.
- RentCast is still called for exact-address verification and its low, estimate,
  and high values remain visible as market comparisons.
- Vacant or unleased brochure asking rents can still be replaced by the automatic
  market estimate, and users can click any displayed comparison to use it.
- Added brochure coverage for the Fort Morgan example's $2,495 leased rent,
  $78,000 headline cash requirement, $900 rent credit, and Year-1 free PM.

## v3.0.9 — August 31, 2026

- Renamed **Annual Expense Growth** to **Annual Fixed-Expense Growth** in the
  expense form, review page, glossary, and What-If workspace.
- Added visible guidance that it applies only to insurance, HOA, utilities, and
  other fixed expenses.
- Clarified that maintenance, vacancy, CapEx, and management already grow with
  projected rent, while property tax follows its separate state/local policy.
- Added regression coverage proving fixed-expense growth neither compounds the
  rent-percentage expenses nor changes property-tax projections.

## v3.0.8 — August 31, 2026

- Replaced the opening-run-rate-only 14-point verdict with a balanced 100-point
  score: 60 points for **Income Safety** and 40 points for selected-hold
  **Performance**.
- Income Safety uses stabilized CoC, cap rate, DSCR, cash flow per unit, and
  break-even occupancy. Performance uses after-sale pre-tax IRR, average annual
  operating CoC, and the percentage of held years with positive cash flow.
- Kept the 1% and 50% rules as visible diagnostics but removed them from the
  weighted verdict because they duplicate stronger underwriting measures.
- Applied the identical calculation engine to ZIP-enriched Batch Review rows;
  batch scores remain clearly labeled market-screen estimates until **Verify &
  Analyze** replaces ZIP assumptions with property-specific inputs.
- Seller ROI and tax-benefit claims never enter either score. Timed PM/rent
  incentives affect only their applicable projection years, while the Income
  Safety component continues to use stabilized recurring operations.
- Renamed **CF per Unit (Monthly)** to **Stabilized CF / Unit (Monthly)**.

## v3.0.7 — August 31, 2026

- Corrected projection timing so entered rent and ordinary operating expenses
  are the Year-1 run rate; their growth assumptions now begin in Year 2.
- Kept end-of-year property appreciation and amortization timing unchanged.
- Renamed **Total Monthly Expenses** to **Operating Expenses (excl. P&I)** and
  explained that tax and insurance overlap with the PITI card.
- Renamed projection **Cumulative ROI** to **Unrealized ROI** and disclosed that
  it includes cash flow, appreciation, and debt paydown before selling costs;
  selected-hold exit profit and IRR continue to include selling costs.
- Added regression coverage for Year-1/Year-2 rent timing, PM incentive savings,
  and the clarified result labels.

## v3.0.6 — August 31, 2026

- Added **Gross Rent**, **PM Expense**, and **One-Time Credits** to every row of
  the hold-period projection.
- PM expense is net of any active promotion and returns to the stabilized rate
  after the stated promotional month; rent credits appear only in their
  applicable year.
- Added a projection note comparing the seller's monthly cash-flow and rent
  claims with the independently recalculated model.
- Batch **Verify & Analyze** now initializes an unstated PM assumption to the
  ZIP-screen rate or an editable 8% stabilized default instead of retaining a
  stale value from a previously analyzed property.

## v3.0.5 — August 31, 2026

- Added an optional LLM fallback for brochures whose wording or layout leaves
  material gaps after deterministic parsing.
- The fallback uses the configured LM Studio, Ollama, or Anthropic provider,
  requires short evidence copied from the brochure, rejects low-confidence or
  unsupported values, and never overwrites deterministic extraction.
- Model failure is non-blocking, calls are limited to two concurrent brochures,
  and successful structured extractions are cached for 24 hours.
- Added `BROCHURE_LLM_PARSER=off` to disable the fallback and
  `BROCHURE_LLM_MODEL` for an optional extraction-model override.

## v3.0.4 — August 31, 2026

- Added brochure extraction for PM promotions expressed as a percentage and
  duration, including `0% PM for 2 years`.
- Added explicit one-time rent-credit and purpose-bound closing-credit types.
- **Verify & Analyze** now carries structured brochure incentives into the
  pure calculation engine and saved scenarios.
- PM discounts affect only their stated months, rent credits enter Year 1 once,
  and closing credits reduce only eligible acquisition costs. Recurring rent,
  stabilized NOI, and stabilized monthly cash flow remain uninflated.
- Added visible applied-incentive summaries on the property, review, and results
  screens, including unused closing-credit disclosure.

## v3.0.3 — August 31, 2026

- Added `restart_app.sh` for a one-command local restart using the project
  virtual environment.
- The script verifies that any listener on port 8000 belongs to this project
  before stopping it, and refuses to kill unrelated processes.

## v3.0.2 — August 31, 2026

- Kept the Batch Review action column pinned to the right so it remains visible
  without scrolling to the bottom and then horizontally across a long list.
- Restored the clearer **Verify & Analyze** label for the property-specific
  RentCast and full-underwriting action.
- Versioned the served CSS and JavaScript URLs so a regular page refresh loads
  the matching release assets after the backend is restarted.

## v3.0.1 — August 31, 2026

This refinement makes the Batch Review distinction explicit: seller columns
remain claims, ZIP estimates provide a comparable market pre-screen, and each
row can launch a property-specific detail analysis.

### Highlights

- Added **Run ZIP Estimates**, grouping the inventory by ZIP so repeated deals
  reuse the same data instead of making duplicate provider calls.
- ZIP screening prefers free Redfin active-rental medians. RentCast market data
  fills missing rent or days-on-market, while its persisted 24-hour cache is
  shared across rows and restarts.
- Added ZIP tax records, local vacancy, rebuild-cost insurance, age/size-based
  maintenance and CapEx reserves, FHFA appreciation, and the current mortgage
  rate to the batch pre-screen.
- Added market rent, monthly cash flow, cash-on-cash, cap rate, and DSCR columns.
  The screen discloses its 25% down, 3% closing-cost, 30-year financing defaults
  and the property-specific costs still missing.
- Renamed each row action to **Analyze Details**. Exact-address rows explicitly
  request a property-specific RentCast AVM before the normal Redfin fallback,
  then continue through the full automatic tax, insurance, vacancy, reserve,
  appreciation, and editable underwriting workflow.
- Expanded Batch Review CSV exports with every market input and result.

### Quality and verification

- Added market-screen calculation, ZIP grouping/provider reuse, and explicit
  property-AVM routing tests.
- Release verification: 58 Python/API/browser tests and the JavaScript
  calculation suite pass.

## v3.0.0 — August 30, 2026

Version 3 adds Batch Review to Smart Deal Finder so seller inventories can be
screened without mixing first-year promotions, ten-year projections, and
stabilized operating returns.

### Highlights

- Added a separate **Import Deal List** workspace inside Smart Deal Finder,
  keeping batch review off the main single-property path and Results page.
- Added CSV and public Google Sheet imports with flexible header mapping,
  formatted-number normalization, duplicate `Type` column handling, and a
  200-deal safety limit.
- Google Sheet imports use the native workbook export so hyperlinks hidden
  behind cells such as `Brochure` remain attached to the correct deal.
- Preserved seller ROI, cash flow, and required cash as explicit claims rather
  than feeding them into the authoritative calculation engine.
- Read workbook-level ROI footnotes so non-promotional rows can be labeled as
  ten-year projections while incentive/tax rows remain first-year promotions.
- Added comparable Year-1 and stabilized cash-on-cash screens. Temporary
  property-management discounts now expire on schedule instead of being
  projected forever.
- Added structured incentive choices for cash back, closing credits,
  unallocated seller funds, rate buy-downs, management discounts, and estimated
  tax benefits. Tax estimates are always excluded from the core score.
- Added optional linked-Google-Doc brochure augmentation for rent, size,
  bedrooms, bathrooms, year built, rental status, completion status,
  neighborhood-class claims, and incentive terms.
- Added conflict detection when a brochure quotes different seller-fund
  amounts, and tightened rate extraction so unrelated percentages cannot be
  mistaken for a mortgage buy-down.
- Added a concise sortable summary table, explicit ROI-basis and confidence
  labels, selected-incentive cash-to-close calculations, and normalized CSV
  export.
- Added **Verify & Analyze** handoff to the existing full analyzer. This reuses
  the same Redfin-first/RentCast-fallback rent, property-tax, insurance,
  vacancy, maintenance, CapEx, and appreciation hydration as every other entry
  path; the stabilized management rate follows the deal into the wizard.

### Quality and verification

- Added batch parser, workbook hyperlink, safe URL, brochure, incentive,
  stabilization, API-contract, and browser workflow tests.
- Verified the importer against the referenced RTR workbook: 47 priced deals
  and all 47 linked brochures are preserved.
- Release verification: 55 Python/API/browser tests and the JavaScript
  calculation suite pass.

### Upgrade note

Install the updated requirements, restart the Python server, and hard-refresh
the browser. `openpyxl` is now used to preserve native Google Sheet links.

## v2.3.5 — August 30, 2026

This release completes the analyzer refactor and makes automatic property data
consistent across Single Property, Neighborhood Search, and Smart Deal Finder.

### Highlights

- Separated the browser UI, reusable deal calculations, provider integrations,
  request schemas, and search orchestration into focused modules.
- Simplified Results into three focused views: Summary, What-If, and Full
  Details. What-If is now attached to a completed analysis instead of appearing
  as a separate main-page workflow.
- Unified listing hydration so every entry path refreshes rent, property tax,
  insurance, vacancy, maintenance, CapEx, appreciation, and mortgage-rate
  assumptions with the same logic.
- Added law-aware property-tax projections and explicit source labels for local
  assumptions.
- Made Redfin the preferred free rent source, with RentCast property AVM and
  ZIP-market fallbacks when additional data is needed.
- Added persistent 24-hour caches for RentCast property rent, ZIP market, and
  ZIP tax results, plus coalescing for duplicate browser requests.
- Made RentCast's soft monthly limit non-blocking for localhost while preserving
  the optional hard limit and displaying the current request count.
- Derived vacancy from property rental comparables when available. If Redfin
  supplies rent but omits days on market, vacancy now falls through to cached,
  bedroom-specific RentCast ZIP data instead of silently remaining at 8%.
- Added robust Zillow/Redfin page fetching and PDF or screenshot fallbacks for
  blocked listing pages.
- Pretty-formatted dollar inputs without changing stored calculation values.

### Quality and verification

- Added backend contracts, provider fallbacks, search-service tests, property-
  tax policy tests, version enforcement, and Playwright browser coverage.
- Browser tests cover Single Property, Neighborhood Search, Smart Deal Finder,
  Summary/What-If/Full Details, scenarios, comparison, exports, AI streaming,
  mobile layout, and print layout.
- Release verification: 44 Python tests and the JavaScript calculation suite
  pass.
- GitHub Actions runs the Python and JavaScript test network on pushes and pull
  requests.

### Upgrade note

Restart the Python server after updating, then hard-refresh the browser. The
API routes and provider modules are loaded when `app.py` starts.
