# Release Notes

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
