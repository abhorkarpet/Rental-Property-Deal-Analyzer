"""End-to-end browser coverage for every entry path and Results workflow."""

import json
import socket
import threading
import time
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import urlopen

import pytest
import uvicorn
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

import app as app_module


pytestmark = pytest.mark.browser


LISTING = {
    "address": "101 Test Ave, Austin, TX 78701",
    "price": 300_000,
    "beds": 3,
    "baths": 2,
    "sqft": 1500,
    "yearBuilt": 1985,
    "propertyType": "Single Family",
    "estRent": 2250,
    "rentSource": "rentcast_market",
    "annualTax": 4200,
    "hoaFee": 35,
}


def _response_payloads():
    policy = {
        "model": "market_value",
        "label": "Projected market-value reassessment",
        "detail": "Projected from acquisition value using the selected growth rate.",
        "annual_cap_pct": None,
        "reassesses_on_sale": True,
        "coverage": "general",
        "as_of": None,
        "source_url": None,
        "source_label": None,
    }
    appreciation = {
        "conservative_pct": 2.5,
        "rate_pct": 4.2,
        "low_pct": -1.0,
        "high_pct": 8.0,
        "worst_pct": -10.0,
        "band_years": 10,
        "source": "fhfa_zip",
        "label": "ZIP 78701",
        "window": "1995–2025",
    }
    return {
        "/api/rentcast-usage": {
            "configured": False, "anthropic": False,
            "count": 0, "limit": 50, "remaining": 50, "month": "2026-08",
        },
        "/api/models": {
            "provider": "test", "models": [{"id": "test-model", "name": "Test model"}],
            "current": "test-model",
        },
        "/api/search": {
            "listings": [dict(LISTING)], "total": 1,
            "location_label": "Austin, TX 78701", "appreciation": appreciation,
        },
        "/api/smart-search": {
            "listings": [dict(LISTING)], "total": 1,
            "location_label": "Austin, TX 78701",
            "rent_stats": {"count": 16, "median": 2250, "low": 1900, "high": 2700},
            "rent_by_beds": {"3": 2250}, "smart_max_price": 575_000,
            "rent_confidence": "high", "mortgage_rate": 6.5,
            "appreciation": appreciation,
        },
        "/api/rent-estimate": {
            "estimate": {
                "rent": 2350, "rent_low": 2200, "rent_high": 2500,
                "source": "rentcast_avm", "label": "Test property estimate",
            },
            "vacancy": {
                "rate_pct": 5.5, "source": "market",
                "label": "local rentals let in ~29 days",
            },
            "usage": {"count": 1, "limit": 50, "remaining": 49},
        },
        "/api/tax-rate": {
            "tax": {"rate": 0.0168, "annual": 5040, "source": "zip", "label": "local tax records", "policy": policy},
            "insurance": {"annual": 2100, "label": "TX rebuild-cost estimate"},
            "reserves": {
                "maintenance_pct": 6.2, "capex_pct": 5.4, "age": 41,
                "source": "property", "label": "age and size adjusted",
                "monthly_dollars": 275, "clamped": False,
            },
            "state": "TX", "usage": {"count": 1, "limit": 50, "remaining": 49},
        },
        "/api/appreciation": appreciation,
    }


def install_api_mocks(page, overrides=None):
    """Intercept browser API traffic while recording every request body."""
    payloads = _response_payloads()
    payloads.update(overrides or {})
    calls = []

    def handle(route):
        request = route.request
        path = urlparse(request.url).path
        try:
            request_payload = request.post_data_json
        except Exception:
            request_payload = None
        calls.append({"path": path, "method": request.method, "json": request_payload})

        response = payloads.get(path)
        if callable(response):
            response = response(request_payload)
        if response is None:
            route.fulfill(
                status=404,
                content_type="application/json",
                body=json.dumps({"error": f"No test response for {path}"}),
            )
            return
        if isinstance(response, tuple):
            status, response = response
        else:
            status = 200
        if path == "/api/analyze-ai-stream" and isinstance(response, str):
            route.fulfill(status=status, content_type="text/event-stream", body=response)
            return
        route.fulfill(
            status=status,
            content_type="application/json",
            body=json.dumps(response),
        )

    page.route("**/api/**", handle)
    return calls


@pytest.fixture(scope="module")
def live_server():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    config = uvicorn.Config(
        app_module.app, host="127.0.0.1", port=port,
        log_level="warning", access_log=False,
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            with urlopen(base_url, timeout=0.25) as response:
                if response.status == 200:
                    break
        except (URLError, TimeoutError):
            time.sleep(0.05)
    else:
        server.should_exit = True
        thread.join(timeout=5)
        pytest.fail("local browser-test server did not start")

    yield base_url
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as playwright:
        instance = playwright.chromium.launch(headless=True)
        yield instance
        instance.close()


@pytest.fixture
def page(browser):
    context = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
    current = context.new_page()
    errors = []
    current.on("pageerror", lambda error: errors.append(error.stack or str(error)))
    yield current
    assert errors == [], f"unexpected browser errors: {errors}"
    context.close()


def open_app(page, live_server, overrides=None):
    calls = install_api_mocks(page, overrides)
    page.goto(live_server, wait_until="load")
    page.locator("#modeToggle").wait_for()
    assert page.evaluate(
        "typeof window.DealEngine === 'object' && typeof window.tryExampleDeal === 'function'"
    )
    return calls


def test_single_property_results_whatif_ai_and_report_export(page, live_server, tmp_path):
    stream = (
        'data: {"token":"## Assessment\\nControlled browser analysis.","done":false}\n\n'
        'data: {"token":"","done":true}\n\n'
    )
    open_app(page, live_server, {"/api/analyze-ai-stream": stream})

    page.evaluate("tryExampleDeal()")
    assert page.locator("#step6").evaluate("el => el.classList.contains('active')")
    assert page.locator(".results-view.active").get_attribute("data-results-panel") == "summary"
    assert page.locator("#dealVerdict").inner_text() != "--"
    assert page.locator("#resMonthlyCF").inner_text() != "--"
    assert page.locator("#growthWarning").inner_text().find("Held 10 years") >= 0

    page.locator('[data-results-view="whatif"]').click()
    page.locator('#whatifBody').wait_for(state="visible")
    slider = page.locator('.wf-row[data-key="price"] input[type="range"]')
    slider.evaluate(
        "el => { el.value = el.max; el.dispatchEvent(new Event('input', {bubbles:true})); }"
    )
    page.wait_for_function("document.querySelector('#whatifDirty').textContent.includes('changed')")
    page.get_by_role("button", name="Apply to my analysis").click()
    assert "written to your analysis" in page.locator("#whatifDirty").inner_text()

    page.locator('[data-results-view="details"]').click()
    assert page.locator("#resultsPanelDetails").is_visible()
    page.get_by_role("button", name="Run AI Analysis").click()
    page.wait_for_function("document.querySelector('#aiOutput').textContent.includes('Controlled browser analysis')")

    with page.expect_download() as download_info:
        page.evaluate("downloadHTML()")
    report_path = tmp_path / "report.html"
    download_info.value.save_as(report_path)
    report = BeautifulSoup(report_path.read_text(encoding="utf-8"), "html.parser")
    assert report.select_one('[data-results-panel="summary"]')
    assert report.select_one('[data-results-panel="details"]')
    assert not report.select_one('[data-results-panel="whatif"]')
    assert not report.select_one(".results-view-tabs")


def test_neighborhood_search_hydrates_every_automatic_assumption(page, live_server):
    calls = open_app(page, live_server)
    page.locator('[data-mode="search"]').click()
    page.locator("#searchLocation").fill("78701")
    page.get_by_role("button", name="Search Listings").click()

    page.locator("#searchResultsBody tr").wait_for()
    assert "101 Test Ave" in page.locator("#searchResultsBody").inner_text()
    page.locator("#searchResultsBody button").click()
    page.locator("#step2.active").wait_for()

    assert page.locator("#propName").input_value() == LISTING["address"]
    assert page.locator("#monthlyRent").input_value() == "$2,350"
    assert page.locator("#propertyTaxes").input_value() == "$5,040"
    assert page.locator("#insurance").input_value() == "$2,100"
    assert page.locator("#vacancy").input_value() == "5.5"
    assert page.locator("#maintenance").input_value() == "6.2"
    assert page.locator("#capex").input_value() == "5.4"
    assert page.locator("#valueGrowth").input_value() == "2.5"
    assert page.locator("#yearBuilt").input_value() == "1985"

    paths = [call["path"] for call in calls]
    assert "/api/search" in paths
    assert "/api/rent-estimate" in paths
    assert "/api/tax-rate" in paths
    assert "/api/appreciation" in paths

    page.evaluate("goToStep(5)")
    page.get_by_role("button", name="Finish Analysis →").click()
    assert page.locator(".results-view.active").get_attribute("data-results-panel") == "summary"


def test_smart_finder_hydrates_listing_and_exports_ranked_csv(page, live_server, tmp_path):
    calls = open_app(page, live_server)
    page.locator('[data-mode="smart"]').click()
    page.locator("#smartLocation").fill("Austin, TX")
    page.get_by_role("button", name="Find Deals").click()

    page.locator("#smartResultsBody tr").wait_for()
    assert "High" in page.locator("#smartRentDetails").inner_text()
    assert "$2,250/mo" in page.locator("#smartResultsBody").inner_text()

    with page.expect_download() as download_info:
        page.get_by_role("button", name="Export CSV").click()
    csv_path = tmp_path / "smart.csv"
    download_info.value.save_as(csv_path)
    csv = csv_path.read_text(encoding="utf-8")
    assert "Address,Price,Beds" in csv
    assert "101 Test Ave" in csv

    page.locator("#smartResultsBody button").click()
    page.locator("#step2.active").wait_for()
    assert page.locator("#monthlyRent").input_value() == "$2,350"
    assert page.locator("#propertyTaxes").input_value() == "$5,040"
    paths = [call["path"] for call in calls]
    assert "/api/smart-search" in paths
    assert all(path in paths for path in ("/api/rent-estimate", "/api/tax-rate", "/api/appreciation"))


def test_scenarios_compare_and_mobile_print_layout(page, live_server):
    open_app(page, live_server)
    page.evaluate("tryExampleDeal()")
    page.evaluate("saveScenario()")
    page.evaluate(
        """() => {
          document.querySelector('#propName').value = 'Lower Price Variant';
          document.querySelector('#purchasePrice').value = '225000';
          goToStep(6);
          saveScenario();
        }"""
    )

    saved = page.locator("#scenarioSelect option").all_text_contents()
    assert any("456 Oak Avenue" in option for option in saved)
    assert "Lower Price Variant" in saved

    page.evaluate("openCompare()")
    options = page.locator("#compareA option").evaluate_all(
        "options => options.map(option => option.value).filter(Boolean)"
    )
    page.locator("#compareA").select_option(options[0])
    page.locator("#compareB").select_option(options[1])
    page.evaluate("runCompare()")
    assert page.locator("#compareResults .compare-table").is_visible()
    assert "Monthly Cash Flow" in page.locator("#compareResults").inner_text()
    page.evaluate("closeCompare()")

    page.set_viewport_size({"width": 390, "height": 844})
    page.locator('[data-results-view="summary"]').click()
    viewport_fit = page.evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth + 1"
    )
    assert viewport_fit
    tab_boxes = page.locator(".results-view-tabs button").evaluate_all(
        "tabs => tabs.map(tab => tab.getBoundingClientRect()).map(r => ({left:r.left,right:r.right,width:r.width}))"
    )
    assert all(box["left"] >= 0 and box["right"] <= 390 for box in tab_boxes)
    assert len(page.screenshot()) > 10_000

    page.emulate_media(media="print")
    assert page.locator("#resultsPanelSummary").evaluate("el => getComputedStyle(el).display") == "block"
    assert page.locator("#resultsPanelDetails").evaluate("el => getComputedStyle(el).display") == "block"
    assert page.locator("#resultsPanelWhatif").evaluate("el => getComputedStyle(el).display") == "none"


def test_search_failure_is_actionable_and_controls_recover(page, live_server):
    open_app(
        page,
        live_server,
        {"/api/search": (503, {"error": "Listing provider temporarily unavailable."})},
    )
    page.locator('[data-mode="search"]').click()
    page.locator("#searchLocation").fill("78701")
    page.get_by_role("button", name="Search Listings").click()

    page.wait_for_function(
        "document.querySelector('#searchStatus').textContent.includes('temporarily unavailable')"
    )
    assert page.locator("#searchBtn").is_enabled()
    assert page.locator("#searchResultsContainer").is_hidden()


def test_income_step_can_continue_with_rentcast_or_choose_free_fallback(page, live_server):
    def rent_response(payload):
        if payload.get("allow_overage"):
            return {
                "estimate": {
                    "rent": 2820, "rent_low": 2550, "rent_high": 3100,
                    "source": "rentcast_avm", "label": "RentCast property estimate",
                },
                "usage": {"count": 50, "limit": 50, "remaining": 0},
            }
        if payload.get("skip_rentcast"):
            return {
                "rentals": [{"address": "Free fallback comp", "rent": 2750}],
                "stats": {
                    "count": 1, "median": 2750, "avg": 2750,
                    "low": 2750, "high": 2750,
                },
            }
        return {
            "quota_gate": {
                "reason": "quota",
                "message": "RentCast limit reached. Continue with RentCast or use the free estimate.",
            },
            "usage": {"count": 50, "limit": 50, "remaining": 0},
        }

    calls = open_app(page, live_server, {"/api/rent-estimate": rent_response})
    page.evaluate("tryExampleDeal(); goToStep(3)")
    page.evaluate("Promise.all([fetchRentEstimate(), fetchRentEstimate()])")

    page.locator("#quotaGate").wait_for(state="visible")
    assert page.locator("#step3").evaluate("el => el.classList.contains('active')")
    assert len([call for call in calls if call["path"] == "/api/rent-estimate"]) == 1
    page.get_by_role("button", name="Continue with RentCast").click()
    page.wait_for_function("document.querySelector('#monthlyRent').value === '$2,820'")

    rent_calls = [call for call in calls if call["path"] == "/api/rent-estimate"]
    assert rent_calls[0]["json"]["allow_overage"] is False
    assert rent_calls[1]["json"]["allow_overage"] is True
    assert rent_calls[1]["json"]["skip_rentcast"] is False

    page.get_by_role("button", name="Estimate Rent").click()
    page.locator("#quotaGate").wait_for(state="visible")
    page.get_by_role("button", name="Use free estimate").click()
    page.wait_for_function("document.querySelector('#rentEstimateLocation').textContent.includes('1 listings')")

    rent_calls = [call for call in calls if call["path"] == "/api/rent-estimate"]
    assert rent_calls[-1]["json"]["skip_rentcast"] is True
    assert rent_calls[-1]["json"]["allow_overage"] is False


def test_currency_fields_format_on_blur_and_keep_numeric_calculations(page, live_server):
    open_app(page, live_server)
    price = page.locator("#purchasePrice")

    assert price.input_value() == "$200,000"
    price.focus()
    assert price.input_value() == "200000"
    price.fill("559365")
    price.blur()

    assert price.input_value() == "$559,365"
    page.evaluate("goToStep(6)")
    assert page.locator("#resultsPropPrice").inner_text() == "$559,365.00"
