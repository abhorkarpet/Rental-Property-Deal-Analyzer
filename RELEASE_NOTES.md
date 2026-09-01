# Release Notes

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
