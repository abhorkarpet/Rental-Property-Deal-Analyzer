"""Cross-property, persistence, export and failure cases from the flow review."""
import pytest
import csv
import io
from playwright.sync_api import expect
import test_browser_e2e as e2e

pytestmark = pytest.mark.browser
live_server = e2e.live_server
browser = e2e.browser
page = e2e.page


def open_app(page, live_server, overrides=None):
    return e2e.open_app(page, live_server, overrides)


def test_goal_switch_rescores_existing_listings_and_survives_reload(page, live_server):
    listing = dict(e2e.LISTING, price=250000, estRent=2800, rentConfidence='medium', rentSampleSize=10, rentMethodVersion=2)
    calls = open_app(page, live_server, {'/api/search':{'listings':[listing], 'total':1}})
    expect(page.locator('#investmentStrategy')).to_have_value('hybrid')
    page.evaluate("AppNavigation.navigate('find/neighborhood')")
    page.fill('#searchLocation','78701')
    page.get_by_role('button', name='Search Listings', exact=True).click()
    expect(page.locator('#searchResultsBody .score-context')).to_contain_text('Hybrid')
    before = page.locator('#searchResultsBody .score-num').inner_text()
    requests_before = len(calls)
    page.select_option('#investmentStrategy','cash_flow')
    expect(page.locator('#searchResultsBody .score-context')).to_contain_text('Cash flow')
    assert page.locator('#searchResultsBody .score-num').inner_text() != before
    assert len(calls) == requests_before, 'Goal switching must not fetch or spend API requests'
    page.locator('.goal-settings summary').click()
    page.fill('#targetCoC','16')
    page.locator('#targetIRR').focus()
    page.wait_for_function("JSON.parse(localStorage.getItem('rpda_workspace_v2'))?.analysis?.targetCoC === '16'")
    page.reload(wait_until='load')
    expect(page.locator('#investmentStrategy')).to_have_value('cash_flow')
    expect(page.locator('#targetCoC')).to_have_value('16')
    expect(page.locator('#searchResultsBody .score-context')).to_contain_text('Cash flow')
    with page.expect_download() as download:
        page.evaluate('exportSearchCSV()')
    with open(download.value.path(), encoding='utf-8') as file:
        rows = list(csv.DictReader(io.StringIO(file.read())))
    assert rows[0]['Strategy'] == 'cash_flow'
    assert rows[0]['Goal Score'] == page.locator('#searchResultsBody .score-num').inner_text().split('/')[0]
    assert '16%' in rows[0]['Scoring Assumptions']
    assert rows[0]['Rent Sample Size'] == '10'


def test_goal_comparison_and_saved_scenario_restore(page, live_server):
    open_app(page, live_server)
    page.evaluate("tryExampleDeal();document.querySelector('#scenarioName').value='Hybrid example';saveScenario()")
    page.select_option('#investmentStrategy','appreciation')
    expect(page.locator('#dealExplanation')).to_contain_text('Appreciation')
    page.evaluate("document.querySelector('#scenarioName').value='Appreciation example';saveScenario();showResultsView('details')")
    expect(page.locator('#strategyNotes .selected')).to_contain_text('Appreciation')
    expect(page.locator('#strategyNotes')).to_contain_text('No-appreciation IRR')
    page.select_option('#scenarioSelect','Hybrid example')
    page.evaluate('loadScenario()')
    expect(page.locator('#investmentStrategy')).to_have_value('hybrid')
    page.evaluate('openCompare()')
    page.select_option('#compareA','Hybrid example')
    page.select_option('#compareB','Appreciation example')
    page.select_option('#compareHold','15')
    page.evaluate('runCompare()')
    expect(page.locator('#compareNote')).to_contain_text('hybrid')
    scores = page.locator('#compareResults tr').filter(has_text='Goal Score').locator('td').all_text_contents()
    assert scores[1] == scores[2], 'Compare must use a common goal for otherwise identical scenarios'


def batch_payload():
    return {
        "deals": [{
            "source_row": 2, "address": "101 Test Ave, Austin, TX 78701",
            "address_quality": "exact", "price": 300000, "monthly_rent": 2200,
            "asset_type": "SFR", "claimed_roi_pct": 9, "confidence": "low",
            "stabilized_coc_pct": 6.5, "year1_coc_pct": 7, "warnings": [],
            "incentives": [], "roi_basis": "seller_claimed_unspecified",
        }],
        "mapping": {"1": "address", "2": "price", "3": "monthly_rent"},
        "skipped_rows": 1,
    }


def import_batch(page):
    page.evaluate("AppNavigation.navigate('batch')")
    page.fill("#batchSheetUrl", "https://docs.google.com/spreadsheets/d/test/edit")
    page.get_by_role("button", name="Import Deals", exact=True).click()
    page.get_by_role("button", name="Confirm Import").click()


def test_new_property_clears_prior_inputs_and_preserves_financing(page, live_server):
    listing = dict(e2e.LISTING, hoaFee=0, sqft=None)
    open_app(page, live_server, {"/api/search": {"listings": [listing], "total": 1}})
    page.evaluate("""() => {
      document.querySelector('#hoa').value='425';
      document.querySelector('#rehabBudget').value='60000';
      document.querySelector('#arv').value='550000';
      document.querySelector('#sqft').value='4000';
      document.querySelector('#interestRate').value='5.75';
      AppNavigation.navigate('find/neighborhood');
    }""")
    page.fill("#searchLocation", "78701")
    page.get_by_role("button", name="Search Listings").click()
    page.locator("#searchResultsBody tr").wait_for()
    page.evaluate("analyzeFromSearch(0)")
    expect(page.locator("#step2")).to_have_class("step-panel active")
    assert page.input_value("#hoa") == "$0"
    assert page.input_value("#rehabBudget") == ""
    assert page.input_value("#arv") == ""
    assert page.input_value("#sqft") == ""
    assert page.input_value("#interestRate") == "5.75"
    assert "current underwriting" in page.locator("#verificationChanges").inner_text()


def test_multifamily_snapshot_survives_reload_and_comparison_recomputes(page, live_server):
    open_app(page, live_server)
    page.evaluate("""() => {
      tryExampleDeal(); goToStep(1); setPropertyType('multi');
      document.querySelector('#unitCount').value='3'; updateUnitVisibility();
      ['1400','1600','1800'].forEach((v,i)=>document.querySelectorAll('.unit-rent')[i].value=v);
      document.querySelector('#scenarioName').value='Triplex base';
      goToStep(6); saveScenario();
      document.querySelector('#scenarioName').value='Triplex discount';
      document.querySelector('#purchasePrice').value='225000'; saveScenario();
    }""")
    page.reload()
    page.locator("#workspaceNav").wait_for()
    page.select_option("#scenarioSelect", "Triplex base")
    page.evaluate("loadScenario()")
    assert page.locator(".unit-rent").evaluate_all("els => els.slice(0,3).map(e=>e.value)") == ["$1,400", "$1,600", "$1,800"]
    assert page.input_value("#unitCount") == "3"
    assert page.locator('[data-unit="3"]').is_hidden()  # Income panel not yet active.
    page.evaluate("goToStep(3)")
    assert page.locator('[data-unit="3"]').is_visible()
    page.evaluate("openCompare()")
    page.select_option("#compareA", "Triplex base")
    page.select_option("#compareB", "Triplex discount")
    page.select_option("#compareHold", "15")
    page.evaluate("runCompare()")
    assert "15 years" in page.locator("#compareResults").inner_text()
    assert "$225,000.00" in page.locator("#compareResults").inner_text()


def test_upload_applies_multifamily_type_and_requires_rent_roll(page, live_server):
    open_app(page, live_server, {
        "/api/extract-upload": {"source": "pdf", "data": dict(e2e.LISTING, propertyType="Duplex", hoaFee=0)}
    })
    page.locator("#uploadPdf").set_input_files({
        "name": "mock.pdf", "mimeType": "application/pdf",
        "buffer": b"UI fixture: extraction endpoint is mocked",
    })
    expect(page.locator("#uploadConfirm")).to_be_visible()
    page.get_by_role("button", name="Use these values").click()
    expect(page.locator('#propTypeToggle button.active')).to_contain_text("Multifamily")
    page.evaluate("goToStep(3)")
    page.get_by_role("button", name="Next →", exact=True).click()
    expect(page.locator("#unitRent0")).to_be_focused()
    expect(page.locator("#unitRent0")).to_have_attribute("aria-invalid", "true")
    assert "greater than zero" in page.locator("#unitRent0-error").inner_text()


def test_ai_commentary_is_invalidated_and_old_response_cannot_reappear(page, live_server):
    stream = 'data: {"token":"Original $250000 assessment.","done":false}\n\ndata: {"done":true}\n\n'
    open_app(page, live_server, {"/api/analyze-ai-stream": stream})
    page.evaluate("tryExampleDeal(); showResultsView('details'); runAI()")
    expect(page.locator("#aiOutput")).to_contain_text("Original")
    page.evaluate("goToStep(1); document.querySelector('#purchasePrice').value='500000'; goToStep(6); showResultsView('details')")
    assert page.locator("#aiOutput").is_hidden()
    assert "Inputs changed" in page.locator("#aiStatus").inner_text()
    page.evaluate("""() => {
      const fetchOriginal=window.fetch;
      window.fetch=(url,opts)=>url==='/api/analyze-ai-stream'
        ? new Promise(resolve=>window.finishOldAI=()=>resolve(new Response('data: {"token":"STALE"}\\n\\n')))
        : fetchOriginal(url,opts);
      void runAI();
    }""")
    page.wait_for_function("typeof window.finishOldAI === 'function'")
    page.evaluate("goToStep(1); document.querySelector('#purchasePrice').value='600000';goToStep(6);showResultsView('details');finishOldAI()")
    expect(page.locator("#aiBtn")).to_be_enabled()
    assert "STALE" not in page.locator("#aiOutput").inner_text()


def test_ai_partial_stream_error_is_not_reported_as_complete(page, live_server):
    stream = 'data: {"token":"Partial analysis"}\n\ndata: {"error":"Provider connection interrupted"}\n\n'
    open_app(page, live_server, {"/api/analyze-ai-stream": stream})
    page.evaluate("tryExampleDeal();showResultsView('details');runAI()")
    expect(page.locator("#aiError")).to_contain_text("Provider connection interrupted")
    assert "incomplete" in page.locator("#aiStatus").inner_text()


def test_draft_preserves_batch_shortlist_search_and_whatif(page, live_server):
    open_app(page, live_server, {"/api/batch-review/import": batch_payload()})
    import_batch(page)
    page.get_by_role("button", name="Shortlist", exact=True).click()
    page.evaluate("""() => {
      AppNavigation.navigate('find/neighborhood');
      document.querySelector('#searchLocation').value='78701';
      AppNavigation.navigate('analyze/property'); tryExampleDeal(); showResultsView('whatif');
    }""")
    slider = page.locator('.wf-row[data-key="price"] input[type=range]')
    slider.evaluate("el=>{el.value=el.max;el.dispatchEvent(new Event('input',{bubbles:true}));}")
    expect(page.locator("#whatifDirty")).to_contain_text("1 assumption changed")
    page.evaluate("AppNavigation.navigate('batch');AppNavigation.navigate('results/whatif')")
    expect(page.locator("#whatifDirty")).to_contain_text("1 assumption changed")
    page.reload()
    expect(page.locator("#whatifDirty")).to_contain_text("1 assumption changed")
    page.evaluate("AppNavigation.navigate('batch')")
    expect(page.locator("#batchResultsBody")).to_contain_text("101 Test Ave")
    expect(page.get_by_role("button", name="Shortlisted", exact=True)).to_have_attribute("aria-pressed", "true")
    page.evaluate("AppNavigation.navigate('find/neighborhood')")
    assert page.input_value("#searchLocation") == "78701"


def test_export_is_styled_offline_and_contains_input_snapshot(page, live_server, tmp_path):
    open_app(page, live_server)
    page.evaluate("tryExampleDeal()")
    with page.expect_download() as download:
        page.evaluate("downloadHTML()")
    path = tmp_path / "report.html"
    download.value.save_as(path)
    page.goto(path.as_uri())
    assert page.locator("link[rel=stylesheet],script,button").count() == 0
    assert page.locator("style").count() >= 1
    assert page.locator(".report-inputs").is_visible()
    assert "Inputs and sources" in page.locator(".report-inputs").inner_text()
    assert "rgb" in page.evaluate("getComputedStyle(document.body).backgroundColor")
    assert page.evaluate("getComputedStyle(document.body).backgroundColor") != "rgba(0, 0, 0, 0)"


def test_import_preview_cancel_and_mobile_financial_cards(page, live_server, tmp_path):
    open_app(page, live_server, {"/api/batch-review/import": batch_payload()})
    page.evaluate("AppNavigation.navigate('batch')")
    page.fill("#batchSheetUrl", "https://docs.google.com/spreadsheets/d/test/edit")
    page.get_by_role("button", name="Import Deals", exact=True).click()
    expect(page.locator("#batchPreviewSummary")).to_contain_text("1 rows skipped")
    assert page.locator("#batchResultsBody tr").count() == 0
    page.get_by_role("button", name="Discard Preview").click()
    assert page.locator("#batchResultsBody tr").count() == 0
    page.get_by_role("button", name="Import Deals", exact=True).click()
    page.get_by_role("button", name="Confirm Import").click()
    page.set_viewport_size({"width":390,"height":844})
    expect(page.locator(".batch-table-wrap")).to_be_hidden()
    expect(page.locator(".batch-mobile-card")).to_contain_text("$300,000")
    expect(page.locator(".batch-mobile-card")).to_contain_text("6.5%")
    expect(page.get_by_role("button", name="Verify & Analyze →")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
    page.screenshot(path=str(tmp_path/"batch-mobile.png"), full_page=True, animations="disabled")


def test_full_validation_finds_earlier_error_and_does_not_change_route(page, live_server):
    open_app(page, live_server)
    page.evaluate("tryExampleDeal();document.querySelector('#purchasePrice').value='0';finishAnalysis()")
    expect(page.locator("#purchasePrice")).to_be_focused()
    expect(page.locator("#purchasePrice")).to_have_attribute("aria-invalid","true")
    assert page.url.endswith("#analyze/property")
    expect(page.locator("#workflowStatus")).to_contain_text("attention")


def test_clear_draft_keeps_saved_scenarios(page, live_server):
    open_app(page, live_server)
    page.evaluate("tryExampleDeal();saveScenario()")
    page.on("dialog", lambda dialog: dialog.accept())
    page.get_by_role("button",name="Clear workspace draft").click()
    assert page.input_value("#propName") == ""
    assert len(page.locator("#scenarioSelect option").all_text_contents()) == 2

    page.reload()
    assert page.input_value("#propName") == ""
    assert len(page.locator("#scenarioSelect option").all_text_contents()) == 2


def test_older_estimate_response_cannot_overwrite_new_property(page, live_server):
    first = dict(e2e.LISTING, address="101 First St, Austin TX 78701")
    second = dict(e2e.LISTING, address="202 Second St, Austin TX 78701", price=400000)
    open_app(page, live_server, {"/api/search": {"listings":[first,second],"total":2}})
    page.evaluate("""() => {
      const originalFetch=window.fetch;
      window.fetch=(url,opts)=> {
        if (url==='/api/tax-rate' && JSON.parse(opts.body).address.includes('First')) {
          return new Promise(resolve=>window.releaseOldTax=()=>resolve(new Response(JSON.stringify({
            tax:{rate:0.5,annual:150000},insurance:{annual:99999},reserves:{}
          }),{status:200,headers:{'Content-Type':'application/json'}})));
        }
        return originalFetch(url,opts);
      };
      AppNavigation.navigate('find/neighborhood');
    }""")
    page.fill("#searchLocation","78701")
    page.get_by_role("button",name="Search Listings").click()
    page.locator("#searchResultsBody tr").first.wait_for()
    # Address sort makes the handoff order deterministic.
    page.evaluate("sortSearchResults('address');window.oldAnalysis=analyzeFromSearch(0);void 0")
    page.wait_for_function("typeof releaseOldTax === 'function'")
    page.evaluate("analyzeFromSearch(1)")
    assert "Second" in page.input_value("#propName")
    before = page.input_value("#propertyTaxes")
    page.evaluate("releaseOldTax(); oldAnalysis")
    assert "Second" in page.input_value("#propName")
    assert page.input_value("#propertyTaxes") == before
    assert page.input_value("#insurance") != "$99,999"


def test_url_replacement_clears_property_and_keeps_listing_url(page, live_server):
    url = "https://www.redfin.com/TX/Austin/101-Test-Ave-78701/home/12345"
    open_app(page, live_server, {"/api/scrape":dict(e2e.LISTING,hoaFee=0,sqft=None)})
    page.evaluate("document.querySelector('#hoa').value='425';document.querySelector('#sqft').value='4000';document.querySelector('#arv').value='999000'")
    page.fill("#zillowUrl",url)
    page.get_by_role("button",name="Fetch Data").click()
    expect(page.locator("#fetchBtn")).to_be_enabled()
    assert page.input_value("#zillowUrl") == url
    assert page.input_value("#hoa") == "$0"
    assert page.input_value("#sqft") == ""
    assert page.input_value("#arv") == ""


def test_search_explains_rent_comps_and_manual_override(page, live_server):
    listing = dict(e2e.LISTING, rentSource='redfin', rentSampleSize=3,
                   rentBasis='3-bed asking-rent median; size within 25%',
                   rentConfidence='low', rentMethodVersion=2)
    missing = dict(listing, address='Unmatched five bedroom home', beds=5,
                   estRent=None, rentSource=None, rentSampleSize=0,
                   rentBasis='No matching bedroom rental comps; verify rent',
                   rentConfidence='unavailable')
    open_app(page, live_server, {'/api/search': {'listings': [listing, missing], 'total': 2}})
    page.evaluate("AppNavigation.navigate('find/neighborhood')")
    page.fill('#searchLocation', 'Manteca, CA')
    page.get_by_role('button', name='Search Listings').click()
    row = page.locator('#searchResultsBody tr').filter(has_text=listing['address'])
    expect(row.locator('.rent-sample')).to_have_text('3 comps')
    expect(row.locator('.rent-confidence')).to_have_text('Low confidence')
    expect(row).to_contain_text('size within 25%')
    unpriced = page.locator('#searchResultsBody tr').filter(has_text=missing['address'])
    expect(unpriced).to_contain_text('Unknown')
    expect(unpriced).to_contain_text('Unscored')
    page.fill('#searchTargetRent', '3000')
    page.get_by_role('button', name='Search Listings').click()
    expect(row).to_contain_text('Manual override')
    expect(unpriced).to_contain_text('$3,000.00/mo')


def test_old_saved_search_requires_refresh_without_losing_analysis(page, live_server):
    open_app(page, live_server)
    page.evaluate("""() => {
      tryExampleDeal();
      document.querySelector('#purchasePrice').dispatchEvent(new Event('input', {bubbles:true}));
    }""")
    page.wait_for_function("localStorage.getItem('rpda_workspace_v2') !== null")
    price = page.input_value('#purchasePrice')
    page.add_init_script("""(() => {
      let draft = JSON.parse(localStorage.getItem('rpda_workspace_v2'));
      draft.search = [{address:'Obsolete rental estimate', estRent:1975, rentSource:'redfin'}];
      localStorage.setItem('rpda_workspace_v2', JSON.stringify(draft));
    })();""")
    page.reload()
    page.evaluate("AppNavigation.navigate('find/neighborhood')")
    expect(page.locator('#searchStatus')).to_contain_text('Run Search Listings again')
    expect(page.locator('#searchResultsContainer')).to_be_hidden()
    assert page.input_value('#purchasePrice') == price


def hud_fixture():
    return {'gross_rent':2990,'bedrooms':3,'year':2027,'geography_level':'zip','zip':'95336',
            'area_name':'Stockton-Lodi, CA MSA','source':'hud_safmr','future_fiscal_year':True,
            'derived_bedrooms':False,'note':'Gross rent includes utilities. Deduct tenant-paid utilities.'}


def test_hud_benchmark_is_separate_and_utility_adjustment_is_explicit(page,live_server):
    open_app(page,live_server,{'/api/hud/benchmarks':{'results':[hud_fixture()]}})
    page.evaluate("tryExampleDeal(); goToStep(3)")
    page.locator('#hudPanel > summary').click()
    page.select_option('#hudBeds','3')
    before=page.input_value('#monthlyRent')
    page.locator('#hudLookupBtn').click()
    expect(page.locator('#hudResult')).to_contain_text('$2,990/mo')
    assert page.input_value('#monthlyRent')==before
    expect(page.locator('#hudApplyBtn')).to_be_disabled()
    page.fill('#hudUtilityAllowance','200')
    expect(page.locator('#hudAdjustedRent')).to_contain_text('$2,790/month')
    page.locator('#hudApplyBtn').click()
    assert page.input_value('#monthlyRent')=='$2,790'
    page.evaluate("document.querySelector('#scenarioName').value='HUD scenario'; saveScenario()")
    page.reload()
    page.select_option('#scenarioSelect','HUD scenario')
    page.evaluate("loadScenario(); goToStep(3)")
    assert page.input_value('#monthlyRent')=='$2,790'
    assert page.input_value('#hudUtilityAllowance')=='200'
    expect(page.locator('#hudResult')).to_contain_text('$2,990/mo')


def test_search_adds_hud_benchmark_without_changing_market_rent(page,live_server):
    open_app(page,live_server,{
        '/api/search':{'listings':[dict(e2e.LISTING,rentMethodVersion=2)],'total':1},
        '/api/hud/benchmarks':{'results':[hud_fixture()]},
    })
    page.evaluate("AppNavigation.navigate('find/neighborhood')")
    page.fill('#searchLocation','Manteca, CA')
    page.locator('#searchBtn').click()
    page.locator('#searchResultsBody tr').wait_for()
    page.locator('#searchHUDBtn').click()
    expect(page.locator('#searchResultsBody .hud-row')).to_contain_text('$2,990/mo')
    expect(page.locator('#searchResultsBody tr')).to_contain_text('$2,250.00/mo')
    expect(page.locator('#searchResultsBody .hud-row')).to_contain_text('utilities included')


def test_hud_result_clears_when_property_changes(page,live_server):
    open_app(page,live_server,{'/api/hud/benchmarks':{'results':[hud_fixture()]}})
    page.evaluate("tryExampleDeal(); goToStep(3)")
    page.locator('#hudPanel > summary').click()
    page.select_option('#hudBeds','3')
    page.locator('#hudLookupBtn').click()
    expect(page.locator('#hudResult')).to_be_visible()
    page.fill('#hudUtilityAllowance','0')
    expect(page.locator('#hudApplyBtn')).to_be_enabled()
    page.evaluate("resetAnalysisForNewProperty()")
    expect(page.locator('#hudResult')).to_be_hidden()
    expect(page.locator('#hudApplyBtn')).to_be_disabled()


def test_hud_city_only_requires_manual_county_before_request(page,live_server):
    calls=open_app(page,live_server,{
        '/api/hud/areas':{'areas':[{'id':'4715799999','name':'Shelby County'}]},
        '/api/hud/benchmarks':{'results':[hud_fixture()]},
    })
    page.evaluate("tryExampleDeal(); document.querySelector('#propName').value='Memphis, TN 38114'; goToStep(3)")
    page.locator('#hudPanel > summary').click()
    page.select_option('#hudBeds','4')
    page.locator('#hudLookupBtn').click()
    expect(page.locator('#hudStatus')).to_contain_text('not a street address')
    assert not any(call['path']=='/api/hud/benchmarks' for call in calls)
    page.select_option('#hudState','TN')
    expect(page.locator('#hudStatus')).to_contain_text('Choose the county')
    page.fill('#hudZip','38114')
    page.locator('#hudLookupBtn').click()
    expect(page.locator('#hudStatus')).to_contain_text('Selecting a state and ZIP alone')
    assert not any(call['path']=='/api/hud/benchmarks' for call in calls)
    page.select_option('#hudArea','4715799999')
    page.locator('#hudLookupBtn').click()
    expect(page.locator('#hudResult')).to_be_visible()
    request=next(call['json'] for call in calls if call['path']=='/api/hud/benchmarks')
    assert request['properties'][0]['entity_id']=='4715799999'
    assert request['properties'][0]['zip_code']=='38114'


def test_hud_prefills_location_and_preserves_corrections_until_property_changes(page,live_server):
    open_app(page,live_server,{'/api/hud/areas':{'areas':[{'id':'0111799999','name':'Shelby County'}]}})
    page.evaluate("tryExampleDeal(); document.querySelector('#propName').value='**Montevallo, AL 35115 ($42,107 Incentive Available Now!)'; goToStep(3)")
    page.locator('#hudPanel > summary').click()
    expect(page.locator('#hudState')).to_have_value('AL')
    expect(page.locator('#hudZip')).to_have_value('35115')
    expect(page.locator('#hudArea option[value="0111799999"]')).to_have_count(1)
    page.locator('.hud-manual > summary').click()
    page.select_option('#hudArea','0111799999')
    page.fill('#hudZip','35116')
    page.evaluate('goToStep(4); goToStep(3)')
    expect(page.locator('#hudZip')).to_have_value('35116')
    page.wait_for_function("JSON.parse(localStorage.getItem('rpda_workspace_v2'))?.analysis?._hud?.zip === '35116'")
    page.reload()
    expect(page.locator('#hudZip')).to_have_value('35116')
    expect(page.locator('#hudArea')).to_have_value('0111799999')
    page.evaluate("AppNavigation.navigate('analyze/property')")
    page.fill('#propName','42 Main St, Boston, MA 02108-1234')
    expect(page.locator('#hudState')).to_have_value('MA')
    expect(page.locator('#hudZip')).to_have_value('02108')
    expect(page.locator('#hudArea')).to_have_value('')
    page.fill('#propName','New property ($42,107 incentive)')
    expect(page.locator('#hudState')).to_have_value('')
    expect(page.locator('#hudZip')).to_have_value('')
