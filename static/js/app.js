(function() {
  // ======================================================================
  // DOM helpers
  // ======================================================================
  var $ = function(id) { return document.getElementById(id); };
  var fmt = function(n) { return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var fmtDollar = function(n) { return '$' + fmt(n); };
  var fmtPct = function(n) { return fmt(n) + '%'; };
  var fmtInt = function(n) { return Math.round(n).toLocaleString('en-US'); };
  var fmtGRM = function(n) { return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); };

  function esc(s) {
    if (typeof s !== 'string') return s;
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function debounce(fn, delay) {
    var timer;
    return function() { clearTimeout(timer); timer = setTimeout(fn, delay); };
  }

  function inputNumber(value) {
    var cleaned = String(value === null || value === undefined ? '' : value)
      .replace(/[$,\s]/g, '');
    return parseFloat(cleaned);
  }

  function val(el, min, max) {
    var v = inputNumber(el.value);
    if (isNaN(v)) v = 0;
    if (min !== undefined && v < min) v = min;
    if (max !== undefined && v > max) v = max;
    return v;
  }

  function optionalVal(el, min, max) {
    if (!el || String(el.value).trim() === '') return null;
    return val(el, min, max);
  }

  function formatCurrencyInput(el) {
    if (!el || document.activeElement === el) return;
    if (String(el.value).trim() === '') return;
    var amount = inputNumber(el.value);
    if (isNaN(amount)) {
      el.value = '';
      return;
    }
    var min = inputNumber(el.getAttribute('min'));
    var max = inputNumber(el.getAttribute('max'));
    if (!isNaN(min)) amount = Math.max(min, amount);
    if (!isNaN(max)) amount = Math.min(max, amount);
    el.value = '$' + amount.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  }

  function formatCurrencyInputs() {
    document.querySelectorAll('.currency-input').forEach(formatCurrencyInput);
  }

  function setupCurrencyInputs() {
    document.querySelectorAll('.currency-input').forEach(function(el) {
      el.addEventListener('focus', function() {
        var amount = inputNumber(el.value);
        el.value = isNaN(amount) ? '' : String(amount);
        el.select();
      });
      el.addEventListener('blur', function() {
        formatCurrencyInput(el);
        calculate();
      });
      formatCurrencyInput(el);
    });
  }

  // ======================================================================
  // State
  // ======================================================================
  var currentStep = 1;
  var maxVisitedStep = 1;
  var propertyType = 'sfh';
  var appMode = 'single'; // 'single' or 'search'
  var autoFilledFields = {}; // track fields filled automatically
  var userEditedFields = {}; // track fields manually edited by user
  var fieldSources = {};     // where each auto-filled value came from
  var rentcastAllowOverage = false; // session-only: never persisted, so a
                                    // forgotten toggle can't run up a bill
  var rentcastLocalAutoContinue = false;

  // Investment properties are not owner-occupied, so conventional financing
  // typically requires 25% down rather than 20%. Used by the search-grid quick
  // score; the wizard reads the Down Payment field, which defaults to the same.
  var INVESTOR_DOWN_PAYMENT = window.DealEngine.INVESTOR_DOWN_PAYMENT;

  // How far the year-by-year projection runs. Five years drives the headline
  // metrics; the rest exists so a hold can be examined over its real life.
  var PROJECTION_YEARS = window.DealEngine.PROJECTION_YEARS;

  var SOURCE_LABELS = {
    zillow: 'Zillow', redfin: 'Redfin', rentcast_avm: 'RentCast',
    rentcast_market: 'RentCast area', pdf: 'PDF', pdf_ai: 'PDF (AI)',
    screenshot_ai: 'Screenshot (AI)', estimated: 'Estimated', fhfa: 'FHFA',
    seller_sheet: 'Seller sheet', brochure: 'Brochure'
  };

  function markSource(field, source) {
    autoFilledFields[field] = true;
    fieldSources[field] = source;
  }

  // ======================================================================
  // RentCast quota — remote deployments ask before crossing the reserve;
  // trusted localhost sessions continue and keep the counter visible.
  // ======================================================================
  function updateUsageDisplay(usage) {
    var el = $('rentcastUsage');
    if (!el || !usage || !usage.limit) return;
    el.textContent = 'RentCast: ' + usage.count + '/' + usage.limit + ' requests this month'
      + (rentcastLocalAutoContinue ? ' — local mode continues automatically' : '');
    el.style.display = '';
  }

  function showQuotaGate(gate, onSpend, onFree) {
    var el = $('quotaGate');
    if (!el) return;
    if (rentcastAllowOverage) { if (onSpend) onSpend(); return; }
    $('quotaGateMsg').textContent = gate.message || 'RentCast monthly limit reached.';
    el.style.display = '';
    $('quotaGateFree').onclick = function() {
      el.style.display = 'none';
      if (onFree) onFree();
    };
    $('quotaGateSpend').onclick = function() {
      if ($('quotaGateRemember').checked) rentcastAllowOverage = true;
      el.style.display = 'none';
      // Authorize this call explicitly. The click must authorize the retry
      // even when the user does not also
      // choose to remember that decision for the session; otherwise the retry
      // re-sends allow_overage:false and the server gates it again.
      if (onSpend) onSpend(true);
    };
  }
  var lastCalcResults = {};
  var lastTaxContext = {};
  window.scrapedData = null; // store fetched Zillow data for results display

  // ======================================================================
  // Wizard Navigation
  // ======================================================================
  function updateWizardNav() {
    var steps = document.querySelectorAll('.wizard-step');
    var lines = document.querySelectorAll('.wizard-line');

    steps.forEach(function(s) {
      var n = parseInt(s.dataset.step);
      s.classList.remove('active', 'completed', 'disabled');
      s.setAttribute('aria-selected', n === currentStep ? 'true' : 'false');
      if (n === currentStep) {
        s.classList.add('active');
      } else if (n < currentStep) {
        s.classList.add('completed');
        s.querySelector('.circle').innerHTML = '&#10003;';
      } else if (n > maxVisitedStep) {
        s.classList.add('disabled');
        s.querySelector('.circle').textContent = n;
      } else {
        s.querySelector('.circle').textContent = n;
      }
    });

    lines.forEach(function(l) {
      var n = parseInt(l.dataset.line);
      l.classList.toggle('filled', n < currentStep);
    });
  }

  function validateStep(step) {
    var errors = [];
    if (step === 1 && appMode === 'single' && val($('purchasePrice'), 0) <= 0) errors.push('purchasePrice');
    if (step === 3 && propertyType === 'sfh' && val($('monthlyRent'), 0) <= 0) errors.push('monthlyRent');
    document.querySelectorAll('.input-error').forEach(function(el) { el.classList.remove('input-error'); });
    errors.forEach(function(id) { $(id).classList.add('input-error'); });
    return errors.length === 0;
  }

  window.goToStep = function(n) {
    if (n < 1 || n > 6) return;
    // Validate current step when moving forward
    if (n > currentStep && !validateStep(currentStep)) return;

    // Hide current
    var panels = document.querySelectorAll('.step-panel');
    panels.forEach(function(p) { p.classList.remove('active'); });

    currentStep = n;
    if (n > maxVisitedStep) maxVisitedStep = n;

    document.querySelector('.step-panel[data-step="' + n + '"]').classList.add('active');
    updateWizardNav();
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Populate review when entering step 5
    if (n === 5) populateReview();
    // Calculate when entering step 6
    if (n === 6) {
      whatifSeed = null;
      whatifOverrides = {};
      calculate();
    }
  };

  window.wizardClick = function(n) {
    if (n <= maxVisitedStep) goToStep(n);
  };

  window.finishAnalysis = function() {
    goToStep(6);
    showResultsView('summary');
  };

  var currentResultsView = 'summary';

  window.showResultsView = function(view) {
    if (['summary', 'whatif', 'details'].indexOf(view) === -1) return;
    currentResultsView = view;
    document.querySelectorAll('[data-results-panel]').forEach(function(panel) {
      panel.classList.toggle('active', panel.dataset.resultsPanel === view);
    });
    document.querySelectorAll('[data-results-view]').forEach(function(button) {
      var active = button.dataset.resultsView === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    });
    if (view === 'whatif' && !whatifSeed) whatifOpen();
    var tabs = document.querySelector('.results-view-tabs');
    if (view !== 'summary' && tabs) {
      tabs.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // ======================================================================
  // Cash Purchase Toggle
  // ======================================================================
  window.toggleCashPurchase = function() {
    var checked = $('cashPurchase').checked;
    $('loanFields').style.display = checked ? 'none' : 'block';
  };

  // ======================================================================
  // Property Type Toggle
  // ======================================================================
  window.setPropertyType = function(type) {
    propertyType = type;
    document.querySelectorAll('#propTypeToggle button').forEach(function(b) {
      b.classList.toggle('active', b.dataset.type === type);
    });
    $('sfhRentGroup').style.display = type === 'sfh' ? 'block' : 'none';
    $('multifamilyInputs').classList.toggle('visible', type === 'multi');
    if (type === 'multi') updateUnitVisibility();
  };

  window.updateUnitVisibility = function() {
    var count = parseInt($('unitCount').value);
    $('unitRentsGrid').querySelectorAll('[data-unit]').forEach(function(el) {
      var u = parseInt(el.dataset.unit);
      el.style.display = u <= count ? '' : 'none';
    });
  };

  updateUnitVisibility();

  // ======================================================================
  // Down Payment Helper
  // ======================================================================
  function updateDpHelper() {
    var price = val($('purchasePrice'), 0);
    var dpPct = val($('downPayment'), 0, 100);
    $('dpHelper').textContent = '$' + fmtInt(price * dpPct / 100);
  }

  // ======================================================================
  // Closing Costs default (3% of purchase price)
  // ======================================================================
  function updateClosingCostsDefault() {
    if (!userEditedFields['closingCosts']) {
      var price = val($('purchasePrice'), 0);
      $('closingCosts').value = Math.round(price * 0.03);
    }
  }

  // Insurance default (0.5% of purchase price)
  function updateInsuranceDefault() {
    if (!userEditedFields['insurance']) {
      var price = val($('purchasePrice'), 0);
      $('insurance').value = Math.round(price * 0.005);
    }
  }

  // ======================================================================
  // Carrying costs — property tax and insurance as local rates
  // ======================================================================
  // The acquisition-year basis is policy-driven. States such as California
  // reset assessed value on sale, while Oregon generally carries its maximum
  // assessed value forward. The API supplies that distinction with the rate.
  var carryingRates = null;
  var propertyTaxPolicy = null;

  function showPropertyTaxPolicy(policy) {
    propertyTaxPolicy = policy || null;
    var note = $('taxPolicyNote');
    if (!note) return;
    note.textContent = '';
    if (!policy) { note.style.display = 'none'; return; }

    var summary = policy.label;
    if (policy.annual_cap_pct !== null && policy.annual_cap_pct !== undefined) {
      summary += ' — ' + policy.annual_cap_pct + '% annual '
        + (policy.model === 'tax_bill_cap' ? 'tax-bill cap' : 'assessment cap');
    }
    summary += '. ' + policy.detail;
    if (policy.coverage === 'verified_state_rule' && policy.as_of) {
      summary += ' Rule checked ' + policy.as_of + '.';
    }
    summary += ' ';
    note.appendChild(document.createTextNode(summary));
    if (policy.source_url) {
      var source = document.createElement('a');
      source.href = policy.source_url;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.textContent = policy.source_label || 'Official source';
      note.appendChild(source);
    }
    note.style.display = '';
    if (scrapedData && scrapedData.annualTax) showSellerTaxContext(scrapedData.annualTax);
  }

  async function applyCarryingCostRates(forceRefetch, allowOverage) {
    var price = val($('purchasePrice'), 0);
    if (!price) return;
    var address = $('propName').value.trim() || (scrapedData && scrapedData.address) || '';

    if (!carryingRates || forceRefetch) {
      try {
        var resp = await fetch('/api/tax-rate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: address, price: price,
            allow_overage: allowOverage || rentcastAllowOverage,
            // Both are already scraped or extracted; they let the server size
            // reserves off the building instead of off the rent.
            sqft: val($('sqft'), 0) || (scrapedData && scrapedData.sqft) || null,
            yearBuilt: val($('yearBuilt'), 0) || (scrapedData && scrapedData.yearBuilt) || null,
            rent: getTotalRent() || null
          })
        });
        var data = await resp.json();
        if (!resp.ok || data.error) return;
        if (data.quota_gate) showQuotaGate(data.quota_gate, function(ok) { applyCarryingCostRates(true, ok); });
        if (data.usage) updateUsageDisplay(data.usage);
        carryingRates = data;
        showPropertyTaxPolicy(data.tax && data.tax.policy);
      } catch (err) { return; }
    }

    if (carryingRates.tax && carryingRates.tax.policy) {
      showPropertyTaxPolicy(carryingRates.tax.policy);
    }

    if (!userEditedFields['propertyTaxes'] && carryingRates.tax) {
      var policy = carryingRates.tax.policy;
      var keepExistingAssessment = policy && policy.reassesses_on_sale === false
        && scrapedData && scrapedData.annualTax;
      $('propertyTaxes').value = keepExistingAssessment
        ? Math.round(scrapedData.annualTax)
        : Math.round(price * carryingRates.tax.rate);
      markSource('propertyTaxes', keepExistingAssessment
        ? 'estimated'
        : (carryingRates.tax.source === 'zip' ? 'rentcast_market' : 'estimated'));
      var note = $('taxRateNote');
      if (note) {
        note.textContent = keepExistingAssessment
          ? 'Current tax bill used because this state does not routinely reset the assessment on sale'
          : (carryingRates.tax.rate * 100).toFixed(2) + '% — ' + carryingRates.tax.label;
        note.style.display = '';
      }
    }
    if (!userEditedFields['insurance'] && carryingRates.insurance
        && carryingRates.insurance.annual) {
      // An absolute premium now, not a share of price — insurers rate on what
      // it costs to rebuild the structure, and land is not insured.
      $('insurance').value = carryingRates.insurance.annual;
      markSource('insurance', 'estimated');
      var inote = $('insuranceNote');
      if (inote) {
        inote.textContent = '$' + fmtInt(carryingRates.insurance.annual / 12) +
          '/mo — ' + carryingRates.insurance.label;
        inote.style.display = '';
      }
    }
    applyReserves(carryingRates.reserves);
    if (typeof calculate === 'function') calculate();
  }

  // Maintenance and CapEx sized off the building rather than the rent.
  //
  // A roof does not cost less in a cheap market, so a flat percentage of rent
  // under-reserves wherever rent is low relative to construction cost — which
  // is exactly where a screener is most likely to call something a good deal.
  // The fields still hold percentages so nothing downstream changes; only the
  // number in them is now property-specific.
  function fillYearBuilt(year, source) {
    if (!year || userEditedFields['yearBuilt']) return;
    var el = $('yearBuilt');
    if (!el || el.value) return;
    el.value = year;
    markSource('yearBuilt', source || 'redfin');
  }

  function applyReserves(res) {
    if (!res) return;
    // Age drives the reserve more than anything else, so say when it is missing
    // rather than quietly assuming a mid-life house.
    var yn = $('yearBuiltNote');
    if (yn) {
      if (res.age === null || res.age === undefined) {
        yn.textContent = 'Unknown — reserves assume a mid-life house. Enter it for a closer figure.';
        yn.style.display = '';
      } else {
        yn.style.display = 'none';
      }
    }
    if (!userEditedFields['maintenance']) {
      $('maintenance').value = res.maintenance_pct;
      markSource('maintenance', 'estimated');
    }
    if (!userEditedFields['capex']) {
      $('capex').value = res.capex_pct;
      markSource('capex', 'estimated');
    }
    var note = $('reserveNote');
    if (!note) return;
    if (res.source === 'default') { note.style.display = 'none'; return; }
    var text = res.label;
    if (res.monthly_dollars) {
      text = '$' + fmtInt(res.monthly_dollars) + '/mo for repairs and replacements \u2014 ' + res.label;
    }
    if (res.clamped) text += ' (capped \u2014 check square footage and rent)';
    note.textContent = text;
    note.style.display = '';
  }

  // The seller's bill is context in reset-on-sale states and can be the better
  // starting point in states whose capped assessment normally survives a sale.
  function showSellerTaxContext(annualTax) {
    var note = $('sellerTaxNote');
    if (!note || !annualTax) return;
    note.textContent = propertyTaxPolicy && propertyTaxPolicy.reassesses_on_sale === false
      ? 'Current owner pays $' + fmtInt(annualTax) + '/yr; used as the starting bill when auto-fill is enabled'
      : 'Current owner pays $' + fmtInt(annualTax) + '/yr (pre-sale assessment)';
    note.style.display = '';
  }

  // ======================================================================
  // Property value growth — the local rate, and the spread around it
  //
  // Appreciation is the biggest single line in the 5-year return and was the
  // last input still using a national guess. It now comes from that ZIP's own
  // measured price history, and carries the range of five-year outcomes that
  // history contains, because the average alone is the least useful part of it.
  // ======================================================================
  var appreciationProfile = null;

  async function applyAppreciation(forceRefetch) {
    if (appreciationProfile && !forceRefetch) { applyAppreciationToField(); return; }
    var address = $('propName').value.trim() || (scrapedData && scrapedData.address) || '';
    try {
      var resp = await fetch('/api/appreciation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address, holdYears: parseInt($('holdYears').value) || 10 })
      });
      var data = await resp.json();
      if (!resp.ok || data.error) return;
      appreciationProfile = data;
    } catch (err) { return; }
    applyAppreciationToField();
    if (typeof calculate === 'function') calculate();
  }

  // The default is deliberately below what this ZIP historically did.
  //
  // A rate measured over 1995-2025 is what a market did, not what it will do,
  // and that window contains a long decline in mortgage rates that cannot
  // repeat. Underwriting near long-run inflation forces the deal to work on
  // cash flow and leaves real appreciation as upside. The local history is not
  // discarded — it drives the range, the worst case, and the Historical
  // scenario, and it lowers the default further in markets that did worse.
  function applyAppreciationToField() {
    var p = appreciationProfile;
    if (!p) return;
    if (!userEditedFields['valueGrowth']) {
      activeScenario = 'conservative';
      $('valueGrowth').value = p.conservative_pct;
      markSource('valueGrowth', p.source === 'default' ? 'estimated' : 'fhfa');
    }
    var note = $('valueGrowthNote');
    if (note) {
      note.textContent = p.conservative_pct < p.rate_pct
        ? p.conservative_pct + '%/yr, held near inflation on purpose — ' + p.label +
          ' averaged ' + p.rate_pct + '%. The gap is upside, not underwriting.'
        : p.rate_pct + '%/yr — ' + p.label;
      note.style.display = '';
    }
  }

  // Which what-if the projections are currently running. Null once a rate is
  // typed by hand, so a custom number is never mislabelled as a scenario.
  var activeScenario = null;

  window.setApprScenario = function(key, pct) {
    activeScenario = key;
    $('valueGrowth').value = pct;
    // A scenario is not a manual edit — the field must stay auto-managed so a
    // later address change can still refresh it.
    userEditedFields['valueGrowth'] = false;
    markSource('valueGrowth', 'fhfa');
    if (typeof calculate === 'function') calculate();
  };

  // ======================================================================
  // PDF / screenshot upload — the fallback when scraping is blocked
  // ======================================================================
  var pendingUpload = null;

  var UPLOAD_LABELS = {
    address: 'Address', price: 'Price', beds: 'Beds', baths: 'Baths',
    sqft: 'Sq Ft', yearBuilt: 'Year Built', annualTax: 'Annual Tax',
    hoaFee: 'HOA/mo', propertyType: 'Type'
  };

  async function handleUpload(input, kind) {
    var file = input.files && input.files[0];
    if (!file) return;
    var status = $('uploadStatus');
    status.textContent = 'Reading ' + kind + '...';
    $('uploadConfirm').style.display = 'none';

    var form = new FormData();
    form.append('file', file);
    try {
      var resp = await fetch('/api/extract-upload', { method: 'POST', body: form });
      var data = {};
      try { data = await resp.json(); } catch (e) { /* non-JSON error body */ }
      if (!resp.ok || data.error) {
        // Never show a content-free message: FastAPI validation errors arrive
        // as `detail`, and some failures have no JSON body at all.
        var msg = data.error;
        if (!msg && data.detail) {
          msg = Array.isArray(data.detail)
            ? data.detail.map(function(d) { return d.msg || JSON.stringify(d); }).join('; ')
            : String(data.detail);
        }
        if (!msg) msg = 'Upload failed (HTTP ' + resp.status + '). Check the app console for details.';
        status.textContent = msg;
        console.error('extract-upload failed', resp.status, data);
        return;
      }
      status.textContent = '';
      pendingUpload = data;
      renderUploadConfirm(data);
    } catch (err) {
      status.textContent = 'Upload failed. Is the app still running?';
    } finally {
      input.value = '';
    }
  }

  function renderUploadConfirm(data) {
    var html = '';
    Object.keys(UPLOAD_LABELS).forEach(function(key) {
      var v = data.data[key];
      if (v === null || v === undefined || v === '' || (key === 'hoaFee' && !v)) return;
      var shown = (key === 'price' || key === 'annualTax' || key === 'hoaFee') ? '$' + fmtInt(v)
                : (key === 'sqft') ? fmtInt(v) : v;
      html += '<div><span class="k">' + UPLOAD_LABELS[key] + ':</span> <strong>' + esc(String(shown)) + '</strong></div>';
    });
    $('uploadConfirmList').innerHTML = html || '<div>Nothing readable was found.</div>';
    $('uploadConfirmSource').textContent = SOURCE_LABELS[data.source] || data.source;
    $('uploadConfirm').style.display = '';
  }

  function applyUpload() {
    if (!pendingUpload) return;
    var d = pendingUpload.data, source = pendingUpload.source;

    if (d.price) {
      $('purchasePrice').value = d.price; markSource('purchasePrice', source);
      $('closingCosts').value = Math.round(d.price * 0.03);
      userEditedFields['closingCosts'] = false;
    }
    if (d.address) { $('propName').value = d.address; markSource('propName', source); }
    if (d.sqft) { $('sqft').value = d.sqft; markSource('sqft', source); }
    if (d.hoaFee) { $('hoa').value = d.hoaFee; markSource('hoaFee', source); }
    if (d.annualTax) showSellerTaxContext(d.annualTax);

    scrapedData = Object.assign({}, scrapedData || {}, d);
    fillYearBuilt(d.yearBuilt);
    $('propAddress').textContent = d.address || 'Address unavailable';
    var bits = [];
    if (d.beds) bits.push(d.beds + ' bed');
    if (d.baths) bits.push(d.baths + ' bath');
    if (d.sqft) bits.push(fmtInt(d.sqft) + ' sqft');
    $('propDetails').textContent = bits.join(' | ');
    $('propImage').style.display = 'none';
    $('propertyCard').classList.add('visible');

    $('uploadConfirm').style.display = 'none';
    $('uploadStatus').textContent = 'Applied. Check the values before relying on them.';
    pendingUpload = null;

    updateDpHelper();
    applyCarryingCostRates(true);
    applyAppreciation(true);
    autoEstimateRent();
  }

  // ======================================================================
  // Zillow Scrape
  // ======================================================================
  window.fetchZillow = async function() {
    var url = $('zillowUrl').value.trim();
    if (!url) {
      showUrlError('Please enter a Zillow URL.');
      return;
    }
    var isZillow = url.toLowerCase().indexOf('zillow.com') !== -1;
    var isRedfin = url.toLowerCase().indexOf('redfin.com') !== -1;
    if (!/^https?:\/\//i.test(url) || (!isZillow && !isRedfin)) {
      showUrlError('Invalid URL. Please enter a Zillow or Redfin listing URL.');
      return;
    }

    $('urlError').classList.remove('visible');
    $('fetchBtn').disabled = true;
    $('fetchBtnText').innerHTML = '<span class="spinner"></span> Fetching...';

    try {
      var resp = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
      });

      var data = await resp.json();

      if (!resp.ok || data.error) {
        showUrlError(data.error || 'Failed to fetch property data.');
        $('uploadStatus').textContent = 'Scraping failed — using the search-card data and local estimates. Upload the listing for more fields.';
        $('uploadRow').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        if (smartAnalyzeActive && scrapedData) {
          await refreshAutomaticAssumptions();
          smartAnalyzeActive = false;
          goToStep(2);
        }
        return;
      }

      resetLocationDerivedAssumptions();
      populateListingForm(data, {
        source: isRedfin ? 'redfin' : 'zillow',
        estimatedRent: data.rentZestimate
      });
      await refreshAutomaticAssumptions();

      // Auto-advance when the listing came from either search table.
      if (smartAnalyzeActive) {
        smartAnalyzeActive = false;
        goToStep(2);
      }

    } catch (err) {
      if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
        showUrlError('Could not connect to the server. Make sure the app is running (python app.py) and try again.');
        showConnectionBanner();
      } else {
        showUrlError('Zillow may be blocking requests. Try again in a minute, or enter data manually.');
      }
      if (smartAnalyzeActive && scrapedData) {
        await refreshAutomaticAssumptions();
        smartAnalyzeActive = false;
        goToStep(2);
      }
    } finally {
      $('fetchBtn').disabled = false;
      $('fetchBtnText').textContent = 'Fetch Data';
      smartAnalyzeActive = false;
    }
  };

  function showUrlError(msg) {
    $('urlError').textContent = msg;
    $('urlError').classList.add('visible');
  }

  function showConnectionBanner() {
    var banner = $('connectionBanner');
    banner.classList.add('visible');
    setTimeout(function() { banner.classList.remove('visible'); }, 8000);
  }

  // ======================================================================
  // Listing hydration
  //
  // Search and Smart Deal Finder both enter the analyzer through this path.
  // Location-derived assumptions are reset for a new property, while the
  // investor's financing and operating choices remain untouched.
  // ======================================================================
  var LOCATION_ASSUMPTION_FIELDS = [
    'monthlyRent', 'propertyTaxes', 'insurance', 'maintenance', 'capex',
    'vacancy', 'valueGrowth', 'yearBuilt'
  ];

  function resetLocationDerivedAssumptions() {
    carryingRates = null;
    appreciationProfile = null;
    propertyTaxPolicy = null;
    LOCATION_ASSUMPTION_FIELDS.forEach(function(field) {
      delete userEditedFields[field];
      delete autoFilledFields[field];
      delete fieldSources[field];
    });
    $('monthlyRent').value = '';
    $('propertyTaxes').value = '';
    $('yearBuilt').value = '';
    $('maintenance').value = 8;
    $('capex').value = 5;
    $('vacancy').value = 8;
    $('valueGrowth').value = 3;
    // A state-specific override must not leak into the next property.
    $('propertyTaxGrowth').value = '';
    [
      'taxRateNote', 'sellerTaxNote', 'insuranceNote', 'reserveNote',
      'vacancyNote', 'valueGrowthNote', 'yearBuiltNote'
    ].forEach(function(id) {
      var note = $(id);
      if (note) note.style.display = 'none';
    });
    showPropertyTaxPolicy(null);
  }

  function renderListingCard(listing) {
    var image = $('propImage');
    if (listing.imageUrl) {
      image.onerror = function() { this.style.display = 'none'; };
      image.src = listing.imageUrl;
      image.style.display = '';
    } else {
      image.removeAttribute('src');
      image.style.display = 'none';
    }
    $('propAddress').textContent = listing.address || 'Address unavailable';
    var details = [];
    if (listing.beds) details.push(listing.beds + ' bed');
    if (listing.baths) details.push(listing.baths + ' bath');
    if (listing.sqft) details.push(fmtInt(listing.sqft) + ' sqft');
    if (listing.yearBuilt) details.push('Built ' + listing.yearBuilt);
    $('propDetails').textContent = details.join(' | ');
    $('propertyCard').classList.add('visible');
  }

  function populateListingForm(listing, options) {
    options = options || {};
    var source = options.source || listing.source || 'redfin';
    var estimatedRent = options.estimatedRent || listing.estRent || listing.rentZestimate;

    if (listing.listingUrl) $('zillowUrl').value = listing.listingUrl;
    if (listing.price) {
      $('purchasePrice').value = listing.price;
      markSource('purchasePrice', source);
      $('closingCosts').value = Math.round(listing.price * 0.03);
      userEditedFields['closingCosts'] = false;
      markSource('closingCosts', 'estimated');
      // Temporary fallback until the local rebuild-cost estimate returns.
      $('insurance').value = Math.round(listing.price * 0.005);
      userEditedFields['insurance'] = false;
    }
    if (listing.address) { $('propName').value = listing.address; markSource('propName', source); }
    if (listing.sqft) { $('sqft').value = listing.sqft; markSource('sqft', source); }
    if (listing.hoaFee) { $('hoa').value = listing.hoaFee; markSource('hoa', source); }
    if (estimatedRent) {
      $('monthlyRent').value = estimatedRent;
      markSource('monthlyRent', listing.rentSource || source);
    }

    scrapedData = {
      address: listing.address || null,
      price: listing.price || null,
      beds: listing.beds || null,
      baths: listing.baths || null,
      sqft: listing.sqft || null,
      yearBuilt: listing.yearBuilt || null,
      propertyType: listing.propertyType || null,
      annualTax: listing.annualTax || null,
      hoaFee: listing.hoaFee || 0,
      description: listing.description || null,
      imageUrl: listing.imageUrl || null,
      rentZestimate: listing.rentZestimate || null
    };
    fillYearBuilt(listing.yearBuilt, source);
    if (listing.annualTax) showSellerTaxContext(listing.annualTax);

    if (listing.propertyType) {
      var pt = String(listing.propertyType).toLowerCase();
      setPropertyType(
        pt.indexOf('multi') >= 0 || pt.indexOf('duplex') >= 0
          || pt.indexOf('triplex') >= 0 || pt.indexOf('fourplex') >= 0
          ? 'multi' : 'sfh'
      );
    }

    renderListingCard(scrapedData);
    updateDpHelper();
  }

  async function refreshAutomaticAssumptions() {
    // Rent first: it supplies vacancy and gives the reserve model the best
    // available rent denominator. The remaining independent lookups can run
    // together afterward.
    await autoEstimateRent();
    await Promise.all([
      applyCarryingCostRates(true),
      applyAppreciation(true)
    ]);
  }

  async function analyzeListing(listing, options) {
    if (!listing) return;
    resetLocationDerivedAssumptions();
    toggleSearchMode('single');
    populateListingForm(listing, options);

    if (listing.listingUrl) {
      smartAnalyzeActive = true;
      await fetchZillow();
      return;
    }

    await refreshAutomaticAssumptions();
    smartAnalyzeActive = false;
    goToStep(2);
  }

  // ======================================================================
  // Neighborhood Search
  // ======================================================================
  var searchResults = [];
  var searchSortCol = 'score';
  var searchSortAsc = false;

  window.toggleSearchMode = function(mode) {
    appMode = mode;
    $('singlePropertyMode').style.display = mode === 'single' ? '' : 'none';
    $('searchMode').style.display = mode === 'search' ? '' : 'none';
    $('smartMode').style.display = mode === 'smart' ? '' : 'none';
    // Show cloud demo notice when search features are selected on hosted demo
    var cloudNotice = $('cloudDemoNotice');
    if (cloudNotice) {
      cloudNotice.style.display = (window.__CLOUD_DEMO__ && mode !== 'single') ? '' : 'none';
    }
    document.querySelectorAll('#modeToggle button').forEach(function(b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  };

  window.runNeighborhoodSearch = async function(allowOverage) {
    if (window.__CLOUD_DEMO__) { showSearchStatus('Search features are only available when running locally. Clone the repo and run python app.py.', true); return; }
    var location = $('searchLocation').value.trim();
    var targetRent = optionalVal($('searchTargetRent'), 0);
    if (!location) {
      showSearchStatus('Please enter a location (zip code or city).', true);
      return;
    }

    $('searchBtn').disabled = true;
    $('searchBtnText').innerHTML = '<span class="spinner"></span> Searching...';
    $('searchResultsContainer').style.display = 'none';
    saveSearchFilters();
    showSearchStatus('Searching listings...', false);

    try {
      var body = {
        location: location,
        min_price: optionalVal($('searchMinPrice'), 0),
        max_price: optionalVal($('searchMaxPrice'), 0),
        min_beds: parseInt($('searchMinBeds').value) || 0,
        property_type: $('searchPropType').value || null,
        max_results: parseInt($('searchMaxResults').value) || 20,
        allow_overage: allowOverage || rentcastAllowOverage,
      };
      var resp = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await resp.json();
      if (!resp.ok || data.error) {
        showSearchStatus(data.error || 'Search failed.', true);
        return;
      }
      if (!data.listings || data.listings.length === 0) {
        showSearchStatus('No listings found for "' + esc(location) + '". Try adjusting your filters or searching a different area.', true);
        return;
      }
      var searchRate = parseFloat($('interestRate').value) / 100 || null;
      searchResults = data.listings.map(function(l) {
        l._score = computeQuickScore(l, targetRent, searchRate);
        return l;
      });

      // Without a rent for a listing there is nothing to score, so say so
      // rather than rendering a page of zeroes.
      var priced = searchResults.filter(function(l) { return l._score.numericScore > 0; });
      if (priced.length === 0) {
        showSearchStatus(
          'Found ' + searchResults.length + ' listings, but no rent estimate is available for this area. '
          + 'Enter an Override Rent to score them, or set RENTCAST_API_KEY for per-listing estimates.', true);
      } else {
        $('searchStatus').style.display = 'none';
      }
      if (data.quota_gate) { showQuotaGate(data.quota_gate, function(ok) { runNeighborhoodSearch(ok); }); }
      if (data.rentcast_usage) { updateUsageDisplay(data.rentcast_usage); }
      searchSortCol = 'score';
      searchSortAsc = false;
      sortAndRenderSearch();
      $('searchResultsTitle').textContent = data.total + ' listings in ' + (data.location_label || location);
      $('searchResultsContainer').style.display = '';
    } catch (err) {
      showSearchStatus('Could not connect to the server. Make sure the app is running.', true);
    } finally {
      $('searchBtn').disabled = false;
      $('searchBtnText').textContent = 'Search Listings';
    }
  };

  function showSearchStatus(msg, isError) {
    var el = $('searchStatus');
    el.textContent = msg;
    el.className = 'search-status' + (isError ? ' error' : '');
    el.style.display = '';
  }

  var computeQuickScore = window.DealEngine.computeQuickScore;

  function sortAndRenderSearch() {
    searchResults.sort(function(a, b) {
      var va, vb;
      if (searchSortCol === 'score') { va = a._score.numericScore; vb = b._score.numericScore; }
      else if (searchSortCol === 'price') { va = a.price || 0; vb = b.price || 0; }
      else if (searchSortCol === 'beds') { va = a.beds || 0; vb = b.beds || 0; }
      else if (searchSortCol === 'sqft') { va = a.sqft || 0; vb = b.sqft || 0; }
      else { va = (a.address || '').toLowerCase(); vb = (b.address || '').toLowerCase(); }
      if (va < vb) return searchSortAsc ? -1 : 1;
      if (va > vb) return searchSortAsc ? 1 : -1;
      return 0;
    });
    renderSearchResults();
  }

  window.sortSearchResults = function(col) {
    if (searchSortCol === col) {
      searchSortAsc = !searchSortAsc;
    } else {
      searchSortCol = col;
      searchSortAsc = col === 'address';
    }
    var ths = document.querySelectorAll('#searchResultsTable th.sortable');
    ths.forEach(function(th) {
      th.classList.toggle('sort-active', th.getAttribute('data-col') === col);
      th.classList.toggle('sort-asc', th.getAttribute('data-col') === col && searchSortAsc);
      th.classList.toggle('sort-desc', th.getAttribute('data-col') === col && !searchSortAsc);
    });
    sortAndRenderSearch();
  };

  function renderSearchResults() {
    var tbody = $('searchResultsBody');
    var html = '';
    var filterGood = $('filterGoodDeals').checked;
    var alertStars = parseInt($('alertMinStars').value) || 0;
    var alertMaxPrice = val($('alertMaxPrice'), 0);
    var alertMinBeds = parseInt($('alertMinBeds').value) || 0;
    var shown = 0;
    searchResults.forEach(function(l, i) {
      if (filterGood && l._score.stars < 3) return;
      var s = l._score;
      var starStr = '';
      for (var j = 0; j < s.stars; j++) starStr += '&#9733;';
      for (var j = s.stars; j < 6; j++) starStr += '&#9734;';
      var detailHtml = s.details.map(function(d) { return '<span class="' + d.cls + '">' + esc(d.text) + '</span>'; }).join(' &middot; ');

      var meetsAlert = s.stars >= alertStars
        && (!alertMaxPrice || (l.price && l.price <= alertMaxPrice))
        && (!alertMinBeds || (l.beds && l.beds >= alertMinBeds));
      var trClass = (alertStars > 0 || alertMaxPrice || alertMinBeds) && meetsAlert ? ' class="meets-alert"' : '';
      var alertTag = meetsAlert && (alertStars > 0 || alertMaxPrice || alertMinBeds) ? '<span class="alert-badge">Match</span>' : '';

      var addrLink = l.listingUrl
        ? '<a href="' + esc(l.listingUrl) + '" target="_blank" rel="noopener">' + esc(l.address || '—') + '</a>'
        : esc(l.address || '—');
      shown++;
      html += '<tr' + trClass + '>'
        + '<td>' + addrLink + alertTag + '</td>'
        + '<td>$' + (l.price ? fmtInt(l.price) : '—') + '</td>'
        + '<td>' + (l.beds != null ? l.beds : '—') + ' / ' + (l.baths != null ? l.baths : '—') + '</td>'
        + '<td>' + (l.sqft ? fmtInt(l.sqft) : '—') + '</td>'
        + '<td><span class="quick-score ' + s.cssClass + '">' + starStr + '</span><div class="score-detail">' + detailHtml + '</div></td>'
        + '<td><button class="btn" onclick="analyzeFromSearch(' + i + ')">Analyze &rarr;</button></td>'
        + '</tr>';
    });
    if (filterGood && shown === 0) {
      html = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted);">No listings with 3+ stars. Try a higher target rent or lower price range.</td></tr>';
    }
    tbody.innerHTML = html;
  }

  window.analyzeFromSearch = function(idx) {
    var listing = searchResults[idx];
    return analyzeListing(listing, {
      source: 'redfin',
      estimatedRent: listing && listing.estRent
    });
  };

  // ======================================================================
  // Smart Deal Finder
  // ======================================================================
  var smartResults = [];
  var smartAnalyzeActive = false;
  var smartSortCol = 'score';
  var smartSortAsc = false;
  var batchResults = [];
  var batchSortCol = 'stabilized_coc_pct';
  var batchSortAsc = false;

  window.showSmartEntry = function(entry) {
    var batch = entry === 'batch';
    $('smartDiscoverPanel').style.display = batch ? 'none' : '';
    $('smartBatchPanel').style.display = batch ? '' : 'none';
    $('smartDiscoverTab').classList.toggle('active', !batch);
    $('smartBatchTab').classList.toggle('active', batch);
    $('smartDiscoverTab').setAttribute('aria-selected', batch ? 'false' : 'true');
    $('smartBatchTab').setAttribute('aria-selected', batch ? 'true' : 'false');
  };

  window.runSmartSearch = async function(allowOverage) {
    if (window.__CLOUD_DEMO__) { showSmartStatus('Smart Deal Finder is only available when running locally. Clone the repo and run python app.py.', true); return; }
    var location = $('smartLocation').value.trim();
    if (!location) {
      showSmartStatus('Please enter a location (zip code or city).', true);
      return;
    }

    $('smartBtn').disabled = true;
    $('smartBtnText').innerHTML = '<span class="spinner"></span> Searching &amp; estimating rents...';
    $('smartResultsContainer').style.display = 'none';
    $('smartRentInfo').style.display = 'none';
    showSmartStatus('Searching rentals and for-sale listings in parallel... This takes 15–25 seconds.', false);

    try {
      var body = {
        location: location,
        min_beds: parseInt($('smartMinBeds').value) || 0,
        property_type: $('smartPropType').value || null,
        max_results: parseInt($('smartMaxResults').value) || 25,
        allow_overage: allowOverage || rentcastAllowOverage,
      };
      var resp = await fetch('/api/smart-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await resp.json();
      if (data.rentcast_usage) updateUsageDisplay(data.rentcast_usage);
      if (data.quota_gate) showQuotaGate(data.quota_gate, function(ok) { runSmartSearch(ok); });
      if (!resp.ok || data.error) {
        showSmartStatus(data.error || 'Search failed.', true);
        return;
      }
      if (!data.listings || data.listings.length === 0) {
        showSmartStatus('No listings found for "' + esc(location) + '".', true);
        return;
      }

      // Show rent data info
      if (data.rent_stats) {
        var rs = data.rent_stats;
        var rentHtml = 'Based on <strong>' + rs.count + '</strong> rental listings: ';
        rentHtml += 'Median <strong>$' + fmtInt(rs.median) + '/mo</strong>, ';
        rentHtml += 'Range $' + fmtInt(rs.low) + ' – $' + fmtInt(rs.high);
        if (data.rent_by_beds) {
          var bedParts = [];
          Object.keys(data.rent_by_beds).sort().forEach(function(b) {
            bedParts.push(b + 'BR: $' + fmtInt(data.rent_by_beds[b]));
          });
          if (bedParts.length > 0) {
            rentHtml += '<br>By bedroom: ' + bedParts.join(' &middot; ');
          }
        }
        if (data.smart_max_price) {
          rentHtml += '<br>Smart price cap: <strong>$' + fmtInt(data.smart_max_price) + '</strong> (only showing properties that could pencil out)';
        }
        if (data.rent_confidence) {
          var confLabel = data.rent_confidence === 'high' ? 'High' : data.rent_confidence === 'medium' ? 'Medium' : 'Low';
          var confCls = data.rent_confidence === 'high' ? 'pass' : data.rent_confidence === 'medium' ? 'warn' : 'fail';
          rentHtml += ' &middot; Rent confidence: <span class="' + confCls + '">' + confLabel + '</span>';
        }
        if (data.mortgage_rate) {
          rentHtml += ' &middot; Scoring at <strong>' + data.mortgage_rate.toFixed(2) + '%</strong> rate';
        }
        var apprNote = data.appreciation
          ? data.appreciation.conservative_pct + '% appreciation (held near inflation; ' +
            data.appreciation.label + ' averaged ' + data.appreciation.rate_pct + '%)'
          : '3% appreciation';
        rentHtml += '<br><span style="color:var(--text-muted);font-size:0.78rem;">Assumptions: ' + Math.round(INVESTOR_DOWN_PAYMENT * 100) + '% down, 30yr fixed, expenses 45-55% of rent (tiered by price), ' + apprNote + '</span>';
        $('smartRentDetails').innerHTML = rentHtml;
        $('smartRentInfo').style.display = '';
      }

      $('smartStatus').style.display = 'none';
      var smartRate = data.mortgage_rate ? data.mortgage_rate / 100 : null;
      smartResults = data.listings.map(function(l) {
        var rent = l.estRent || 0;
        l._score = computeQuickScore(l, rent, smartRate);
        l._estRent = rent;
        return l;
      });
      smartSortCol = 'score';
      smartSortAsc = false;
      sortSmartAndRender();
      var goodCount = smartResults.filter(function(l) { return l._score.stars >= 4; }).length;
      var totalInArea = data.total || smartResults.length;
      var priceInfo = data.smart_max_price ? ' under $' + fmtInt(data.smart_max_price) : '';
      $('smartResultsTitle').textContent = goodCount + ' potential deals found — ' + smartResults.length + ' of ' + totalInArea + ' listings' + priceInfo + ' in ' + (data.location_label || location);
      $('smartResultsContainer').style.display = '';
    } catch (err) {
      showSmartStatus('Could not connect to the server. Make sure the app is running.', true);
    } finally {
      $('smartBtn').disabled = false;
      $('smartBtnText').textContent = 'Find Deals';
    }
  };

  function showSmartStatus(msg, isError) {
    var el = $('smartStatus');
    el.textContent = msg;
    el.className = 'search-status' + (isError ? ' error' : '');
    el.style.display = '';
  }

  function sortSmartAndRender() {
    smartResults.sort(function(a, b) {
      var va, vb;
      if (smartSortCol === 'score') { va = a._score.numericScore; vb = b._score.numericScore; }
      else if (smartSortCol === 'price') { va = a.price || 0; vb = b.price || 0; }
      else if (smartSortCol === 'beds') { va = a.beds || 0; vb = b.beds || 0; }
      else if (smartSortCol === 'estRent') { va = a._estRent || 0; vb = b._estRent || 0; }
      else { va = (a.address || '').toLowerCase(); vb = (b.address || '').toLowerCase(); }
      if (va < vb) return smartSortAsc ? -1 : 1;
      if (va > vb) return smartSortAsc ? 1 : -1;
      return 0;
    });
    renderSmartResults();
  }

  window.sortSmartResults = function(col) {
    if (smartSortCol === col) {
      smartSortAsc = !smartSortAsc;
    } else {
      smartSortCol = col;
      smartSortAsc = col === 'address';
    }
    // Update sort indicators in header
    var ths = document.querySelectorAll('#smartResultsTable th.sortable');
    ths.forEach(function(th) {
      th.classList.toggle('sort-active', th.getAttribute('data-col') === col);
      th.classList.toggle('sort-asc', th.getAttribute('data-col') === col && smartSortAsc);
      th.classList.toggle('sort-desc', th.getAttribute('data-col') === col && !smartSortAsc);
    });
    sortSmartAndRender();
  };

  window.renderSmartResults = function() {
    var tbody = $('smartResultsBody');
    var html = '';
    var filterGood = $('smartFilterGood').checked;
    var shown = 0;
    smartResults.forEach(function(l, i) {
      if (filterGood && l._score.stars < 4) return;
      var s = l._score;
      var starStr = '';
      for (var j = 0; j < s.stars; j++) starStr += '&#9733;';
      for (var j = s.stars; j < 6; j++) starStr += '&#9734;';
      var scoreLabel = ' <span class="score-num">' + s.numericScore + '/100</span>';
      var detailHtml = s.details.map(function(d) { return '<span class="' + d.cls + '">' + esc(d.text) + '</span>'; }).join(' &middot; ');
      shown++;
      var addrHtml = l.listingUrl
        ? '<a href="' + esc(l.listingUrl) + '" target="_blank" rel="noopener" title="View on Redfin">' + esc(l.address || '—') + '</a>'
        : esc(l.address || '—');
      html += '<tr>'
        + '<td>' + addrHtml + '</td>'
        + '<td>$' + (l.price ? fmtInt(l.price) : '—') + '</td>'
        + '<td>' + (l.beds != null ? l.beds : '—') + ' / ' + (l.baths != null ? l.baths : '—') + '</td>'
        + '<td>' + (l._estRent ? '$' + fmtInt(l._estRent) + '/mo' : '—') + '</td>'
        + '<td><span class="quick-score ' + s.cssClass + '">' + starStr + scoreLabel + '</span><div class="score-detail">' + detailHtml + '</div></td>'
        + '<td><button class="btn" onclick="analyzeFromSmart(' + i + ')">Analyze &rarr;</button></td>'
        + '</tr>';
    });
    if (shown === 0 && filterGood) {
      html = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted);">No 4+ star deals found. Uncheck "Good deals only" to see all listings ranked by score, or try a different area with higher rent-to-price ratios.</td></tr>';
    } else if (shown === 0) {
      html = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted);">No listings found. Try a different location or adjust filters.</td></tr>';
    }
    tbody.innerHTML = html;
  };

  window.analyzeFromSmart = function(idx) {
    var listing = smartResults[idx];
    return analyzeListing(listing, {
      source: 'redfin',
      estimatedRent: listing && (listing._estRent || listing.estRent)
    });
  };

  // ======================================================================
  // Batch Inventory Review
  // ======================================================================
  function showBatchStatus(message, isError) {
    var el = $('batchStatus');
    el.textContent = message;
    el.className = 'search-status' + (isError ? ' error' : '');
    el.style.display = '';
  }

  function readTextFile(file) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function() { resolve(String(reader.result || '')); };
      reader.onerror = function() { reject(new Error('Could not read the selected CSV.')); };
      reader.readAsText(file);
    });
  }

  window.importBatchDeals = async function() {
    var sheetUrl = $('batchSheetUrl').value.trim();
    var file = $('batchCsvFile').files[0];
    if ((!sheetUrl && !file) || (sheetUrl && file)) {
      showBatchStatus('Provide one public Google Sheet URL or one CSV file.', true);
      return;
    }
    $('batchImportBtn').disabled = true;
    $('batchImportBtnText').innerHTML = '<span class="spinner"></span> Importing...';
    $('batchResultsContainer').style.display = 'none';
    showBatchStatus(
      $('batchAugmentBrochures').checked
        ? 'Importing inventory and reading linked public brochures...'
        : 'Importing and normalizing seller inventory...',
      false
    );
    try {
      var body = {
        sheet_url: sheetUrl || null,
        csv_text: file ? await readTextFile(file) : null,
        augment_brochures: $('batchAugmentBrochures').checked
      };
      var response = await fetch('/api/batch-review/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await response.json();
      if (!response.ok || data.error) {
        showBatchStatus(data.error || 'Could not import this inventory.', true);
        return;
      }
      batchResults = data.deals || [];
      batchSortCol = 'stabilized_coc_pct';
      batchSortAsc = false;
      sortAndRenderBatch();
      $('batchResultsTitle').textContent = batchResults.length + ' imported deals'
        + (data.sheet_name ? ' — ' + data.sheet_name : '');
      $('batchResultsContainer').style.display = '';
      showBatchStatus(
        'Imported ' + batchResults.length + ' deals'
        + (data.augmented_count ? ' and augmented ' + data.augmented_count + ' brochures' : '')
        + '. Seller claims remain separate from calculated screens.',
        false
      );
    } catch (error) {
      showBatchStatus(error.message || 'Could not connect to the server.', true);
    } finally {
      $('batchImportBtn').disabled = false;
      $('batchImportBtnText').textContent = 'Import Deals';
    }
  };

  window.augmentBatchBrochures = async function() {
    if (!batchResults.length) return;
    var button = $('batchAugmentBtn');
    button.disabled = true;
    button.textContent = 'Reading brochures...';
    showBatchStatus('Reading linked public Google Docs and extracting time-bound incentives...', false);
    try {
      var response = await fetch('/api/batch-review/augment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deals: batchResults })
      });
      var data = await response.json();
      if (!response.ok || data.error) {
        showBatchStatus(data.error || 'Brochure augmentation failed.', true);
        return;
      }
      batchResults = data.deals || batchResults;
      sortAndRenderBatch();
      showBatchStatus(
        'Augmented ' + (data.augmented_count || 0) + ' brochures'
        + (data.unavailable_count ? '; ' + data.unavailable_count + ' could not be read' : '') + '.',
        false
      );
    } catch (error) {
      showBatchStatus('Could not connect to the server.', true);
    } finally {
      button.disabled = false;
      button.textContent = 'Augment Brochures';
    }
  };

  function nullableNumber(value) {
    var number = Number(value);
    return value === null || value === undefined || !isFinite(number) ? null : number;
  }

  function batchPct(value) {
    var number = nullableNumber(value);
    return number === null ? '—' : number.toFixed(1) + '%';
  }

  function roiBasisLabel(value) {
    if (value === 'first_year_promotional') return 'First-year promo';
    if (value === 'ten_year_projection') return '10-year projection';
    return 'Unspecified claim';
  }

  function renderBatchSummary() {
    var exact = batchResults.filter(function(d) { return d.address_quality === 'exact'; }).length;
    var promotional = batchResults.filter(function(d) { return d.roi_basis === 'first_year_promotional'; }).length;
    var augmented = batchResults.filter(function(d) { return d.brochure_status === 'augmented'; }).length;
    var comparable = batchResults.filter(function(d) { return nullableNumber(d.stabilized_coc_pct) !== null; }).length;
    $('batchSummaryStrip').innerHTML = [
      ['Deals', batchResults.length],
      ['Exact addresses', exact],
      ['Promotional ROI', promotional],
      ['Comparable screens', comparable + (augmented ? ' · ' + augmented + ' brochures' : '')]
    ].map(function(item) {
      return '<div class="batch-summary-item"><div class="label">' + esc(String(item[0]))
        + '</div><div class="value">' + esc(String(item[1])) + '</div></div>';
    }).join('');
  }

  function renderBatchResults() {
    renderBatchSummary();
    var html = '';
    batchResults.forEach(function(deal, index) {
      var incentives = deal.incentives || [];
      var sellerChoices = incentives.filter(function(item) {
        return item.choice_group === 'seller_funds';
      });
      var informational = incentives.filter(function(item) {
        return item.choice_group !== 'seller_funds';
      });
      var incentiveHtml = informational.length
        ? informational.map(function(item) {
            var cls = item.type === 'tax_estimate' ? ' tax' : '';
            var suffix = item.end_month ? ' (through month ' + item.end_month + ')' : '';
            return '<span class="incentive-badge' + cls + '" title="' + esc(item.source || 'seller') + '">'
              + esc(item.label || item.type) + esc(suffix) + '</span>';
          }).join('')
        : '';
      if (sellerChoices.length) {
        incentiveHtml = '<select class="batch-incentive-select" aria-label="Selected seller incentive" onchange="selectBatchIncentive('
          + index + ', this.value)"><option value="">Do not count one-time funds</option>'
          + sellerChoices.map(function(item) {
              return '<option value="' + esc(item.id) + '"'
                + (deal.selected_incentive_id === item.id ? ' selected' : '') + '>'
                + esc(item.label) + '</option>';
            }).join('') + '</select>' + incentiveHtml;
      }
      if (!incentiveHtml) incentiveHtml = '<span class="batch-deal-meta">None extracted</span>';
      if (deal.selected_cash_to_close !== null && deal.selected_cash_to_close !== undefined) {
        incentiveHtml += '<div class="batch-deal-meta">Selected cash to close: '
          + fmtDollar(deal.selected_cash_to_close) + '</div>';
        if (deal.selected_year1_coc_pct !== null && deal.selected_year1_coc_pct !== undefined) {
          incentiveHtml += '<div class="batch-deal-meta">Selected Year-1 CoC: '
            + batchPct(deal.selected_year1_coc_pct) + '</div>';
        }
        if (deal.selected_incentive_note) {
          incentiveHtml += '<div class="batch-warning">' + esc(deal.selected_incentive_note) + '</div>';
        }
      }
      var basis = roiBasisLabel(deal.roi_basis);
      var basisClass = deal.roi_basis === 'first_year_promotional' ? '' : ' stable';
      var warnings = (deal.warnings || []).slice(0, 2);
      var brochureLink = deal.brochure_url
        ? '<a href="' + esc(deal.brochure_url) + '" target="_blank" rel="noopener">Brochure</a>'
        : '';
      var meta = [deal.deal_type, deal.asset_type, brochureLink].filter(Boolean).join(' · ');
      var gap = nullableNumber(deal.claimed_roi_pct) !== null && nullableNumber(deal.stabilized_coc_pct) !== null
        ? deal.claimed_roi_pct - deal.stabilized_coc_pct : null;
      html += '<tr>'
        + '<td><div class="batch-deal-name">' + esc(deal.address || '—') + '</div>'
        + (meta ? '<div class="batch-deal-meta">' + meta + '</div>' : '')
        + (warnings.length ? '<div class="batch-warning">' + esc(warnings.join(' ')) + '</div>' : '') + '</td>'
        + '<td>' + (deal.price ? fmtDollar(deal.price) : '—') + '</td>'
        + '<td><strong>' + batchPct(deal.claimed_roi_pct) + '</strong>'
        + (gap !== null && gap > 10 ? '<div class="batch-pct-gap">+' + gap.toFixed(1) + ' pts vs stabilized</div>' : '') + '</td>'
        + '<td><span class="basis-badge' + basisClass + '">' + esc(basis) + '</span></td>'
        + '<td>' + batchPct(deal.year1_coc_pct)
        + (deal.year1_monthly_cash_flow !== null && deal.year1_monthly_cash_flow !== undefined
          ? '<div class="batch-deal-meta">' + fmtDollar(deal.year1_monthly_cash_flow) + '/mo claimed</div>' : '') + '</td>'
        + '<td><strong>' + batchPct(deal.stabilized_coc_pct) + '</strong>'
        + (deal.temporary_pm_uplift_monthly
          ? '<div class="batch-deal-meta">removes ' + fmtDollar(deal.temporary_pm_uplift_monthly) + '/mo PM promo</div>' : '') + '</td>'
        + '<td>' + incentiveHtml + '</td>'
        + '<td><span class="confidence-badge ' + esc(deal.confidence || 'low') + '">' + esc(deal.confidence || 'low') + '</span>'
        + '<div class="batch-deal-meta">' + (deal.address_quality === 'exact' ? 'property-ready' : 'market-only') + '</div></td>'
        + '<td><button class="btn" type="button" onclick="analyzeFromBatch(' + index + ')">Verify &amp; Analyze &rarr;</button></td>'
        + '</tr>';
    });
    if (!html) html = '<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--text-muted);">No priced deals were found.</td></tr>';
    $('batchResultsBody').innerHTML = html;
  }

  window.selectBatchIncentive = function(index, incentiveId) {
    var deal = batchResults[index];
    if (!deal) return;
    deal.selected_incentive_id = incentiveId || null;
    deal.selected_cash_to_close = deal.claimed_initial_cash;
    deal.selected_year1_coc_pct = deal.year1_coc_pct;
    deal.selected_incentive_note = null;
    var selected = (deal.incentives || []).find(function(item) { return item.id === incentiveId; });
    if (selected && selected.amount && ['cash_back', 'closing_credit', 'unallocated_seller_funds'].indexOf(selected.type) >= 0) {
      deal.selected_cash_to_close = Math.max(0, deal.claimed_initial_cash - selected.amount);
      deal.selected_year1_coc_pct = deal.selected_cash_to_close > 0
        ? deal.year1_monthly_cash_flow * 12 / deal.selected_cash_to_close * 100 : null;
    } else if (selected && selected.type === 'rate_buydown') {
      deal.selected_incentive_note = 'Rate schedule required in Full Analysis';
    }
    renderBatchResults();
  };

  function sortAndRenderBatch() {
    batchResults.sort(function(a, b) {
      var va = a[batchSortCol];
      var vb = b[batchSortCol];
      if (batchSortCol === 'address') {
        va = String(va || '').toLowerCase();
        vb = String(vb || '').toLowerCase();
      } else {
        va = nullableNumber(va);
        vb = nullableNumber(vb);
        if (va === null) va = batchSortAsc ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
        if (vb === null) vb = batchSortAsc ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      }
      if (va < vb) return batchSortAsc ? -1 : 1;
      if (va > vb) return batchSortAsc ? 1 : -1;
      return 0;
    });
    renderBatchResults();
  }

  window.sortBatchResults = function(column) {
    if (batchSortCol === column) batchSortAsc = !batchSortAsc;
    else {
      batchSortCol = column;
      batchSortAsc = column === 'address';
    }
    document.querySelectorAll('#batchResultsTable th.sortable').forEach(function(th) {
      var active = th.dataset.col === column;
      th.classList.toggle('sort-active', active);
      th.classList.toggle('sort-asc', active && batchSortAsc);
      th.classList.toggle('sort-desc', active && !batchSortAsc);
    });
    sortAndRenderBatch();
  };

  window.analyzeFromBatch = async function(index) {
    var deal = batchResults[index];
    if (!deal) return;
    var listing = {
      address: deal.address,
      price: deal.price,
      beds: deal.beds,
      baths: deal.baths,
      sqft: deal.sqft,
      yearBuilt: deal.year_built,
      propertyType: deal.asset_type,
      estRent: deal.monthly_rent,
      rentSource: deal.monthly_rent ? 'brochure' : null,
      source: 'seller_sheet'
    };
    await analyzeListing(listing, { source: 'seller_sheet', estimatedRent: deal.monthly_rent });
    var pm = (deal.incentives || []).find(function(item) {
      return item.type === 'property_management_discount' && item.normal_rate_pct !== null;
    });
    if (pm && !userEditedFields.management) {
      $('management').value = pm.normal_rate_pct;
      markSource('management', pm.source === 'brochure' ? 'brochure' : 'estimated');
    }
    calculate();
  };

  window.exportBatchCSV = function() {
    if (!batchResults.length) return;
    var rows = [[
      'Address', 'Price', 'Seller ROI', 'ROI Basis', 'Claimed Monthly Cash Flow',
      'Initial Cash', 'Year-1 CoC', 'Stabilized Monthly Cash Flow',
      'Stabilized CoC', 'Address Quality', 'Confidence', 'Incentives', 'Warnings',
      'Brochure URL'
    ]];
    batchResults.forEach(function(deal) {
      rows.push([
        deal.address, deal.price, deal.claimed_roi_pct, deal.roi_basis,
        deal.claimed_monthly_cash_flow, deal.claimed_initial_cash,
        deal.year1_coc_pct, deal.stabilized_monthly_cash_flow,
        deal.stabilized_coc_pct, deal.address_quality, deal.confidence,
        (deal.incentives || []).map(function(item) { return item.label; }).join('; '),
        (deal.warnings || []).join('; '), deal.brochure_url || ''
      ]);
    });
    var csv = rows.map(function(row) {
      return row.map(function(value) {
        var string = value === null || value === undefined ? '' : String(value);
        return '"' + string.replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'batch-deal-review.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  // ======================================================================
  // Deal Alert Thresholds
  // ======================================================================
  window.toggleAlertConfig = function() {
    var el = $('alertConfig');
    el.classList.toggle('visible');
  };

  window.applyDealAlerts = function() {
    renderSearchResults();
  };

  window.saveAlertPrefs = function() {
    var prefs = {
      minStars: $('alertMinStars').value,
      maxPrice: optionalVal($('alertMaxPrice'), 0) || '',
      minBeds: $('alertMinBeds').value
    };
    try { localStorage.setItem('rpda_alert_prefs', JSON.stringify(prefs)); } catch(e) {}
  };

  function loadAlertPrefs() {
    try {
      var prefs = JSON.parse(localStorage.getItem('rpda_alert_prefs'));
      if (prefs) {
        if (prefs.minStars) $('alertMinStars').value = prefs.minStars;
        if (prefs.maxPrice) $('alertMaxPrice').value = prefs.maxPrice;
        if (prefs.minBeds) $('alertMinBeds').value = prefs.minBeds;
      }
      formatCurrencyInput($('alertMaxPrice'));
    } catch(e) {}
  }

  // ======================================================================
  // Export Smart Deal Finder Results to CSV
  // ======================================================================
  window.exportSmartCSV = function() {
    if (!smartResults || smartResults.length === 0) return;
    var rows = [['Address', 'Price', 'Beds', 'Baths', 'Sqft', 'Est. Rent', 'Stars', 'Score', 'Rent/Price', 'Est. Cap Rate', 'Est. Cash Flow', 'GRM', 'Est. Return', 'Listing URL']];
    smartResults.forEach(function(l) {
      var s = l._score || { stars: 0, numericScore: 0, details: [] };
      var d = s.details || [];
      rows.push([
        '"' + (l.address || '').replace(/"/g, '""') + '"',
        l.price || '',
        l.beds != null ? l.beds : '',
        l.baths != null ? l.baths : '',
        l.sqft || '',
        l._estRent || '',
        s.stars,
        s.numericScore,
        d[0] ? d[0].text : '',
        d[1] ? d[1].text : '',
        d[2] ? d[2].text : '',
        d[3] ? d[3].text : '',
        d[4] ? d[4].text : '',
        '"' + (l.listingUrl || '').replace(/"/g, '""') + '"'
      ]);
    });
    var csv = rows.map(function(r) { return r.join(','); }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'smart-deal-finder-results.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  // Export Search Results to CSV
  // ======================================================================
  window.exportSearchCSV = function() {
    if (!searchResults || searchResults.length === 0) return;
    var rows = [['Address', 'Price', 'Beds', 'Baths', 'Sqft', 'Stars', 'Rent/Price', 'Est. Cap Rate', 'Est. Cash Flow', 'GRM', 'Listing URL']];
    searchResults.forEach(function(l) {
      var s = l._score || { stars: 0, details: [] };
      var details = s.details || [];
      rows.push([
        '"' + (l.address || '').replace(/"/g, '""') + '"',
        l.price || '',
        l.beds != null ? l.beds : '',
        l.baths != null ? l.baths : '',
        l.sqft || '',
        s.stars,
        details[0] ? details[0].text : '',
        details[1] ? details[1].text : '',
        details[2] ? details[2].text : '',
        details[3] ? details[3].text : '',
        '"' + (l.listingUrl || '').replace(/"/g, '""') + '"'
      ]);
    });
    var csv = rows.map(function(r) { return r.join(','); }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'neighborhood-search-results.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  // ======================================================================
  // Saved Search Filters (localStorage)
  // ======================================================================
  var SEARCH_FILTERS_KEY = 'rpda_search_filters';

  function saveSearchFilters() {
    var filters = {
      location: $('searchLocation').value,
      minPrice: optionalVal($('searchMinPrice'), 0),
      maxPrice: optionalVal($('searchMaxPrice'), 0),
      minBeds: $('searchMinBeds').value,
      propType: $('searchPropType').value,
      targetRent: optionalVal($('searchTargetRent'), 0),
      maxResults: $('searchMaxResults').value
    };
    try { localStorage.setItem(SEARCH_FILTERS_KEY, JSON.stringify(filters)); } catch(e) {}
  }

  function loadSearchFilters() {
    try {
      var f = JSON.parse(localStorage.getItem(SEARCH_FILTERS_KEY));
      if (f) {
        if (f.location) $('searchLocation').value = f.location;
        if (f.minPrice) $('searchMinPrice').value = f.minPrice;
        if (f.maxPrice) $('searchMaxPrice').value = f.maxPrice;
        if (f.minBeds) $('searchMinBeds').value = f.minBeds;
        if (f.propType) $('searchPropType').value = f.propType;
        if (f.targetRent) $('searchTargetRent').value = f.targetRent;
        if (f.maxResults) $('searchMaxResults').value = f.maxResults;
      }
      formatCurrencyInput($('searchMinPrice'));
      formatCurrencyInput($('searchMaxPrice'));
      formatCurrencyInput($('searchTargetRent'));
    } catch(e) {}
  }

  // ======================================================================
  // Mortgage Rate Auto-Fill
  // ======================================================================
  window.fetchMortgageRate = async function() {
    var btn = $('fetchRateBtn');
    btn.textContent = '...';
    btn.disabled = true;
    try {
      var resp = await fetch('/api/mortgage-rate');
      var data = await resp.json();
      if (data.rate) {
        $('interestRate').value = data.rate;
        calculate();
      }
    } catch(e) {}
    btn.textContent = 'Current Rate';
    btn.disabled = false;
  };

  // ======================================================================
  // Rent Estimation
  // ======================================================================
  var rentEstimateInFlight = Object.create(null);

  function requestRentEstimate(body) {
    var key = JSON.stringify(body);
    if (rentEstimateInFlight[key]) return rentEstimateInFlight[key];

    var request = fetch('/api/rent-estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: key
    }).then(async function(resp) {
      return { resp: resp, data: await resp.json() };
    });
    rentEstimateInFlight[key] = request;
    var clear = function() { delete rentEstimateInFlight[key]; };
    request.then(clear, clear);
    return request;
  }

  window.fetchRentEstimate = async function(allowOverage, skipRentcast) {
    var btn = $('estimateRentBtn');
    btn.textContent = '...';
    btn.disabled = true;

    // Get location from property name/address or scraped data
    var location = '';
    if (scrapedData && scrapedData.address) {
      // Extract zip code or city from address
      var addrParts = scrapedData.address.split(',');
      if (addrParts.length >= 2) {
        var lastPart = addrParts[addrParts.length - 1].trim();
        var zipMatch = lastPart.match(/\d{5}/);
        if (zipMatch) {
          location = zipMatch[0];
        } else {
          location = addrParts.slice(1).join(',').trim();
        }
      }
    }
    if (!location) {
      var propNameVal = $('propName').value.trim();
      if (propNameVal) {
        var zipM = propNameVal.match(/\d{5}/);
        if (zipM) location = zipM[0];
        else location = propNameVal;
      }
    }
    if (!location) {
      btn.textContent = 'Estimate Rent';
      btn.disabled = false;
      alert('Enter a property address first (Step 1) so we can look up local rents.');
      return;
    }

    try {
      var result = await requestRentEstimate(
        rentEstimateBody(location, allowOverage, skipRentcast)
      );
      var resp = result.resp;
      var data = result.data;
      if (data.usage) updateUsageDisplay(data.usage);
      if (!resp.ok || data.error) {
        alert(data.error || ('Rent estimate failed (HTTP ' + resp.status + ').'));
        btn.textContent = 'Estimate Rent';
        btn.disabled = false;
        return;
      }
      if (data.quota_gate) {
        if (data.estimate) {
          applyRentEstimate(data.estimate, data.comparables);
          applyCarryingCostRates(true);
        }
        if (data.vacancy) applyVacancy(data.vacancy);
        showQuotaGate(
          data.quota_gate,
          function(ok) { fetchRentEstimate(ok, false); },
          function() { fetchRentEstimate(false, true); }
        );
        btn.textContent = 'Estimate Rent';
        btn.disabled = false;
        return;
      }
      if (data.vacancy) applyVacancy(data.vacancy);
      if (data.estimate) {
        applyRentEstimate(data.estimate, data.comparables);
        applyCarryingCostRates(true);
      } else if (data.stats && data.stats.count > 0) {
        var s = data.stats;
        $('rentEstimateStats').innerHTML =
          '<div class="rent-stat"><div class="rent-label">Low (25th)</div><div class="rent-value">$' + fmtInt(s.low) + '</div></div>' +
          '<div class="rent-stat"><div class="rent-label">Median</div><div class="rent-value highlight">$' + fmtInt(s.median) + '</div></div>' +
          '<div class="rent-stat"><div class="rent-label">Average</div><div class="rent-value">$' + fmtInt(s.avg) + '</div></div>' +
          '<div class="rent-stat"><div class="rent-label">High (75th)</div><div class="rent-value">$' + fmtInt(s.high) + '</div></div>';
        $('rentEstimateLocation').textContent = location + ' (' + s.count + ' listings)';
        $('rentEstimateNote').textContent = 'Click a value to use it as your rent. Based on ' + s.count + ' active Redfin rental listings.';
        $('rentEstimateSection').style.display = '';
        // Make stats clickable
        $('rentEstimateStats').querySelectorAll('.rent-stat').forEach(function(el) {
          el.style.cursor = 'pointer';
          el.onclick = function() {
            var val = el.querySelector('.rent-value').textContent.replace(/[^0-9]/g, '');
            $('monthlyRent').value = val;
            calculate();
            applyCarryingCostRates(true);
          };
        });
      } else {
        $('rentEstimateSection').style.display = 'none';
        alert('No rental listings found for "' + location + '". Try a more specific location.');
      }
    } catch(e) {
      alert('Could not fetch rent estimates. Make sure the app is running.');
    }
    btn.textContent = 'Estimate Rent';
    btn.disabled = false;
  };

  // ======================================================================
  // Rent estimate helpers
  // ======================================================================
  function rentEstimateBody(location, allowOverage, skipRentcast) {
    return {
      location: location,
      address: (scrapedData && scrapedData.address) || $('propName').value.trim() || '',
      beds: (scrapedData && scrapedData.beds) || null,
      baths: (scrapedData && scrapedData.baths) || null,
      sqft: val($('sqft'), 0) || (scrapedData && scrapedData.sqft) || null,
      property_type: (scrapedData && scrapedData.propertyType) || null,
      allow_overage: allowOverage || rentcastAllowOverage,
      skip_rentcast: !!skipRentcast
    };
  }

  // Vacancy is turnover time, so it follows local re-let speed rather than a
  // flat national figure. Same guard as tax: a manual edit is never replaced.
  function applyVacancy(vac) {
    if (!vac || !vac.rate_pct) return;
    if (!userEditedFields['vacancy']) {
      $('vacancy').value = vac.rate_pct;
      markSource('vacancy', vac.source === 'market' ? 'rentcast_market' : 'estimated');
    }
    var note = $('vacancyNote');
    if (note) {
      note.textContent = vac.source === 'market'
        ? vac.rate_pct + '% — ' + vac.label + (vac.floored ? ' (floored)' : '')
        : vac.rate_pct + '% — ' + vac.label;
      note.style.display = '';
    }
    if (typeof calculate === 'function') calculate();
  }

  function applyRentEstimate(est, comps) {
    if (!est || !est.rent) return;
    if (!userEditedFields['monthlyRent']) {
      $('monthlyRent').value = est.rent;
      markSource('monthlyRent', est.source || 'rentcast_avm');
    }
    var html = '<div class="rent-stat"><div class="rent-label">Estimate</div>'
             + '<div class="rent-value highlight">$' + fmtInt(est.rent) + '</div></div>';
    // The range is the underwriting signal: does the deal still work at the
    // low end? Show it rather than just the point estimate.
    if (est.rent_low) {
      html = '<div class="rent-stat"><div class="rent-label">Low</div><div class="rent-value">$'
           + fmtInt(est.rent_low) + '</div></div>' + html;
    }
    if (est.rent_high) {
      html += '<div class="rent-stat"><div class="rent-label">High</div><div class="rent-value">$'
           + fmtInt(est.rent_high) + '</div></div>';
    }
    $('rentEstimateStats').innerHTML = html;
    $('rentEstimateLocation').textContent = est.label || '';
    var note = est.source === 'rentcast_avm'
      ? 'Property-specific model estimate. Check that it still cash-flows at the low end.'
      : est.source === 'redfin'
        ? 'Free estimate from' + (est.sample_size ? ' ' + est.sample_size : '')
          + ' active Redfin rental' + (est.sample_size === 1 ? '' : 's') + '.'
        : 'Area estimate scaled by size'
          + (est.sample_size ? ' from ' + est.sample_size + ' rentals' : '') + '.';
    if (est.days_on_market) note += ' Typical rental sits ' + est.days_on_market + ' days.';
    $('rentEstimateNote').textContent = note;
    $('rentEstimateSection').style.display = '';
    $('rentEstimateStats').querySelectorAll('.rent-stat').forEach(function(el) {
      el.style.cursor = 'pointer';
      el.onclick = function() {
        $('monthlyRent').value = el.querySelector('.rent-value').textContent.replace(/[^0-9]/g, '');
        calculate();
      };
    });
    if (typeof calculate === 'function') calculate();
  }

  // Fires automatically on Analyze so rent is never a manual step.
  async function autoEstimateRent(allowOverage, skipRentcast) {
    if (userEditedFields['monthlyRent']) return;
    var address = (scrapedData && scrapedData.address) || $('propName').value.trim();
    if (!address) return;
    var zipM = address.match(/\d{5}/);
    var location = zipM ? zipM[0] : address;
    try {
      var result = await requestRentEstimate(
        rentEstimateBody(location, allowOverage, skipRentcast)
      );
      var resp = result.resp;
      var data = result.data;
      if (data.usage) updateUsageDisplay(data.usage);
      if (!resp.ok || data.error) return;
      if (data.quota_gate) {
        if (data.estimate) applyRentEstimate(data.estimate, data.comparables);
        if (data.vacancy) applyVacancy(data.vacancy);
        showQuotaGate(
          data.quota_gate,
          function(ok) { autoEstimateRent(ok, false); },
          function() { autoEstimateRent(false, true); }
        );
        return;
      }
      if (data.vacancy) applyVacancy(data.vacancy);
      if (data.estimate) applyRentEstimate(data.estimate, data.comparables);
    } catch (err) { /* silent: the field keeps whatever it had */ }
  }

  // ======================================================================
  // Sensitivity Analysis (computed in renderResults)
  // ======================================================================
  function renderSensitivity(r) {
    var grid = $('sensitivityGrid');
    if (!r || !r.price || r.price <= 0) { grid.innerHTML = ''; return; }

    var html = '';

    // 1. Interest Rate vs Cash Flow
    html += '<div><table class="sensitivity-table"><thead><tr><th colspan="3">Interest Rate &rarr; Cash Flow</th></tr><tr><th>Rate</th><th>Monthly CF</th><th>CoC Return</th></tr></thead><tbody>';
    var baseRate = r.rate;
    var rateSteps = [-2, -1, 0, 1, 2];
    rateSteps.forEach(function(delta) {
      var testRate = Math.max(0, baseRate + delta);
      var monthlyR = testRate / 100 / 12;
      var testPI = 0;
      if (!r.isCash && r.loanAmount > 0 && monthlyR > 0) {
        testPI = r.loanAmount * (monthlyR * Math.pow(1 + monthlyR, r.n)) / (Math.pow(1 + monthlyR, r.n) - 1);
      } else if (!r.isCash && r.loanAmount > 0) {
        testPI = r.loanAmount / r.n;
      }
      var testCF = r.totalMonthlyIncome - r.totalOpex - testPI;
      var testAnnualCF = testCF * 12;
      var testCoC = r.totalCashInvested > 0 ? (testAnnualCF / r.totalCashInvested) * 100 : 0;
      var isCurrent = delta === 0;
      var cfClass = testCF >= 0 ? 'positive' : 'negative';
      html += '<tr><td' + (isCurrent ? ' class="current"' : '') + '>' + testRate.toFixed(1) + '%</td>'
        + '<td class="' + cfClass + (isCurrent ? ' current' : '') + '">' + fmtDollar(testCF) + '</td>'
        + '<td class="' + (testCoC >= 0 ? 'positive' : 'negative') + (isCurrent ? ' current' : '') + '">' + fmtPct(testCoC) + '</td></tr>';
    });
    html += '</tbody></table></div>';

    // 2. Vacancy Rate vs Cash Flow
    html += '<div><table class="sensitivity-table"><thead><tr><th colspan="3">Vacancy Rate &rarr; Cash Flow</th></tr><tr><th>Vacancy</th><th>Monthly CF</th><th>Break-even</th></tr></thead><tbody>';
    var vacSteps = [-5, -3, 0, 3, 5];
    vacSteps.forEach(function(delta) {
      var testVac = Math.max(0, Math.min(50, r.vacPct + delta));
      var testVacExp = r.totalMonthlyIncome * testVac / 100;
      var testTotalOpex = r.totalOpex - (r.totalMonthlyIncome * r.vacPct / 100) + testVacExp;
      var testCF = r.totalMonthlyIncome - testTotalOpex - r.monthlyPI;
      var testExpExVac = testTotalOpex - testVacExp;
      var testBE = r.totalMonthlyIncome > 0 ? ((testExpExVac + r.monthlyPI) / r.totalMonthlyIncome) * 100 : 0;
      var isCurrent = delta === 0;
      var cfClass = testCF >= 0 ? 'positive' : 'negative';
      html += '<tr><td' + (isCurrent ? ' class="current"' : '') + '>' + testVac.toFixed(0) + '%</td>'
        + '<td class="' + cfClass + (isCurrent ? ' current' : '') + '">' + fmtDollar(testCF) + '</td>'
        + '<td' + (isCurrent ? ' class="current"' : '') + '>' + fmtPct(testBE) + '</td></tr>';
    });
    html += '</tbody></table></div>';

    // 3. Rent Change vs Cash Flow
    html += '<div><table class="sensitivity-table"><thead><tr><th colspan="3">Rent Change &rarr; Cash Flow</th></tr><tr><th>Rent +/-</th><th>Monthly CF</th><th>CoC Return</th></tr></thead><tbody>';
    var rentSteps = [-10, -5, 0, 5, 10];
    rentSteps.forEach(function(delta) {
      var testIncome = r.totalMonthlyIncome * (1 + delta / 100);
      // Recalc pct-based expenses
      var testMaint = testIncome * r.maintPct / 100;
      var testVac = testIncome * r.vacPct / 100;
      var testCapex = testIncome * r.capexPct / 100;
      var testMgmt = testIncome * r.mgmtPct / 100;
      var fixedOpex = (r.taxesYr / 12) + (r.insuranceYr / 12) + r.hoaMonth + r.utilMonth + r.otherExpMonth;
      var testOpex = fixedOpex + testMaint + testVac + testCapex + testMgmt;
      var testCF = testIncome - testOpex - r.monthlyPI;
      var testCoC = r.totalCashInvested > 0 ? (testCF * 12 / r.totalCashInvested) * 100 : 0;
      var isCurrent = delta === 0;
      var cfClass = testCF >= 0 ? 'positive' : 'negative';
      html += '<tr><td' + (isCurrent ? ' class="current"' : '') + '>' + (delta >= 0 ? '+' : '') + delta + '%</td>'
        + '<td class="' + cfClass + (isCurrent ? ' current' : '') + '">' + fmtDollar(testCF) + '</td>'
        + '<td class="' + (testCoC >= 0 ? 'positive' : 'negative') + (isCurrent ? ' current' : '') + '">' + fmtPct(testCoC) + '</td></tr>';
    });
    html += '</tbody></table></div>';

    // 4. Purchase Price vs Cap Rate
    html += '<div><table class="sensitivity-table"><thead><tr><th colspan="3">Purchase Price &rarr; Returns</th></tr><tr><th>Price +/-</th><th>Cap Rate</th><th>CoC Return</th></tr></thead><tbody>';
    var priceSteps = [-10, -5, 0, 5, 10];
    priceSteps.forEach(function(delta) {
      var testPrice = r.price * (1 + delta / 100);
      var testNOI = r.noi;
      var testCapRate = testPrice > 0 ? (testNOI / testPrice) * 100 : 0;
      // Recalc loan
      var testDP = r.isCash ? testPrice : testPrice * r.dpPct / 100;
      var testLoan = r.isCash ? 0 : testPrice - testDP;
      var testPI = 0;
      if (!r.isCash && testLoan > 0 && r.monthlyRate > 0) {
        testPI = testLoan * (r.monthlyRate * Math.pow(1 + r.monthlyRate, r.n)) / (Math.pow(1 + r.monthlyRate, r.n) - 1);
      }
      var testCF = r.totalMonthlyIncome - r.totalOpex - testPI;
      var testCash = testDP + r.closingCosts + r.rehab + (testLoan * r.points / 100);
      var testCoC = testCash > 0 ? (testCF * 12 / testCash) * 100 : 0;
      var isCurrent = delta === 0;
      html += '<tr><td' + (isCurrent ? ' class="current"' : '') + '>' + (delta >= 0 ? '+' : '') + delta + '%</td>'
        + '<td' + (isCurrent ? ' class="current"' : '') + '>' + fmtPct(testCapRate) + '</td>'
        + '<td class="' + (testCoC >= 0 ? 'positive' : 'negative') + (isCurrent ? ' current' : '') + '">' + fmtPct(testCoC) + '</td></tr>';
    });
    html += '</tbody></table></div>';

    // 5. Appreciation vs return at the selected exit
    //
    // The four tables above all answer questions about cash flow. This is the
    // only one that moves total return, and appreciation is both the largest
    // and the least certain input — so it belongs beside them rather than
    // being reachable only through the scenario picker.
    if (r.apprBand && r.exitAt) {
      html += '<div><table class="sensitivity-table"><thead><tr><th colspan="3">Appreciation &rarr; ' + (r.holdYears || 5) + '-Year Pre-Tax Return</th></tr><tr><th>Rate</th><th>After Selling Costs</th><th>Pre-Tax Profit</th></tr></thead><tbody>';
      var rows = r.apprBand.scenarios.map(function(sc) {
        return { label: sc.label, pct: sc.pct, current: sc.active };
      });
      // A hand-typed rate is not one of the scenarios, so give it its own row
      // rather than leaving the table with nothing highlighted.
      if (r.apprBand.custom) {
        rows.push({ label: 'Your rate', pct: r.valueGrowthPct, current: true });
        rows.sort(function(a, b) { return a.pct - b.pct; });
      }
      rows.forEach(function(row) {
        var out = r.exitAt(row.pct);
        var cur = row.current ? ' current' : '';
        html += '<tr><td class="' + cur.trim() + '">' + fmt(row.pct) + '% ' + row.label + '</td>'
          + '<td class="' + (out.appreciationAfterSellingCosts >= 0 ? 'positive' : 'negative') + cur + '">' + fmtDollar(out.appreciationAfterSellingCosts) + '</td>'
          + '<td class="' + (out.preTaxProfit >= 0 ? 'positive' : 'negative') + cur + '">' + fmtDollar(out.preTaxProfit) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }

    grid.innerHTML = html;
  }

  // ======================================================================
  // Get Total Monthly Rent
  // ======================================================================
  function getTotalRent() {
    if (propertyType === 'sfh') {
      return val($('monthlyRent'), 0);
    } else {
      var count = parseInt($('unitCount').value);
      var inputs = $('unitRentsGrid').querySelectorAll('.unit-rent');
      var total = 0;
      inputs.forEach(function(inp, i) { if (i < count) total += val(inp, 0); });
      return total;
    }
  }

  // ======================================================================
  // Calculation Engine
  //
  // Split in two on purpose. readInputs() is the only thing that touches the
  // form; computeDeal() is pure arithmetic over a plain object. That lets the
  // what-if page recompute against overridden values without writing anything
  // into the form the user is still editing — and guarantees both views run
  // the identical model, so they cannot drift apart.
  // ======================================================================
  function readInputs() {
    var isCash = $('cashPurchase').checked;
    return {
      price: val($('purchasePrice'), 0),
      arv: val($('arv'), 0),
      closingCosts: val($('closingCosts'), 0),
      rehab: val($('rehabBudget'), 0),
      valueGrowthPct: val($('valueGrowth'), -25, 50),
      isCash: isCash,
      dpPct: isCash ? 100 : val($('downPayment'), 0, 100),
      rate: isCash ? 0 : val($('interestRate'), 0, 30),
      termYears: isCash ? 0 : Math.max(1, Math.round(val($('loanTerm'), 1, 50))),
      points: isCash ? 0 : val($('points'), 0, 10),
      totalRent: getTotalRent(),
      otherIncome: val($('otherIncome'), 0),
      incomeGrowthPct: val($('incomeGrowth'), 0, 50),
      taxesYr: val($('propertyTaxes'), 0),
      taxGrowthOverridePct: optionalVal($('propertyTaxGrowth'), -25, 50),
      propertyTaxPolicy: propertyTaxPolicy,
      insuranceYr: val($('insurance'), 0),
      maintPct: val($('maintenance'), 0, 100),
      vacPct: val($('vacancy'), 0, 100),
      capexPct: val($('capex'), 0, 100),
      mgmtPct: val($('management'), 0, 100),
      hoaMonth: val($('hoa'), 0),
      utilMonth: val($('utilities'), 0),
      otherExpMonth: val($('otherExpenses'), 0),
      expGrowthPct: val($('expenseGrowth'), 0, 50),
      sqft: val($('sqft'), 0),
      buildingPct: val($('buildingPct'), 0, 100),
      sellingCostPct: val($('sellingCostPct'), 0, 20),
      holdYears: Math.max(1, Math.min(PROJECTION_YEARS, parseInt($('holdYears').value) || 10)),
      propertyType: propertyType,
      unitCount: propertyType === 'sfh' ? 1 : Math.max(1, parseInt($('unitCount').value) || 1),
      // Passed in rather than read from the module global, so a computed deal
      // is fully determined by its inputs.
      appreciationProfile: appreciationProfile,
      projectionStartYear: new Date().getFullYear()
    };
  }

  function calculate() {
    var inputs = readInputs();
    lastCalcResults = computeDeal(inputs);
    lastTaxContext = computeTaxContext(inputs);
    // Only update DOM if on step 6 — unchanged from before the split.
    if (currentStep === 6) renderResults();
    formatCurrencyInputs();
  }

  var computeDeal = window.DealEngine.computeDeal;
  var computeTaxContext = window.DealEngine.computeTaxContext;
  var buildAmortSchedule = window.DealEngine.buildAmortSchedule;
  // ======================================================================
  function renderResults() {
    var r = lastCalcResults;

    // Property Summary
    var summaryEl = $('resultsPropSummary');
    var addr = scrapedData && scrapedData.address ? scrapedData.address : null;
    // Build details line from inputs if no scraped data
    var price = r.price;
    if (addr || price) {
      var manualName = $('propName').value.trim();
      $('resultsPropAddr').textContent = addr || manualName || 'Manual Entry';
      var dets = [];
      if (scrapedData && scrapedData.beds) dets.push(scrapedData.beds + ' bed');
      if (scrapedData && scrapedData.baths) dets.push(scrapedData.baths + ' bath');
      if (scrapedData && scrapedData.sqft) dets.push(fmtInt(scrapedData.sqft) + ' sqft');
      if (scrapedData && scrapedData.yearBuilt) dets.push('Built ' + scrapedData.yearBuilt);
      if (scrapedData && scrapedData.propertyType) dets.push(scrapedData.propertyType);
      $('resultsPropDetails').textContent = dets.length ? dets.join(' | ') : (r.propertyType === 'sfh' ? 'Single Family' : 'Multifamily');
      $('resultsPropPrice').textContent = fmtDollar(price);
      var img = $('resultsPropImg');
      if (scrapedData && scrapedData.imageUrl) {
        img.src = scrapedData.imageUrl;
        img.alt = 'Property at ' + (addr || manualName || 'unknown address');
        img.onerror = function() { this.style.display = 'none'; };
        img.style.display = '';
      } else {
        img.style.display = 'none';
      }
      summaryEl.style.display = '';
    } else {
      summaryEl.style.display = 'none';
    }

    // A) Overview
    var cfWarning = r.monthlyCF < 0 ? ' <span class="negative-cf-warning">Negative</span>' : '';
    setMetricColor('resMonthlyCF', fmtDollar(r.monthlyCF), r.monthlyCF);
    // Append warning badge for negative CF
    if (r.monthlyCF < 0) {
      var cfEl = $('resMonthlyCF');
      cfEl.innerHTML = cfEl.textContent + cfWarning;
    }
    setMetricColor('resCoC', fmtPct(r.coc), r.coc);
    setMetricText('resCapRate', fmtPct(r.capRate));
    setMetricText('res5yrROI', fmtPct(r.preTaxAnnualizedROI));

    // B) Quick Rules
    $('rule1Badge').textContent = r.onePercentPass ? 'PASS' : 'FAIL';
    $('rule1Badge').className = 'badge ' + (r.onePercentPass ? 'badge-pass' : 'badge-fail');
    $('rule1Desc').textContent = 'Monthly rent (' + fmtDollar(r.totalMonthlyIncome) + ') is ' + fmt(r.onePercentPct) + '% of purchase price (' + fmtDollar(r.price) + ')';

    var fiftyPass = r.fiftyPctRatio <= 50;
    $('rule50Badge').textContent = fiftyPass ? 'PASS' : 'FAIL';
    $('rule50Badge').className = 'badge ' + (fiftyPass ? 'badge-pass' : 'badge-fail');
    $('rule50Desc').textContent = 'Operating expenses are ' + fmt(r.fiftyPctRatio) + '% of income (benchmark: 50%)';

    if (r.show70) {
      $('rule70pct').style.display = '';
      $('rule70Badge').textContent = r.seventyPctPass ? 'PASS' : 'FAIL';
      $('rule70Badge').className = 'badge ' + (r.seventyPctPass ? 'badge-pass' : 'badge-fail');
      $('rule70Desc').textContent = 'Purchase + rehab (' + fmtDollar(r.price + r.rehab) + ') is ' + fmt(r.seventyPctVal) + '% of ARV (' + fmtDollar(r.arv) + ')';
    } else {
      $('rule70pct').style.display = 'none';
    }

    // C) Detailed Metrics
    setMetricText('resNOI', fmtDollar(r.noi));
    setMetricText('resPI', fmtDollar(r.monthlyPI));
    setMetricText('resPITI', fmtDollar(r.piti));
    setMetricText('resTotalExp', fmtDollar(r.totalOpex));
    setMetricText('resGRM', fmtGRM(r.grm));
    setMetricColor('resBreakeven', fmtPct(r.breakeven), r.breakeven <= 85 ? 1 : -1);
    setMetricColor('resDSCR', r.dscr !== null ? fmt(r.dscr) : 'N/A', r.dscr === null ? 1 : (r.dscr >= 1.0 ? 1 : -1));
    setMetricText('resCashClose', fmtDollar(r.totalCashClose));

    // New detailed metrics
    setMetricText('resOER', fmtPct(r.oer));
    setMetricColor('resCFPerUnit', fmtDollar(r.monthlyCFPerUnit), r.monthlyCFPerUnit);
    setMetricText('resDepreciation', fmtDollar(lastTaxContext.roughAnnualDepreciation || 0));
    if (r.pricePerSqft !== null) {
      $('resPricePerSqftCard').style.display = '';
      setMetricText('resPricePerSqft', fmtDollar(r.pricePerSqft));
    } else {
      $('resPricePerSqftCard').style.display = 'none';
    }
    if (r.rentPerSqft !== null) {
      $('resRentPerSqftCard').style.display = '';
      setMetricText('resRentPerSqft', '$' + fmt(r.rentPerSqft));
    } else {
      $('resRentPerSqftCard').style.display = 'none';
    }

    // D) Deal Score
    var ds = $('dealScore');
    ds.classList.remove('great', 'borderline', 'pass');
    ds.classList.add(r.dealGrade);
    $('dealVerdict').textContent = r.dealText;
    $('dealExplanation').textContent = r.dealExpl;

    // D2) Investment Summary
    // Return pillars
    var pillarsHtml = '';
    var histRate = r.exitHistorical ? fmt(r.exitHistorical.ratePct) + '%' : null;
    var pillars = [
      { label: 'Cash Flow', val: r.totalReturnCF },
      { label: 'Appreciation after selling costs', val: r.appreciationAfterSellingCosts,
        alt: r.exitHistorical ? r.exitHistorical.appreciationAfterSellingCosts : null },
      { label: 'Debt Paydown', val: r.totalReturnDebtPaydown },
      { label: 'Closing, rehab & points', val: -(r.closingCosts + r.rehab + r.pointsCost) }
    ];
    pillars.forEach(function(p) {
      var valClass = p.val >= 0 ? 'positive' : 'negative';
      // The base case is conservative by design, so the historical figure sits
      // beside it rather than a click away — the upside is not a reward for
      // going looking.
      var altText = (p.alt !== null && p.alt !== undefined && histRate)
        ? '<div class="pillar-alt">' + fmtDollar(p.alt) + ' at ' + histRate + '</div>' : '';
      pillarsHtml += '<div class="pillar-card"><div class="pillar-label">' + p.label + '</div><div class="pillar-value ' + valClass + '">' + fmtDollar(p.val) + '</div>' + altText + '</div>';
    });
    pillarsHtml += '<div class="pillar-card pillar-total" style="grid-column: 1 / -1;"><div class="pillar-label">' + (r.holdYears || 5) + '-Year Pre-Tax Profit (after selling costs)</div><div class="pillar-value">' + fmtDollar(r.preTaxProfit) + '</div><div class="pillar-pct">' + fmtPct(r.totalCashInvested > 0 ? r.preTaxProfit / r.totalCashInvested * 100 : 0) + ' on ' + fmtDollar(r.totalCashInvested) + ' invested &middot; ' + fmtPct(r.preTaxAnnualizedROI) + '/yr' + (r.preTaxIRR !== null ? ' &middot; ' + fmtPct(r.preTaxIRR) + ' IRR' : '') + '</div>' +
      (r.exitHistorical
        ? '<div class="pillar-alt">' + fmtDollar(r.exitHistorical.preTaxProfit) +
          ' if ' + (appreciationProfile && appreciationProfile.zip ? appreciationProfile.zip : 'this area') +
          ' repeats its ' + histRate + ' history</div>'
        : '') + '</div>';
    $('returnPillars').innerHTML = pillarsHtml;

    // Every label that used to say "5-Year" now follows the chosen hold.
    var hy = r.holdYears || 5;
    var setTxt = function(id, t) { var e = $(id); if (e) e.textContent = t; };
    setTxt('roiLabel', hy + 'yr');
    setTxt('summaryHoldLabel', hy + '-Year');
    setTxt('projHoldLabel', hy + '-Year');

    renderExitCosts(r);
    renderApprBand(r);
    var gw = $('growthWarning');
    if (r.growthWarning) { gw.textContent = r.growthWarning; gw.style.display = ''; }
    else { gw.style.display = 'none'; }

    // Factor scorecard
    var factorHtml = '';
    var factorIcons = { strong: '\u2713', ok: '\u2013', weak: '\u2717' };
    r.dealFactors.forEach(function(f) {
      var icon = factorIcons[f.verdict] || '';
      factorHtml += '<div class="factor-row"><div class="factor-dot ' + f.verdict + '" title="' + f.verdict + '">' + icon + '</div><div class="factor-name">' + f.name + '</div><div class="factor-val">' + f.value + '</div><div class="factor-reason">' + f.reason + '</div></div>';
    });
    $('factorList').innerHTML = factorHtml;

    // Strategy fit
    var stratHtml = '';
    // Cash Flow strategy
    var cfGood = r.coc >= 8 && r.monthlyCFPerUnit >= 200 && (r.dscr === null || r.dscr >= 1.25);
    var cfOk = r.coc >= 4 && r.monthlyCFPerUnit >= 100;
    stratHtml += '<div class="strategy-card"><div class="strat-title">Cash Flow</div><div class="strat-fit ' + (cfGood ? 'good' : (cfOk ? 'good' : 'poor')) + '">' + (cfGood ? 'Strong Fit' : (cfOk ? 'Moderate Fit' : 'Poor Fit')) + '</div><div class="strat-detail">CoC ' + fmtPct(r.coc) + ', ' + fmtDollar(r.monthlyCFPerUnit) + '/unit' + (r.dscr !== null ? ', DSCR ' + fmt(r.dscr) : '') + '</div></div>';

    // Wealth Building strategy
    var totalReturnPct = r.totalCashInvested > 0 ? r.preTaxProfit / r.totalCashInvested * 100 : 0;
    var wbGood = totalReturnPct >= 50;
    var wbOk = totalReturnPct >= 25;
    stratHtml += '<div class="strategy-card"><div class="strat-title">Wealth Building</div><div class="strat-fit ' + (wbGood ? 'good' : (wbOk ? 'good' : 'poor')) + '">' + (wbGood ? 'Strong Fit' : (wbOk ? 'Moderate Fit' : 'Poor Fit')) + '</div><div class="strat-detail">' + (r.holdYears || 5) + 'yr return ' + fmtPct(totalReturnPct) + ', appreciation ' + fmtDollar(r.totalReturnAppreciation) + '</div></div>';

    // Low Risk strategy
    var lrGood = r.breakeven <= 75 && (r.dscr === null || r.dscr >= 1.5) && r.fiftyPctRatio <= 50;
    var lrOk = r.breakeven <= 85 && (r.dscr === null || r.dscr >= 1.25);
    stratHtml += '<div class="strategy-card"><div class="strat-title">Low Risk</div><div class="strat-fit ' + (lrGood ? 'good' : (lrOk ? 'good' : 'poor')) + '">' + (lrGood ? 'Strong Fit' : (lrOk ? 'Moderate Fit' : 'Poor Fit')) + '</div><div class="strat-detail">Break-even ' + fmtPct(r.breakeven) + (r.dscr !== null ? ', DSCR ' + fmt(r.dscr) : '') + ', OER ' + fmtPct(r.oer) + '</div></div>';
    $('strategyNotes').innerHTML = stratHtml;

    // E) Projection — projRows always runs 30 years for the what-if page, so
    // trim it to the holding period actually being analysed.
    var projBody = $('projBody');
    projBody.innerHTML = '';
    r.projRows.slice(0, r.holdYears || 5).forEach(function(row) {
      var tr = document.createElement('tr');
      var cfClass = row.cf >= 0 ? 'positive' : 'negative';
      tr.innerHTML = '<td>' + row.year + '</td><td class="' + cfClass + '">' + fmtDollar(row.cf) + '</td><td>' + fmtDollar(row.propertyTax) + '</td><td>' + fmtDollar(row.propVal) + '</td><td>' + fmtDollar(row.loanBal) + '</td><td>' + fmtDollar(row.equity) + '</td><td>' + fmtPct(row.cumROI) + '</td>';
      projBody.appendChild(tr);
    });

    // F) Amortization Table
    var amortSection = $('amortSection');
    if (r.isCash || r.loanAmount <= 0) {
      amortSection.style.display = 'none';
    } else {
      amortSection.style.display = '';
      var amortBody = $('amortBody');
      var amortFoot = $('amortFoot');
      amortBody.innerHTML = '';
      amortFoot.innerHTML = '';

      var grandPayment = 0, grandPrincipal = 0, grandInterest = 0;
      r.amortSchedule.forEach(function(row) {
        grandPayment += row.payment;
        grandPrincipal += row.principal;
        grandInterest += row.interest;
        var propValYr = r.price * Math.pow(1 + r.valueGrowthPct / 100, row.year);
        var equity = propValYr - row.balance;
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + row.year + '</td><td>' + fmtDollar(row.payment) + '</td><td>' + fmtDollar(row.principal) + '</td><td>' + fmtDollar(row.interest) + '</td><td>' + fmtDollar(row.balance) + '</td><td>' + fmtDollar(equity) + '</td>';
        amortBody.appendChild(tr);
      });

      var tfr = document.createElement('tr');
      tfr.innerHTML = '<td>Total</td><td>' + fmtDollar(grandPayment) + '</td><td>' + fmtDollar(grandPrincipal) + '</td><td>' + fmtDollar(grandInterest) + '</td><td>&mdash;</td><td>&mdash;</td>';
      amortFoot.appendChild(tfr);
    }

    // G) Equity Chart
    var equityChart = $('equityChart');
    if (r.isCash || r.loanAmount <= 0) {
      equityChart.style.display = 'none';
    } else {
      equityChart.style.display = '';
      renderEquityChart(r);
    }

    // H) Sensitivity Analysis
    renderSensitivity(r);

    // Pillars and scorecard rows are built here, so annotate the new labels.
    attachTooltips($('step6'));
  }

  function setMetricColor(id, text, value) {
    var el = $(id);
    var changed = el.textContent !== text;
    el.textContent = text;
    el.className = 'value ' + (value >= 0 ? 'positive' : 'negative');
    if (changed) flashMetric(el);
  }

  function setMetricText(id, text) {
    var el = $(id);
    if (el.textContent !== text) {
      el.textContent = text;
      flashMetric(el);
    }
  }

  function flashMetric(el) {
    el.classList.remove('metric-flash');
    void el.offsetWidth; // force reflow to restart animation
    el.classList.add('metric-flash');
  }

  // ======================================================================
  // What selling actually costs
  //
  // Sale price is not cash in hand. Selling costs and the loan payoff are
  // shown as readable subtractions rather than folded into one number.
  // ======================================================================
  function renderExitCosts(r) {
    var el = $('exitBlock');
    if (!el) return;
    var row = function(label, amount, cls) {
      // Negating a zero cost yields -0, which formats as "$-0.00".
      if (amount === 0) amount = 0;
      return '<div class="exit-row"><span class="exit-label">' + label + '</span>' +
        '<span class="' + (amount < 0 ? (cls || '') : '') + '">' + fmtDollar(amount) + '</span></div>';
    };
    var html = '<h4>If you sold at year ' + (r.holdYears || 5) + '</h4>';
    html += row('Sale price at ' + fmt(r.valueGrowthPct) + '%/yr', r.saleValue);
    html += row('Selling costs (' + fmt(r.sellingCostPct) + '%)', -r.sellingCosts, 'neg');
    html += row('Loan payoff', -r.exitLoanBal, 'neg');
    html += '<div class="exit-row exit-sum"><span class="exit-label">Pre-tax net sale proceeds</span><span class="' +
      (r.preTaxNetSaleProceeds >= 0 ? 'pos' : 'neg') + '">' + fmtDollar(r.preTaxNetSaleProceeds) + '</span></div>';
    html += '<div class="exit-note">Appreciation before these costs was ' + fmtDollar(r.totalReturnAppreciation) +
      '; after selling costs it is ' + fmtDollar(r.appreciationAfterSellingCosts) +
      '. Income taxes are intentionally excluded; this is a pre-tax underwriting result.</div>';
    el.innerHTML = html;
    el.style.display = '';
  }

  // ======================================================================
  // The range the rate could plausibly have taken
  //
  // A single compounding curve says nothing about how volatile a market is,
  // and volatility is most of the risk on a five-year hold. These are real
  // outcomes from this ZIP's own history, not a symmetric error bar.
  // ======================================================================
  function renderApprBand(r) {
    var el = $('apprBand');
    if (!el) return;
    var b = r.apprBand;
    if (!b) { el.style.display = 'none'; return; }
    var tone = { downturn: 'band-low', conservative: '', historical: '', strong: 'band-high' };
    var hy = r.holdYears || 5;
    var html = '<h4>What if appreciation is\u2026 <span class="band-hint">value at year ' + hy +
      '; pick one to rerun every number below</span></h4>';
    html += '<div class="band-scale">';
    b.scenarios.forEach(function(sc) {
      html += '<button type="button" class="band-cell ' + (tone[sc.key] || '') +
        (sc.active ? ' band-active' : '') +
        '" onclick="setApprScenario(\'' + sc.key + '\',' + sc.pct + ')">' +
        '<div class="band-label">' + sc.label + '</div>' +
        '<div class="band-value">$' + fmtInt(sc.value) + '</div>' +
        '<div class="band-label">' + fmt(sc.pct) + '%/yr</div>' +
        '<div class="band-note">' + sc.note + '</div></button>';
    });
    html += '</div>';
    if (b.custom) {
      html += '<div class="band-custom">Running on a rate you entered (' + fmt(b.rate) +
        '%/yr). Pick a scenario above to switch back.</div>';
    }
    if (b.worstPct !== null && b.worstPct < 0) {
      html += '<div class="band-worst">In this area\u2019s worst ' + (b.bandYears || 5) +
        '-year stretch on record, a $' + fmtInt(r.price) + ' property fell to <strong>$' +
        fmtInt(b.worst) + '</strong> \u2014 a ' + Math.round(Math.abs(b.worstPct)) + '% loss.</div>';
    }
    html += '<div class="exit-note">Downturn and Strong are the 10th and 90th percentile of every ' +
      'overlapping ' + (b.bandYears || 5) + '-year window in ' + b.label +
      ' (FHFA repeat-sales index, ' + b.window + ')' +
      ((b.bandYears || 5) < hy ? ' \u2014 the longest window with enough history for a ' + hy + '-year hold' : '') + '. ' +
      'The default sits near long-run inflation rather than at the historical average, so a deal has ' +
      'to work on cash flow and any real appreciation is upside \u2014 switch to Historical to see what ' +
      'this area actually did.</div>';
    el.innerHTML = html;
    el.style.display = '';
  }

  // ======================================================================
  // What-If — drag an assumption, watch the whole deal move
  //
  // Runs the same computeDeal() the wizard does, against a copy of the inputs.
  // Nothing is written back to the form until Apply, so exploring is free and
  // reversible; and because there is only one engine, the two views cannot
  // drift apart.
  // ======================================================================
  var whatifSeed = null;      // inputs as they were when the page was opened
  var whatifOverrides = {};   // only what the sliders have actually moved
  var whatifGroupOpen = {};   // groups the user has since opened or closed

  // Grouped the way the wizard groups its steps, because a flat column of two
  // dozen sliders is a wall rather than a control. The defaults follow what
  // actually gets dragged: the inputs that set the shape of the deal are open,
  // the individual expense lines are one click away.
  var WHATIF_GROUPS = [
    { key: 'purchase', label: 'Purchase',           open: true  },
    { key: 'loan',     label: 'Loan',               open: true  },
    { key: 'income',   label: 'Income',             open: true  },
    { key: 'opex',     label: 'Operating expenses', open: false },
    { key: 'exit',     label: 'Assumptions & exit', open: false }
  ];

  // Ranges are relative to the seeded value so the slider is useful whether the
  // property is $80K or $2M. `floorMax` covers the fields that legitimately
  // seed at zero -- rehab, HOA, other income -- where scaling nothing by two is
  // still nothing, so the ceiling falls back to an absolute figure.
  //
  // Left out on purpose: ARV and building % feed the 70% rule and the
  // depreciation split rather than the return path, and square footage is
  // descriptive only. Dragging them would move nothing shown here.
  var WHATIF_SLIDERS = [
    { key: 'price',           group: 'purchase', label: 'Purchase price', rel: [0.6, 1.4], step: 1000, fmt: 'money' },
    { key: 'closingCosts',    group: 'purchase', label: 'Closing costs',  rel: [0, 2], floorMax: 20000, step: 250, fmt: 'money' },
    { key: 'rehab',           group: 'purchase', label: 'Rehab budget',   rel: [0, 2], floorMax: 50000, step: 500, fmt: 'money' },

    { key: 'dpPct',           group: 'loan',     label: 'Down payment',   abs: [0, 100],  step: 1,     fmt: 'pct' },
    { key: 'rate',            group: 'loan',     label: 'Interest rate',  abs: [2, 12],   step: 0.125, fmt: 'pct' },
    { key: 'termYears',       group: 'loan',     label: 'Loan term',      abs: [10, 40],  step: 5,     fmt: 'yrs' },
    { key: 'points',          group: 'loan',     label: 'Points',         abs: [0, 5],    step: 0.25,  fmt: 'plain' },

    { key: 'totalRent',       group: 'income',   label: 'Monthly rent',   rel: [0.6, 1.5], step: 25, fmt: 'money' },
    { key: 'otherIncome',     group: 'income',   label: 'Other income',   rel: [0, 3], floorMax: 500, step: 25, fmt: 'money' },
    { key: 'vacPct',          group: 'income',   label: 'Vacancy',        abs: [0, 25],   step: 0.5,  fmt: 'pct' },
    { key: 'incomeGrowthPct', group: 'income',   label: 'Rent growth',    abs: [0, 8],    step: 0.25, fmt: 'pct' },

    { key: 'taxesYr',         group: 'opex',     label: 'Property taxes', rel: [0, 2], floorMax: 12000, step: 100, fmt: 'money-yr' },
    { key: 'insuranceYr',     group: 'opex',     label: 'Insurance',      rel: [0, 2], floorMax: 5000,  step: 50,  fmt: 'money-yr' },
    { key: 'maintPct',        group: 'opex',     label: 'Maintenance',    abs: [0, 25],   step: 0.5,  fmt: 'pct' },
    { key: 'capexPct',        group: 'opex',     label: 'CapEx reserve',  abs: [0, 30],   step: 0.5,  fmt: 'pct' },
    { key: 'mgmtPct',         group: 'opex',     label: 'Management',     abs: [0, 20],   step: 0.5,  fmt: 'pct' },
    { key: 'hoaMonth',        group: 'opex',     label: 'HOA',            rel: [0, 2], floorMax: 600, step: 25, fmt: 'money' },
    { key: 'utilMonth',       group: 'opex',     label: 'Utilities',      rel: [0, 2], floorMax: 500, step: 25, fmt: 'money' },
    { key: 'otherExpMonth',   group: 'opex',     label: 'Other expenses', rel: [0, 2], floorMax: 500, step: 25, fmt: 'money' },
    { key: 'expGrowthPct',    group: 'opex',     label: 'Expense growth', abs: [0, 8],    step: 0.25, fmt: 'pct' },

    // Wide enough to reach this ZIP's own Downturn scenario, which runs past
    // -10%/yr in the weaker markets, and matching what readInputs() accepts.
    { key: 'valueGrowthPct',  group: 'exit',     label: 'Appreciation',   abs: [-25, 15], step: 0.25, fmt: 'pct' },
    // The form field is a <select>, so this steps through its options rather
    // than a continuous range -- any other value could not be applied back.
    { key: 'holdYears',       group: 'exit',     label: 'Hold period',    opts: [5, 10, 15, 20, 30], fmt: 'yrs' },
    { key: 'sellingCostPct',  group: 'exit',     label: 'Selling costs',  abs: [0, 12],   step: 0.5,  fmt: 'pct' }
  ];

  function wfFmt(kind, v) {
    if (kind === 'money') return '$' + fmtInt(v);
    if (kind === 'money-yr') return '$' + fmtInt(v) + '/yr';
    if (kind === 'yrs') return Math.round(v) + ' yr';
    if (kind === 'plain') return fmt(v);
    return fmt(v) + '%';
  }

  function whatifOpen() {
    var seed = readInputs();
    // Cash purchases have no loan sliders worth dragging, and a property with
    // no price cannot be explored at all.
    if (!seed.price || seed.price <= 0) {
      $('whatifEmpty').style.display = '';
      $('whatifBody').style.display = 'none';
      return;
    }
    $('whatifEmpty').style.display = 'none';
    $('whatifBody').style.display = '';
    whatifSeed = seed;
    whatifOverrides = {};
    renderWhatifSliders();
    whatifRecalc();
  }

  function wfSeedVal(sl) {
    var v = whatifSeed[sl.key];
    if (typeof v !== 'number' || isNaN(v)) v = 0;
    return v;
  }

  // The slider element's own min/max/step, which is not the value range for
  // `opts` sliders -- those index into the option list.
  function wfRange(sl, seedVal) {
    if (sl.opts) return { lo: 0, hi: sl.opts.length - 1, step: 1 };
    if (sl.abs) return { lo: sl.abs[0], hi: sl.abs[1], step: sl.step };
    var lo = Math.max(0, Math.round(seedVal * sl.rel[0] / sl.step) * sl.step);
    var hi = Math.round(Math.max(seedVal * sl.rel[1], sl.floorMax || 0) / sl.step) * sl.step;
    if (hi <= lo) hi = lo + sl.step * 10;
    return { lo: lo, hi: hi, step: sl.step };
  }

  // Where the handle sits for a given value. Clamped, so a seed outside the
  // range still renders a usable slider rather than pinning at an edge the
  // browser picked.
  function wfPos(sl, v, range) {
    if (!sl.opts) return Math.min(range.hi, Math.max(range.lo, v));
    var best = 0;
    sl.opts.forEach(function(o, i) {
      if (Math.abs(o - v) < Math.abs(sl.opts[best] - v)) best = i;
    });
    return best;
  }

  function whatifMovedKeys() {
    return Object.keys(whatifOverrides).filter(function(k) {
      return Math.abs(whatifOverrides[k] - whatifSeed[k]) > 1e-9;
    });
  }

  function renderWhatifSliders() {
    var html = '';
    WHATIF_GROUPS.forEach(function(g) {
      var rows = '';
      WHATIF_SLIDERS.forEach(function(sl) {
        if (sl.group !== g.key) return;
        var seedVal = wfSeedVal(sl);
        var cur = whatifOverrides.hasOwnProperty(sl.key) ? whatifOverrides[sl.key] : seedVal;
        var range = wfRange(sl, seedVal);
        rows += '<div class="wf-row" data-key="' + sl.key + '">' +
          '<div class="wf-head"><span class="wf-name">' + sl.label + '</span>' +
          '<span class="wf-cur" id="wfcur-' + sl.key + '">' + wfFmt(sl.fmt, cur) + '</span></div>' +
          '<input type="range" min="' + range.lo + '" max="' + range.hi + '" step="' + range.step + '" ' +
          'value="' + wfPos(sl, cur, range) + '" ' +
          'oninput="whatifSlide(\'' + sl.key + '\', this.value)">' +
          '<div class="wf-seed">now ' + wfFmt(sl.fmt, seedVal) + '</div></div>';
      });
      var open = whatifGroupOpen.hasOwnProperty(g.key) ? whatifGroupOpen[g.key] : g.open;
      // The badge is always emitted and filled by whatifRecalc, so a change
      // made inside a group that is later collapsed does not go invisible.
      html += '<details class="wf-group"' + (open ? ' open' : '') +
        ' ontoggle="whatifGroupToggle(\'' + g.key + '\', this.open)">' +
        '<summary><span class="wf-group-title">' + g.label + '</span>' +
        '<span class="wf-group-badge" id="wfbadge-' + g.key + '" style="display:none"></span></summary>' +
        '<div class="wf-group-body">' + rows + '</div></details>';
    });
    $('whatifSliders').innerHTML = html;
  }

  window.whatifGroupToggle = function(key, open) { whatifGroupOpen[key] = open; };

  window.whatifSlide = function(key, raw) {
    var sl = WHATIF_SLIDERS.filter(function(x) { return x.key === key; })[0];
    var v = sl.opts ? sl.opts[Math.round(parseFloat(raw))] : parseFloat(raw);
    whatifOverrides[key] = v;
    var cur = $('wfcur-' + key);
    if (cur) {
      cur.textContent = wfFmt(sl.fmt, v);
      cur.classList.toggle('moved', Math.abs(v - whatifSeed[key]) > 1e-9);
    }
    // computeDeal is pure arithmetic over a 360-month schedule — fast enough
    // to run on every frame, so a debounce would only add lag.
    if (whatifRaf) cancelAnimationFrame(whatifRaf);
    whatifRaf = requestAnimationFrame(whatifRecalc);
  };
  var whatifRaf = null;

  function whatifInputs() {
    var inp = Object.assign({}, whatifSeed, whatifOverrides);
    // A cash purchase has no loan; keep the derived flags coherent with the
    // down-payment slider rather than the seeded checkbox.
    if (inp.dpPct >= 100) { inp.isCash = true; inp.rate = 0; inp.termYears = 0; inp.points = 0; }
    else { inp.isCash = false; }
    return inp;
  }

  function whatifRecalc() {
    if (!whatifSeed) return;
    var base = computeDeal(whatifSeed);
    var now = computeDeal(whatifInputs());
    renderWhatifHeadline(base, now);
    renderWhatifTable(now);
    renderWhatifChart(now);
    var moved = whatifMovedKeys();
    // Counts per group, so a collapsed group still advertises what is changed
    // inside it. Updated here rather than by re-rendering, which would tear
    // the slider out from under a drag in progress.
    var perGroup = {};
    moved.forEach(function(k) {
      var sl = WHATIF_SLIDERS.filter(function(x) { return x.key === k; })[0];
      if (sl) perGroup[sl.group] = (perGroup[sl.group] || 0) + 1;
    });
    WHATIF_GROUPS.forEach(function(g) {
      var badge = $('wfbadge-' + g.key);
      if (!badge) return;
      var n = perGroup[g.key] || 0;
      badge.textContent = n ? n + ' changed' : '';
      badge.style.display = n ? '' : 'none';
    });
    $('whatifDirty').textContent = moved.length
      ? moved.length + ' assumption' + (moved.length > 1 ? 's' : '') + ' changed — not yet applied'
      : 'Matching your analysis';
  }

  function renderWhatifHeadline(base, now) {
    var stats = [
      { label: 'Monthly cash flow', v: now.monthlyCF, b: base.monthlyCF, money: true },
      { label: 'Cash-on-cash', v: now.coc, b: base.coc, money: false },
      { label: 'Cap rate', v: now.capRate, b: base.capRate, money: false },
      { label: 'DSCR', v: now.dscr, b: base.dscr, money: false, plain: true },
      { label: (now.holdYears || 5) + '-yr pre-tax profit', v: now.preTaxProfit, b: base.preTaxProfit, money: true },
      // Null for a cash-negative deal with no root, and for a purchase with no
      // cash in it -- the stat loop drops it rather than printing a placeholder.
      { label: 'Pre-tax IRR', v: now.preTaxIRR, b: base.preTaxIRR, money: false }
    ];
    var html = '';
    stats.forEach(function(s) {
      if (s.v === null || s.v === undefined) return;
      var txt = s.plain ? fmt(s.v) : (s.money ? fmtDollar(s.v) : fmtPct(s.v));
      var d = s.v - (s.b || 0);
      var delta = Math.abs(d) < 0.005 ? 'unchanged'
        : (d > 0 ? '+' : '') + (s.plain ? fmt(d) : (s.money ? fmtDollar(d) : fmtPct(d))) + ' vs your analysis';
      html += '<div class="wf-stat"><div class="wf-label">' + s.label + '</div>' +
        '<div class="wf-value ' + (s.v >= 0 ? 'positive' : 'negative') + '">' + txt + '</div>' +
        '<div class="wf-delta">' + delta + '</div></div>';
    });
    $('whatifHeadline').innerHTML = html;
  }

  var WHATIF_YEARS = [1, 2, 3, 4, 5, 10, 15, 20, 30];

  // The full annual picture rather than a value/equity summary: income and
  // expenses both grow, at different rates, so the year a deal turns is not
  // something you can read off the equity curve. Wide on purpose -- the
  // wrapper scrolls horizontally.
  function renderWhatifTable(r) {
    var rows = WHATIF_YEARS.filter(function(y) { return y <= r.projRows.length; });
    var hold = r.holdYears || 5;
    var html = '<thead><tr><th>Year</th><th>Income</th><th>Expenses</th><th>Property tax</th>' +
      '<th>Operating income</th><th>Cash flow</th><th>CoC</th>' +
      '<th>Property value</th><th>Loan balance</th><th>Equity</th>' +
      '<th>Profit if sold</th><th>Annualized</th></tr></thead><tbody>';
    rows.forEach(function(y) {
      var row = r.projRows[y - 1];
      var exit = r.exitAt(r.valueGrowthPct, y);
      var cur = (y === hold) ? ' class="current"' : '';
      var sign = function(v) { return v >= 0 ? 'positive' : 'negative'; };
      html += '<tr><td' + cur + '>' + y + (y === hold ? ' \u2190 exit' : '') + '</td>' +
        '<td>$' + fmtInt(row.income) + '</td>' +
        '<td>$' + fmtInt(row.opex) + '</td>' +
        '<td>$' + fmtInt(row.propertyTax) + '</td>' +
        '<td>$' + fmtInt(row.noi) + '</td>' +
        '<td class="' + sign(row.cf) + '">$' + fmtInt(row.cf) + '</td>' +
        '<td class="' + sign(row.coc) + '">' + fmtPct(row.coc) + '</td>' +
        '<td>$' + fmtInt(row.propVal) + '</td>' +
        '<td>$' + fmtInt(row.loanBal) + '</td>' +
        '<td>$' + fmtInt(row.equity) + '</td>' +
        '<td class="' + sign(exit.preTaxProfit) + '">$' + fmtInt(exit.preTaxProfit) + '</td>' +
        '<td class="' + sign(exit.preTaxAnnualizedROI) + '">' + fmtPct(exit.preTaxAnnualizedROI) + '</td></tr>';
    });
    html += '</tbody>';
    $('whatifTable').innerHTML = html;
  }

  // Hand-rolled SVG: the project has no chart library and no build step, and
  // adding a CDN dependency for three polylines would not be a good trade.
  function renderWhatifChart(r) {
    var W = 560, H = 220, PAD_L = 54, PAD_B = 22, PAD_T = 8, PAD_R = 8;
    var rows = r.projRows;
    if (!rows.length) { $('whatifChart').innerHTML = ''; return; }
    var maxV = 0;
    rows.forEach(function(p) {
      maxV = Math.max(maxV, p.propVal, p.equity, p.loanBal);
    });
    if (!isFinite(maxV) || maxV <= 0) maxV = 1;
    var x = function(i) { return PAD_L + (W - PAD_L - PAD_R) * (i / Math.max(1, rows.length - 1)); };
    var y = function(v) { return PAD_T + (H - PAD_T - PAD_B) * (1 - v / maxV); };
    var line = function(pick, color) {
      var pts = rows.map(function(p, i) {
        var v = pick(p);
        if (!isFinite(v)) v = 0;
        return x(i).toFixed(1) + ',' + y(v).toFixed(1);
      }).join(' ');
      return '<polyline fill="none" stroke="' + color + '" stroke-width="2" points="' + pts + '"/>';
    };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Property value, equity and loan balance over time">';
    for (var g = 0; g <= 3; g++) {
      var gv = maxV * g / 3, gy = y(gv);
      svg += '<line x1="' + PAD_L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + gy.toFixed(1) +
             '" stroke="currentColor" stroke-opacity="0.12"/>' +
             '<text x="' + (PAD_L - 6) + '" y="' + (gy + 3.5).toFixed(1) + '" font-size="9" text-anchor="end" fill="currentColor" fill-opacity="0.55">$' + fmtInt(gv / 1000) + 'K</text>';
    }
    svg += line(function(p) { return p.propVal; }, '#6366f1');
    svg += line(function(p) { return p.equity; }, '#10b981');
    svg += line(function(p) { return p.loanBal; }, '#ef4444');
    [1, 5, 10, 20, 30].forEach(function(yr) {
      if (yr > rows.length) return;
      svg += '<text x="' + x(yr - 1).toFixed(1) + '" y="' + (H - 6) + '" font-size="9" text-anchor="middle" fill="currentColor" fill-opacity="0.55">Y' + yr + '</text>';
    });
    svg += '</svg>';
    $('whatifChart').innerHTML =
      '<div class="wf-chart-legend"><span class="lg-val">Property value</span>' +
      '<span class="lg-eq">Equity</span><span class="lg-loan">Loan balance</span></div>' + svg;
  }

  window.whatifReset = function() {
    whatifOverrides = {};
    renderWhatifSliders();
    whatifRecalc();
  };

  // Writing back marks each field as user-edited. Without that the next
  // autofill silently overwrites what was just chosen deliberately.
  var WHATIF_FIELD_MAP = {
    price: 'purchasePrice', closingCosts: 'closingCosts', rehab: 'rehabBudget',
    dpPct: 'downPayment', rate: 'interestRate', termYears: 'loanTerm', points: 'points',
    totalRent: 'monthlyRent', otherIncome: 'otherIncome', vacPct: 'vacancy',
    incomeGrowthPct: 'incomeGrowth',
    taxesYr: 'propertyTaxes', insuranceYr: 'insurance', maintPct: 'maintenance',
    capexPct: 'capex', mgmtPct: 'management', hoaMonth: 'hoa', utilMonth: 'utilities',
    otherExpMonth: 'otherExpenses', expGrowthPct: 'expenseGrowth',
    valueGrowthPct: 'valueGrowth', holdYears: 'holdYears',
    sellingCostPct: 'sellingCostPct'
  };

  // Multi-unit rent is one figure on the slider and several inputs on the form.
  // Scaling every unit by the same factor keeps the split the user entered; the
  // last visible unit absorbs the rounding so the total is exactly what was
  // shown. There is nothing to mark as user-edited -- the per-unit inputs carry
  // no id and no auto-fill writes to them.
  function applyUnitRents(newTotal) {
    var count = Math.max(1, parseInt($('unitCount').value) || 1);
    var inputs = $('unitRentsGrid').querySelectorAll('.unit-rent');
    var last = Math.min(count, inputs.length) - 1;
    if (last < 0) return false;
    var seedTotal = 0, i;
    for (i = 0; i <= last; i++) seedTotal += val(inputs[i], 0);
    // With every unit at zero there are no proportions to preserve, so there is
    // no defensible way to split the figure.
    if (seedTotal <= 0) return false;
    var scale = newTotal / seedTotal, running = 0;
    for (i = 0; i <= last; i++) {
      var v = (i === last) ? Math.round(newTotal - running) : Math.round(val(inputs[i], 0) * scale);
      inputs[i].value = v;
      running += v;
    }
    return true;
  }

  window.whatifApply = function() {
    var applied = 0, skipped = 0;
    Object.keys(whatifOverrides).forEach(function(key) {
      var v = whatifOverrides[key];
      if (Math.abs(v - whatifSeed[key]) < 1e-9) return;
      if (key === 'totalRent' && whatifSeed.propertyType !== 'sfh') {
        if (applyUnitRents(v)) applied++; else skipped++;
        return;
      }
      var id = WHATIF_FIELD_MAP[key];
      var el = id && $(id);
      if (!el) return;
      el.value = v;
      userEditedFields[id] = true;
      markSource(id, 'estimated');
      applied++;
    });
    whatifSeed = readInputs();
    whatifOverrides = {};
    renderWhatifSliders();
    whatifRecalc();
    if (typeof calculate === 'function') calculate();
    $('whatifDirty').textContent = applied
      ? applied + ' value' + (applied > 1 ? 's' : '') + ' written to your analysis' +
        (skipped ? ' — rent skipped, the unit rents are all zero' : '')
      : (skipped ? 'Rent could not be split — the unit rents are all zero' : 'Nothing to apply');
  };

  // ======================================================================
  // Equity Chart (CSS bars)
  // ======================================================================
  function renderEquityChart(r) {
    var container = $('equityBars');
    container.innerHTML = '';

    // Compounding one rate out to year 30 and printing it to the dollar is the
    // most false-precise output in the app. Say so where it is displayed.
    var note = $('equityChartNote');
    if (note) {
      note.textContent = 'A single path at ' + fmt(r.valueGrowthPct) + '%/yr, before selling costs. Income taxes are excluded. ' +
        'Real prices do not compound smoothly \u2014 see the five-year range above for how wide the spread gets.';
    }

    var years = [1, 5, 10, 15, 20, 25, 30];
    // Filter to loan term
    years = years.filter(function(y) { return y <= r.termYears; });

    // Calculate values for each year
    var entries = [];
    years.forEach(function(yr) {
      var propVal = r.price * Math.pow(1 + r.valueGrowthPct / 100, yr);
      var loanBal = (yr <= r.amortSchedule.length) ? r.amortSchedule[yr - 1].balance : 0;
      entries.push({ year: yr, propVal: propVal, loanBal: loanBal, equity: propVal - loanBal });
    });

    // Find max for scaling
    var maxVal = 0;
    entries.forEach(function(e) { if (e.propVal > maxVal) maxVal = e.propVal; });
    if (maxVal === 0) maxVal = 1;

    entries.forEach(function(e) {
      var row = document.createElement('div');
      row.className = 'equity-bar-row';

      var valPct = (e.propVal / maxVal) * 100;
      var loanPct = (e.loanBal / maxVal) * 100;

      row.innerHTML =
        '<div class="bar-label">Year ' + e.year + '</div>' +
        '<div class="bar-track">' +
          '<div class="bar-value property-val" style="width:' + valPct + '%"></div>' +
          '<div class="bar-value loan-bal" style="width:' + loanPct + '%"></div>' +
        '</div>' +
        '<div class="bar-amount">' + fmtDollar(e.equity) + '</div>';

      container.appendChild(row);
    });
  }

  // ======================================================================
  // Populate Review (Step 5)
  // ======================================================================
  function populateReview() {
    var content = $('reviewContent');
    var html = '';

    function badge(field) {
      if (!autoFilledFields[field]) return '';
      var src = fieldSources[field] || 'zillow';
      var cls = src === 'zillow' ? 'badge-zillow'
              : src === 'redfin' ? 'badge-redfin'
              : src.indexOf('rentcast') === 0 ? 'badge-rentcast'
              : src === 'pdf' ? 'badge-pdf'
              : src === 'estimated' ? 'badge-estimated'
              : src === 'fhfa' ? 'badge-fhfa'
              : 'badge-ai';
      return ' <span class="badge ' + cls + '">' + (SOURCE_LABELS[src] || src) + '</span>';
    }

    // Purchase section
    html += '<div class="review-section">';
    html += '<div class="review-header"><h3>Purchase Details</h3><button class="edit-link" onclick="goToStep(1)">Edit</button></div>';
    html += '<div class="review-grid">';
    var propNameV = $('propName').value.trim();
    if (propNameV) html += reviewItem('Property', esc(propNameV) + badge('propName'));
    html += reviewItem('Purchase Price', fmtDollar(val($('purchasePrice'), 0)) + badge('purchasePrice'));
    var arvV = val($('arv'), 0);
    if (arvV > 0) html += reviewItem('ARV', fmtDollar(arvV));
    html += reviewItem('Closing Costs', fmtDollar(val($('closingCosts'), 0)) + badge('closingCosts'));
    html += reviewItem('Rehab Budget', fmtDollar(val($('rehabBudget'), 0)));
    html += reviewItem('Value Growth', val($('valueGrowth'), 0) + '%/yr');
    var sqftV = val($('sqft'), 0);
    if (sqftV > 0) html += reviewItem('Square Footage', fmtInt(sqftV) + ' sqft' + badge('sqft'));
    html += reviewItem('Building Value % (tax context only)', val($('buildingPct'), 0) + '%');
    html += '</div></div>';

    // Loan section
    html += '<div class="review-section">';
    html += '<div class="review-header"><h3>Loan Details</h3><button class="edit-link" onclick="goToStep(2)">Edit</button></div>';
    html += '<div class="review-grid">';
    if ($('cashPurchase').checked) {
      html += reviewItem('Financing', 'Cash Purchase');
    } else {
      html += reviewItem('Down Payment', val($('downPayment'), 0) + '% ($' + fmtInt(val($('purchasePrice'), 0) * val($('downPayment'), 0) / 100) + ')');
      html += reviewItem('Interest Rate', val($('interestRate'), 0) + '%');
      html += reviewItem('Loan Term', val($('loanTerm'), 1) + ' years');
      html += reviewItem('Points', val($('points'), 0));
    }
    html += '</div></div>';

    // Income section
    html += '<div class="review-section">';
    html += '<div class="review-header"><h3>Rental Income</h3><button class="edit-link" onclick="goToStep(3)">Edit</button></div>';
    html += '<div class="review-grid">';
    if (propertyType === 'sfh') {
      html += reviewItem('Monthly Rent', fmtDollar(val($('monthlyRent'), 0)) + badge('monthlyRent'));
    } else {
      var count = parseInt($('unitCount').value);
      var inputs = $('unitRentsGrid').querySelectorAll('.unit-rent');
      for (var i = 0; i < count; i++) {
        html += reviewItem('Unit ' + (i + 1) + ' Rent', fmtDollar(val(inputs[i], 0)));
      }
    }
    html += reviewItem('Other Income', fmtDollar(val($('otherIncome'), 0)) + '/mo');
    html += reviewItem('Income Growth', val($('incomeGrowth'), 0) + '%/yr');
    html += '</div></div>';

    // Expenses section
    html += '<div class="review-section">';
    html += '<div class="review-header"><h3>Expenses</h3><button class="edit-link" onclick="goToStep(4)">Edit</button></div>';
    html += '<div class="review-grid">';
    html += reviewItem('Property Taxes', fmtDollar(val($('propertyTaxes'), 0)) + '/yr' + badge('propertyTaxes'));
    var taxOverride = optionalVal($('propertyTaxGrowth'), -25, 50);
    var taxProjection = taxOverride !== null
      ? taxOverride + '%/yr override'
      : (propertyTaxPolicy ? propertyTaxPolicy.label : 'Projected market value');
    html += reviewItem('Tax Projection', taxProjection);
    html += reviewItem('Insurance', fmtDollar(val($('insurance'), 0)) + '/yr' + badge('insurance'));
    html += reviewItem('Maintenance', val($('maintenance'), 0) + '% of rent');
    html += reviewItem('Vacancy', val($('vacancy'), 0) + '%');
    html += reviewItem('CapEx Reserve', val($('capex'), 0) + '% of rent');
    html += reviewItem('Management', val($('management'), 0) + '%');
    html += reviewItem('HOA', fmtDollar(val($('hoa'), 0)) + '/mo' + badge('hoa'));
    html += reviewItem('Utilities', fmtDollar(val($('utilities'), 0)) + '/mo');
    html += reviewItem('Other Expenses', fmtDollar(val($('otherExpenses'), 0)) + '/mo');
    html += reviewItem('Expense Growth', val($('expenseGrowth'), 0) + '%/yr');
    html += '</div></div>';

    content.innerHTML = html;
  }

  function reviewItem(label, value) {
    return '<div class="review-item"><span class="review-label">' + label + '</span><span class="review-value">' + value + '</span></div>';
  }

  // ======================================================================
  // AI Analysis (with streaming support)
  // ======================================================================
  function buildMetricsText() {
    var r = lastCalcResults;
    var m = 'Analyze this rental property deal:\n\n';
    var aiPropName = $('propName').value.trim();
    if (aiPropName) m += 'Property: ' + aiPropName + '\n';
    m += 'Property Type: ' + (r.propertyType === 'sfh' ? 'Single Family Home' : 'Multifamily') + '\n';
    m += 'Purchase Price: ' + fmtDollar(r.price) + '\n';
    if (r.arv > 0) m += 'ARV: ' + fmtDollar(r.arv) + '\n';
    if (r.rehab > 0) m += 'Rehab Budget: ' + fmtDollar(r.rehab) + '\n';
    m += 'Down Payment: ' + r.dpPct + '% (' + fmtDollar(r.dpAmount) + ')\n';
    m += 'Loan Amount: ' + fmtDollar(r.loanAmount) + '\n';
    m += 'Interest Rate: ' + r.rate + '%, Loan Term: ' + r.termYears + ' years\n';
    m += 'Monthly Rent (total): ' + fmtDollar(r.totalMonthlyIncome) + '\n';
    m += 'Property Taxes/yr: ' + fmtDollar(r.taxesYr) + ', Insurance/yr: ' + fmtDollar(r.insuranceYr) + '\n';
    m += 'Property Tax Projection: ' + (r.taxGrowthOverridePct !== null
      ? r.taxGrowthOverridePct + '% annual override'
      : (r.propertyTaxPolicy && r.propertyTaxPolicy.label) || 'market-value model') + '\n';
    m += 'Maintenance: ' + r.maintPct + '%, Vacancy: ' + r.vacPct + '%, CapEx: ' + r.capexPct + '%, Mgmt: ' + r.mgmtPct + '%\n';
    m += 'HOA/mo: ' + fmtDollar(r.hoaMonth) + ', Utilities/mo: ' + fmtDollar(r.utilMonth) + '\n';
    m += '\nCalculated Metrics:\n';
    m += 'Monthly Mortgage (P&I): ' + fmtDollar(r.monthlyPI) + ', PITI: ' + fmtDollar(r.piti) + '\n';
    m += 'Monthly Cash Flow: ' + fmtDollar(r.monthlyCF) + ', Annual: ' + fmtDollar(r.annualCF) + '\n';
    m += 'Cash-on-Cash Return: ' + fmtPct(r.coc) + ', Cap Rate: ' + fmtPct(r.capRate) + '\n';
    m += 'NOI: ' + fmtDollar(r.noi) + ', GRM: ' + fmtGRM(r.grm) + '\n';
    m += 'Break-even Occupancy: ' + fmtPct(r.breakeven) + ', DSCR: ' + (r.dscr !== null ? fmt(r.dscr) : 'N/A') + '\n';
    m += 'Total Cash to Close: ' + fmtDollar(r.totalCashClose) + '\n';
    m += 'OER: ' + fmtPct(r.oer) + ', CF/Unit: ' + fmtDollar(r.monthlyCFPerUnit) + '/mo\n';
    m += 'Income taxes are excluded from all return calculations.\n';
    if (r.pricePerSqft !== null) m += 'Price/Sqft: ' + fmtDollar(r.pricePerSqft) + ', Rent/Sqft: $' + fmt(r.rentPerSqft) + '\n';
    m += '\n' + r.holdYears + '-Year Pre-Tax Profit: ' + fmtDollar(r.preTaxProfit) + '\n';
    m += '  Cash Flow: ' + fmtDollar(r.totalReturnCF) + ', Appreciation after selling costs: ' + fmtDollar(r.appreciationAfterSellingCosts) + '\n';
    m += '  Debt Paydown: ' + fmtDollar(r.totalReturnDebtPaydown) + ', Upfront closing/rehab/points: -' + fmtDollar(r.closingCosts + r.rehab + r.pointsCost) + '\n';
    m += 'Annualized Pre-Tax ROI: ' + fmtPct(r.preTaxAnnualizedROI) + '\n';
    m += 'Pre-Tax IRR: ' + (r.preTaxIRR !== null ? fmtPct(r.preTaxIRR) : 'N/A') + '\n';
    m += 'Deal Score: ' + r.dealText + ' (' + r.dealPoints + '/' + r.dealMaxPoints + ' points)\n';
    r.dealFactors.forEach(function(f) {
      m += '  ' + f.name + ': ' + f.value + ' [' + f.verdict.toUpperCase() + '] — ' + f.reason + '\n';
    });
    return m;
  }

  function renderMarkdown(raw) {
    return raw
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^#{4,} (.+)$/gm, '<h4 style="margin:0.8em 0 0.3em;color:#8be9fd">$1</h4>')
      .replace(/^### (.+)$/gm, '<h4 style="margin:0.8em 0 0.3em;color:#8be9fd">$1</h4>')
      .replace(/^## (.+)$/gm, '<h3 style="margin:1em 0 0.4em;color:#8be9fd">$1</h3>')
      .replace(/^# (.+)$/gm, '<h3 style="margin:1em 0 0.4em;color:#8be9fd">$1</h3>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^\* (.+)$/gm, '<li style="margin-left:1.2em">$1</li>')
      .replace(/^- (.+)$/gm, '<li style="margin-left:1.2em">$1</li>')
      .replace(/^\d+\.\s+/gm, function(m) { return '<br>' + m; })
      .replace(/\n/g, '<br>');
  }

  window.runAI = async function() {
    $('aiError').classList.remove('visible');
    $('aiOutput').classList.remove('visible');
    $('aiOutput').innerHTML = '';
    $('aiBtn').disabled = true;
    $('aiBtnText').innerHTML = '<span class="spinner"></span> Analyzing...';

    var metricsText = buildMetricsText();
    var selectedModel = $('aiModelSelect').value || '';

    try {
      // Try streaming first
      var resp = await fetch('/api/analyze-ai-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metrics: metricsText, model: selectedModel })
      });

      if (!resp.ok) {
        var errData = await resp.json().catch(function() { return {}; });
        throw new Error(errData.error || 'AI analysis failed (HTTP ' + resp.status + ')');
      }

      // Stream tokens
      $('aiOutput').classList.add('visible');
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var fullText = '';

      while (true) {
        var result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });

        var lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line.startsWith('data: ')) continue;
          var payload = line.slice(6);
          if (payload === '[DONE]') continue;
          try {
            var evt = JSON.parse(payload);
            if (evt.token) {
              fullText += evt.token;
              $('aiOutput').innerHTML = renderMarkdown(fullText);
            }
          } catch(e) {}
        }
      }

      if (!fullText.trim()) {
        throw new Error('No response received from AI.');
      }
    } catch (err) {
      // Fallback to non-streaming if stream endpoint not available
      if (err.message && err.message.indexOf('404') > -1) {
        try {
          var resp2 = await fetch('/api/analyze-ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ metrics: metricsText, model: selectedModel })
          });
          var data = await resp2.json();
          if (!resp2.ok || data.error) throw new Error(data.error || 'Failed.');
          $('aiOutput').innerHTML = renderMarkdown(data.analysis || 'No response.');
          $('aiOutput').classList.add('visible');
        } catch (err2) {
          $('aiError').textContent = err2.message;
          $('aiError').classList.add('visible');
        }
      } else {
        var aiMsg = (err.message === 'Failed to fetch' || err.name === 'TypeError')
          ? 'Could not reach AI service. Check your connection.'
          : (err.message || 'Failed to get AI analysis.');
        $('aiError').textContent = aiMsg;
        $('aiError').classList.add('visible');
        if (err.message === 'Failed to fetch') showConnectionBanner();
      }
    } finally {
      $('aiBtn').disabled = false;
      $('aiBtnText').textContent = 'Run AI Analysis';
    }
  };

  // ======================================================================
  // Model Selector
  // ======================================================================
  async function loadModels() {
    try {
      var resp = await fetch('/api/models');
      if (!resp.ok) return;
      var data = await resp.json();
      var sel = $('aiModelSelect');
      sel.innerHTML = '';
      if (data.models && data.models.length > 0) {
        data.models.forEach(function(m) {
          var opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name || m.id;
          if (m.id === data.current) opt.selected = true;
          sel.appendChild(opt);
        });
      } else {
        sel.innerHTML = '<option value="">No models found</option>';
      }
    } catch(e) {
      $('aiModelSelect').innerHTML = '<option value="">Default model</option>';
    }
  }

  // ======================================================================
  // HTML Download
  // ======================================================================
  window.downloadHTML = function() {
    var clone = document.documentElement.cloneNode(true);
    // Remove non-result elements
    var removeSelectors = ['.wizard-nav','.step-buttons','.url-row','.url-error',
      '.property-card','.scenario-toolbar','.compare-overlay','.connection-banner',
      '.results-view-tabs','[data-results-panel="whatif"]',
      '#downloadBtn','#downloadHtmlBtn','.ai-controls select','#aiBtn','script'];
    removeSelectors.forEach(function(sel) {
      clone.querySelectorAll(sel).forEach(function(el) { el.remove(); });
    });
    // Show only step 6
    clone.querySelectorAll('.step-panel').forEach(function(p) {
      p.style.display = p.dataset.step === '6' ? 'block' : 'none';
    });
    clone.querySelectorAll('[data-results-panel="summary"], [data-results-panel="details"]').forEach(function(panel) {
      panel.style.display = 'block';
    });
    var html = '<!DOCTYPE html>\n' + clone.outerHTML;
    var blob = new Blob([html], { type: 'text/html' });
    var a = document.createElement('a');
    var name = $('propName').value.trim().replace(/[^a-zA-Z0-9]/g, '_') || 'report';
    a.href = URL.createObjectURL(blob);
    a.download = name + '_report.html';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ======================================================================
  // Scenario Save/Load (localStorage)
  // ======================================================================
  var SCENARIO_KEY = 'rpda_scenarios';

  var SAVE_FIELDS = [
    'propName','purchasePrice','arv','closingCosts','rehabBudget','valueGrowth',
    'sqft','yearBuilt','buildingPct','holdYears','sellingCostPct',
    'downPayment','interestRate','loanTerm','points',
    'monthlyRent','otherIncome','incomeGrowth','propertyTaxes','insurance',
    'maintenance','vacancy','capex','management','hoa','utilities','otherExpenses',
    'expenseGrowth','propertyTaxGrowth','unitCount'
  ];

  function getSavedScenarios() {
    try { return JSON.parse(localStorage.getItem(SCENARIO_KEY)) || {}; }
    catch(e) { return {}; }
  }

  function refreshScenarioList() {
    var scenarios = getSavedScenarios();
    var keys = Object.keys(scenarios).sort();
    var sel = $('scenarioSelect');
    sel.innerHTML = '<option value="">— Saved Scenarios (' + keys.length + ') —</option>';
    keys.forEach(function(k) {
      var opt = document.createElement('option');
      opt.value = k;
      opt.textContent = k;
      sel.appendChild(opt);
    });
    $('scenarioCount').textContent = keys.length > 0 ? keys.length + ' saved' : '';
    // Also update compare selects
    ['compareA','compareB','compareC'].forEach(function(id) {
      var csel = $(id);
      if (!csel) return;
      var cur = csel.value;
      csel.innerHTML = '<option value="">— Select —</option>';
      keys.forEach(function(k) {
        var opt = document.createElement('option');
        opt.value = k; opt.textContent = k;
        if (k === cur) opt.selected = true;
        csel.appendChild(opt);
      });
    });
  }

  window.saveScenario = function() {
    var name = $('propName').value.trim() || prompt('Name this scenario:');
    if (!name) return;
    var scenarios = getSavedScenarios();
    var data = { propertyType: propertyType, propertyTaxPolicy: propertyTaxPolicy };
    SAVE_FIELDS.forEach(function(f) {
      var el = $(f);
      if (el) {
        if (el.classList.contains('currency-input')) {
          var amount = optionalVal(el, 0);
          data[f] = amount === null ? '' : amount;
        } else {
          data[f] = el.value;
        }
      }
    });
    // Also save checkbox state
    data.cashPurchase = $('cashPurchase') ? $('cashPurchase').checked : false;
    // Save calculated results for compare mode
    if (lastCalcResults && lastCalcResults.monthlyCF !== undefined) {
      data._results = {
        monthlyCF: lastCalcResults.monthlyCF,
        coc: lastCalcResults.coc,
        capRate: lastCalcResults.capRate,
        noi: lastCalcResults.noi,
        dscr: lastCalcResults.dscr,
        grm: lastCalcResults.grm,
        breakeven: lastCalcResults.breakeven,
        oer: lastCalcResults.oer,
        annualCF: lastCalcResults.annualCF,
        holdYears: lastCalcResults.holdYears,
        preTaxProfit: lastCalcResults.preTaxProfit,
        preTaxAnnualizedROI: lastCalcResults.preTaxAnnualizedROI,
        preTaxIRR: lastCalcResults.preTaxIRR,
        dealPoints: lastCalcResults.dealPoints,
        dealMaxPoints: lastCalcResults.dealMaxPoints,
        dealText: lastCalcResults.dealText,
        price: lastCalcResults.price,
        totalCashClose: lastCalcResults.totalCashClose
      };
    }
    data._savedAt = new Date().toISOString();
    scenarios[name] = data;
    try {
      localStorage.setItem(SCENARIO_KEY, JSON.stringify(scenarios));
    } catch(e) {
      if (e.name === 'QuotaExceededError' || e.code === 22) {
        alert('Storage is full. Delete some saved scenarios to make room.');
        return;
      }
      throw e;
    }
    refreshScenarioList();
    $('scenarioSelect').value = name;
  };

  window.loadScenario = function() {
    var name = $('scenarioSelect').value;
    if (!name) return;
    var scenarios = getSavedScenarios();
    var data = scenarios[name];
    if (!data) return;
    // Set property type
    if (data.propertyType) setPropertyType(data.propertyType);
    // Fill fields
    SAVE_FIELDS.forEach(function(f) {
      var el = $(f);
      if (el && data[f] !== undefined) el.value = data[f];
    });
    showPropertyTaxPolicy(data.propertyTaxPolicy || null);
    // Checkbox
    if ($('cashPurchase') && data.cashPurchase !== undefined) {
      $('cashPurchase').checked = data.cashPurchase;
      toggleCashPurchase();
    }
    calculate();
    updateDpHelper();
    goToStep(1);
  };

  window.deleteScenario = function() {
    var name = $('scenarioSelect').value;
    if (!name) return;
    if (!confirm('Delete "' + name + '"?')) return;
    var scenarios = getSavedScenarios();
    delete scenarios[name];
    localStorage.setItem(SCENARIO_KEY, JSON.stringify(scenarios));
    refreshScenarioList();
  };

  // ======================================================================
  // Compare Mode
  // ======================================================================
  window.openCompare = function() {
    refreshScenarioList();
    $('compareOverlay').classList.add('visible');
  };

  window.closeCompare = function() {
    $('compareOverlay').classList.remove('visible');
  };

  window.runCompare = function() {
    var scenarios = getSavedScenarios();
    var keys = [
      $('compareA').value,
      $('compareB').value,
      $('compareC').value
    ].filter(function(k) { return k && scenarios[k]; });

    if (keys.length < 2) {
      alert('Select at least 2 scenarios to compare.');
      return;
    }

    var metrics = [
      { key: 'price', label: 'Purchase Price', fmt: fmtDollar, higher: false },
      { key: 'totalCashClose', label: 'Cash to Close', fmt: fmtDollar, higher: false },
      { key: 'monthlyCF', label: 'Monthly Cash Flow', fmt: fmtDollar, higher: true },
      { key: 'annualCF', label: 'Annual Cash Flow', fmt: fmtDollar, higher: true },
      { key: 'coc', label: 'Cash-on-Cash Return', fmt: fmtPct, higher: true },
      { key: 'capRate', label: 'Cap Rate', fmt: fmtPct, higher: true },
      { key: 'noi', label: 'NOI', fmt: fmtDollar, higher: true },
      { key: 'dscr', label: 'DSCR', fmt: function(v) { return v !== null ? fmt(v) : 'N/A'; }, higher: true },
      { key: 'grm', label: 'GRM', fmt: fmtGRM, higher: false },
      { key: 'breakeven', label: 'Break-Even Occ.', fmt: fmtPct, higher: false },
      { key: 'oer', label: 'OER', fmt: fmtPct, higher: false },
      { key: 'holdYears', label: 'Holding Period', fmt: function(v) { return v + ' years'; }, higher: false },
      { key: 'preTaxProfit', label: 'Pre-Tax Profit', fmt: fmtDollar, higher: true },
      { key: 'preTaxAnnualizedROI', label: 'Annualized Pre-Tax ROI', fmt: fmtPct, higher: true },
      { key: 'preTaxIRR', label: 'Pre-Tax IRR', fmt: fmtPct, higher: true },
      { key: 'dealPoints', label: 'Deal Score', fmt: function(v, d) { return v + '/' + (d.dealMaxPoints || 14); }, higher: true }
    ];

    var html = '<table class="compare-table"><thead><tr><th>Metric</th>';
    keys.forEach(function(k) { html += '<th>' + esc(k) + '</th>'; });
    html += '</tr></thead><tbody>';

    // Deal verdict row
    html += '<tr><td><strong>Verdict</strong></td>';
    keys.forEach(function(k) {
      var d = scenarios[k]._results || {};
      html += '<td><strong>' + (d.dealText || '—') + '</strong></td>';
    });
    html += '</tr>';

    metrics.forEach(function(m) {
      var vals = keys.map(function(k) {
        var d = scenarios[k]._results || {};
        return d[m.key];
      });

      // Find best/worst
      var numVals = vals.filter(function(v) { return v !== null && v !== undefined && !isNaN(v); });
      var best = m.higher ? Math.max.apply(null, numVals) : Math.min.apply(null, numVals);
      var worst = m.higher ? Math.min.apply(null, numVals) : Math.max.apply(null, numVals);

      html += '<tr><td>' + m.label + '</td>';
      keys.forEach(function(k, i) {
        var d = scenarios[k]._results || {};
        var v = vals[i];
        var cls = '';
        if (numVals.length > 1 && v !== null && v !== undefined) {
          if (v === best) cls = ' class="compare-best"';
          else if (v === worst && numVals.length > 2) cls = ' class="compare-worst"';
        }
        var display = (v !== null && v !== undefined) ? m.fmt(v, d) : '—';
        html += '<td' + cls + '>' + display + '</td>';
      });
      html += '</tr>';
    });

    html += '</tbody></table>';
    $('compareResults').innerHTML = html;
  };

  // ======================================================================
  // Event Listeners
  // ======================================================================
  var debouncedCalc = debounce(function() { calculate(); updateDpHelper(); }, 150);
  var allInputs = document.querySelectorAll('.input-grid input, .input-grid select, .unit-rents-grid input');
  allInputs.forEach(function(inp) {
    inp.addEventListener('input', debouncedCalc);

    if (inp.type === 'number') {
      inp.addEventListener('blur', function() {
        var v = parseFloat(inp.value);
        var min = inp.min !== '' ? parseFloat(inp.min) : undefined;
        var max = inp.max !== '' ? parseFloat(inp.max) : undefined;
        if (isNaN(v)) {
          inp.value = (min !== undefined && !isNaN(min)) ? min : 0;
        } else {
          if (min !== undefined && !isNaN(min) && v < min) inp.value = min;
          if (max !== undefined && !isNaN(max) && v > max) inp.value = max;
        }
        calculate();
      });
    }
  });

  // ======================================================================
  // Glossary tooltips
  // ======================================================================
  // Keyed by the normalised label text so a (?) can be attached to every
  // matching label at once, instead of hand-editing ~35 markup sites.
  // Every `url` below was checked to return 200 in a real browser; terms with
  // no reliable dedicated source carry a definition and no link, because a
  // link that 404s or lands on an unrelated page is worse than none.
  var IP = 'https://www.investopedia.com/terms/';
  var GLOSSARY = {
    'monthly cash flow': ['Rent left over after the mortgage, taxes, insurance and every operating expense. The number that decides whether the property pays you or you pay it.', IP + 'c/cashflow.asp'],
    'cash-on-cash return': ['Annual pre-tax cash flow divided by the actual cash you put in (down payment, closing costs, rehab). Measures return on your money, not the property price.', IP + 'c/cashoncashreturn.asp'],
    'cap rate': ['Net operating income divided by purchase price, ignoring financing. Lets you compare properties as assets regardless of how each is financed.', IP + 'c/capitalizationrate.asp'],
    '10yr pre-tax annualized roi': ['Reconciled pre-tax profit over the selected hold expressed as a yearly compound rate. Unlike IRR, it ignores when cash flow arrives.', IP + 'r/returnoninvestment.asp'],
    'noi': ['Net Operating Income: annual rent minus operating expenses, before any mortgage payment. The basis for cap rate and DSCR.', IP + 'n/noi.asp'],
    'monthly mortgage (p&i)': ['Principal and interest only — the loan payment itself, excluding taxes, insurance and HOA.', IP + 'p/principal.asp'],
    'monthly piti': ['Principal, Interest, Taxes and Insurance — the full monthly housing payment a lender counts.', IP + 'p/piti.asp'],
    'total monthly expenses': ['Operating costs: vacancy, maintenance, CapEx, management, HOA and utilities. Excludes the mortgage.', 'https://en.wikipedia.org/wiki/Operating_expense'],
    'gross rent multiplier': ['Price divided by annual gross rent. A rough price-to-rent yardstick; lower is cheaper relative to income.', 'https://en.wikipedia.org/wiki/Gross_rent_multiplier'],
    'break-even occupancy': ['The share of the year the unit must be rented just to cover all costs. Above 100% means it cannot break even even fully occupied.', IP + 'b/breakevenpoint.asp'],
    'dscr': ['Debt-Service Coverage Ratio: NOI divided by annual debt payments. Below 1.0 means income does not cover the loan; most lenders want 1.20+.', IP + 'd/dscr.asp'],
    'total cash to close': ['Everything you must bring on day one: down payment, closing costs, points and rehab budget.', IP + 'c/closingcosts.asp'],
    'operating expense ratio': ['Operating expenses as a share of gross income. Higher means more of each rent dollar is consumed by running the property.', IP + 'o/operating-expense-ratio.asp'],
    'cf per unit (monthly)': ['Monthly cash flow divided by the number of units — lets you compare a duplex against a single-family house fairly.', IP + 'c/cashflow.asp'],
    'rough annual depreciation': ['Optional tax context only. This shortcut uses the entered building allocation and does not change any underwriting return.', 'https://www.irs.gov/publications/p527'],
    'price / sqft': ['Purchase price divided by living area. Useful for comparing against nearby sales.', IP + 'r/realestate.asp'],
    'rent / sqft': ['Monthly rent divided by living area. Small units almost always command more per square foot than large ones.', IP + 'r/realestate.asp'],
    'purchase price ($)': ['The contract price. Also the basis for your post-sale property tax assessment in most states.', IP + 'r/realestate.asp'],
    'after repair value / arv ($)': ['What the property should be worth once renovations are finished. Drives the 70% rule for flips.', null],
    'rehab / repair budget ($)': ['Total expected renovation cost. Chronically underestimated — add a contingency.', null],
    'closing costs ($)': ['Fees to complete the purchase: lender charges, title, escrow, recording. Typically 2-5% of price.', IP + 'c/closingcosts.asp'],
    'down payment (%)': ['Share of price paid in cash. Investment properties usually require 20-25%.', IP + 'd/down_payment.asp'],
    'interest rate (%)': ['The annual rate on the loan. Small changes move cash flow substantially — see the sensitivity table.', IP + 'i/interestrate.asp'],
    'loan term (years)': ['Years to repay. Longer terms lower the payment but raise total interest paid.', IP + 'm/mortgage.asp'],
    'loan points': ['Fees paid upfront to buy down the interest rate. One point is 1% of the loan.', IP + 'd/discountpoints.asp'],
    'monthly rent ($)': ['Expected gross monthly rent. The single most important input — every return metric scales with it.', null],
    'other monthly income ($)': ['Non-rent income: parking, laundry, storage, pet fees.', null],
    'vacancy rate (%)': ['Share of the year the unit sits empty between tenants. Local days-on-market is a good guide.', IP + 'v/vacancy-rate.asp'],
    'repairs & maintenance (% of rent)': ['Ongoing upkeep — plumbing, appliances, turnover. Typically 5-10% of rent.', null],
    'capex reserve (% of rent)': ['Money set aside for big-ticket replacements: roof, HVAC, water heater. Not a monthly bill, but it will come due.', IP + 'c/capitalexpenditure.asp'],
    'property management (%)': ['Fee to a manager, usually 8-10% of collected rent. Count it even if self-managing — your time is not free.', null],
    'property taxes / yr ($)': ['Annual tax owed. A sale usually reassesses the property near the purchase price, so the seller\'s current bill can understate yours.', IP + 'p/propertytax.asp'],
    'insurance / yr ($)': ['Landlord/hazard policy. Varies enormously by state and wind/fire exposure.', IP + 'h/homeowners-insurance.asp'],
    'hoa / month ($)': ['Homeowners association dues. A direct hit to cash flow and easy to overlook in new developments.', IP + 'h/hoa.asp'],
    'building value %': ['Optional tax context only. A rough allocation of price to the structure rather than land; it does not affect underwriting returns.', 'https://www.irs.gov/publications/p527'],
    'holding period': ['How long you plan to own it before selling. Drives every return figure, the projection table and the appreciation range. Longer holds dilute the fixed cost of buying and selling, and historically they narrow the spread of outcomes sharply \u2014 in one Central Valley ZIP the worst five-year stretch lost 59% while the worst fifteen-year stretch lost 5%.', 'https://www.fhfa.gov/data/hpi'],
    'year built': ['Drives the maintenance and CapEx reserve more than any other input \u2014 a 1920s house replaces something most years, a new build is under warranty with every component at the start of its life. Filled from the listing when available; enter it yourself when it is not, because the fallback assumes a mid-life house.', 'https://www.irs.gov/publications/p527'],
    'repairs & maintenance': ['Routine upkeep \u2014 service calls, leaks, turnover repairs. Sized from the building\u2019s replacement cost and age rather than a flat share of rent, because a furnace costs the same whether the unit rents for $1,200 or $3,000.', 'https://www.irs.gov/publications/p527'],
    'capex reserve': ['Money set aside each month for big-ticket replacements \u2014 roof, HVAC, water heater, flooring, windows. Component-by-component these run roughly 1.1% of replacement cost a year, which is well above the 5%-of-rent figure commonly used.', 'https://en.wikipedia.org/wiki/Capital_expenditure'],
    'appreciation \u2192 5-year return': ['How the whole deal changes if appreciation lands somewhere other than the base case. Rates come from this ZIP\u2019s own price history; the highlighted row is what the projections are currently using.', 'https://www.fhfa.gov/data/hpi'],
    'property value growth': ['How fast the property is assumed to gain value each year. Defaults to roughly long-run inflation (2.5%), deliberately below what most areas historically did \u2014 so a deal has to work on cash flow and real appreciation stays upside rather than a load-bearing assumption. The ZIP\u2019s own measured history (FHFA repeat-sales index) drives the what-if scenarios and can lower this default further in weaker markets. Editable, and the least certain input in the model.', 'https://www.fhfa.gov/data/hpi'],
    'selling costs': ['What it costs to get out: agent commissions, title, escrow and transfer taxes. Typically 6\u20138% of the sale price, and it comes straight off any gain.', 'https://en.wikipedia.org/wiki/Closing_costs'],
    'appreciation after selling costs': ['Gain in value after estimated selling costs. Income taxes are intentionally excluded.', IP + 'a/appreciation.asp'],
    'pre-tax net sale proceeds': ['Sale price less selling costs and the remaining loan balance. Income taxes are intentionally excluded.', IP + 'n/net-proceeds.asp'],
    'pre-tax profit': ['All modeled operating cash flow and sale proceeds less the full initial cash investment. It includes selling costs but excludes income taxes.', IP + 'r/returnoninvestment.asp'],
    'property value growth (%/yr)': ['Assumed yearly appreciation. Speculative — a deal that only works on appreciation is a bet, not a rental business.', IP + 'a/appreciation.asp'],
    'annual income growth (%)': ['Assumed yearly rent increase.', null],
    'annual expense growth (%)': ['Assumed yearly cost inflation. If it outpaces rent growth, cash flow erodes over time.', null],
    'cash flow': ['Cumulative rent left after all costs across the holding period.', IP + 'c/cashflow.asp'],
    'appreciation': ['Gain from the property rising in value. Not realised until you sell or refinance.', IP + 'a/appreciation.asp'],
    'debt paydown': ['Equity built as tenants pay down your loan principal.', IP + 'a/amortization.asp'],
    'total equity': ['Property value minus loan balance — your ownership stake.', IP + 'h/home_equity.asp'],
    '1% rule': ['Screening shortcut: monthly rent should be at least 1% of purchase price. Rare in high-cost coastal markets.', IP + 'o/one-percent-rule.asp'],
    '50% rule': ['Screening shortcut: assume operating expenses consume about half of gross rent.', null],
    '70% rule': ['Flipping shortcut: pay no more than 70% of after-repair value minus rehab cost.', null]
  };

  // Match a label to a glossary entry, tolerating units and trailing markers.
  function glossaryLookup(text) {
    var k = (text || '').toLowerCase().replace(/\s+/g, ' ').trim()
      .replace(/\s*\*$/, '').replace(/\s*optional$/, '');
    if (GLOSSARY[k]) return GLOSSARY[k];
    var stripped = k.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (GLOSSARY[stripped]) return GLOSSARY[stripped];
    for (var key in GLOSSARY) { if (k.indexOf(key) === 0) return GLOSSARY[key]; }
    return null;
  }

  function closeAllTips() {
    document.querySelectorAll('.tip-pop.open').forEach(function(el) { el.classList.remove('open'); });
  }

  function makeHelpButton(entry) {
    var wrap = document.createElement('span');
    wrap.className = 'tip-wrap';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tip-btn';
    btn.textContent = '?';
    btn.setAttribute('aria-label', 'What does this mean?');
    var pop = document.createElement('span');
    pop.className = 'tip-pop';
    pop.setAttribute('role', 'tooltip');
    var body = document.createElement('span');
    body.className = 'tip-text';
    body.textContent = entry[0];
    pop.appendChild(body);
    if (entry[1]) {
      var a = document.createElement('a');
      a.href = entry[1];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'tip-link';
      a.textContent = 'Learn more →';
      pop.appendChild(a);
    }
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var wasOpen = pop.classList.contains('open');
      closeAllTips();
      if (!wasOpen) pop.classList.add('open');
    });
    wrap.appendChild(btn);
    wrap.appendChild(pop);
    return wrap;
  }

  function attachTooltips(root) {
    var sels = '.metric-card .label, .pillar-label, .factor-label, label[for], .rule-card h4, .rule-title';
    (root || document).querySelectorAll(sels).forEach(function(el) {
      if (el.querySelector('.tip-wrap')) return;          // already annotated
      var entry = glossaryLookup(el.textContent);
      if (!entry) return;
      el.appendChild(makeHelpButton(entry));
    });
  }

  document.addEventListener('click', function(e) {
    if (!e.target.closest || !e.target.closest('.tip-wrap')) closeAllTips();
  });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeAllTips(); });

  attachTooltips();

  // The markup carries a literal so the version is still visible when this
  // file is opened directly; when served, the server's value always wins.
  (function showVersion() {
    var el = $('appVersion');
    if (el && window.__APP_VERSION__) el.textContent = 'v' + window.__APP_VERSION__;
  })();

  // Upload fallbacks
  $('uploadPdf').addEventListener('change', function() { handleUpload(this, 'PDF'); });
  $('uploadShot').addEventListener('change', function() { handleUpload(this, 'screenshot'); });
  $('uploadConfirmApply').addEventListener('click', applyUpload);
  $('uploadConfirmCancel').addEventListener('click', function() {
    pendingUpload = null;
    $('uploadConfirm').style.display = 'none';
    $('uploadStatus').textContent = '';
  });
  $('monthlyRent').addEventListener('input', function() { userEditedFields['monthlyRent'] = true; });
  // The reserve is a dollar figure divided by rent, so the percentage is only
  // valid for the rent it was computed against. Re-derive it when rent moves.
  $('monthlyRent').addEventListener('input', debounce(function() {
    applyCarryingCostRates(true);
  }, 400));
  $('vacancy').addEventListener('input', function() { userEditedFields['vacancy'] = true; });

  // Screenshot reading needs a capable model; hide the control rather than
  // accepting a file we cannot process.
  (async function initCapabilities() {
    try {
      var resp = await fetch('/api/rentcast-usage');
      var data = await resp.json();
      rentcastLocalAutoContinue = !!data.local_auto_continue;
      if (!data.anthropic) {
        $('uploadShotLabel').style.display = 'none';
        $('uploadShot').disabled = true;
      }
      if (data.configured) updateUsageDisplay(data);
    } catch (err) { /* offline: leave the controls as they are */ }
  })();

  // Track user manual edits on closing costs and insurance
  $('closingCosts').addEventListener('input', function() { userEditedFields['closingCosts'] = true; });
  $('insurance').addEventListener('input', function() { userEditedFields['insurance'] = true; });
  $('propertyTaxes').addEventListener('input', function() { userEditedFields['propertyTaxes'] = true; });
  $('propertyTaxGrowth').addEventListener('input', function() { calculate(); });
  $('propName').addEventListener('input', debounce(function() {
    applyCarryingCostRates(true);
  }, 500));
  $('valueGrowth').addEventListener('input', function() { userEditedFields['valueGrowth'] = true; });
  // The appreciation band is built from windows of the holding period, so the
  // profile has to be refetched when the hold changes.
  $('holdYears').addEventListener('change', function() {
    applyAppreciation(true);
    if (typeof calculate === 'function') calculate();
  });
  $('maintenance').addEventListener('input', function() { userEditedFields['maintenance'] = true; });
  $('capex').addEventListener('input', function() { userEditedFields['capex'] = true; });
  $('yearBuilt').addEventListener('input', function() { userEditedFields['yearBuilt'] = true; });
  // Age is the single biggest driver of the reserve, so re-derive on change.
  $('yearBuilt').addEventListener('input', debounce(function() {
    applyCarryingCostRates(true);
  }, 400));
  $('sqft').addEventListener('input', debounce(function() {
    applyCarryingCostRates(true);
  }, 400));

  // Purchase price changes update every rate-derived default. Taxes track
  // price because a sale reassesses the property at roughly what you paid.
  $('purchasePrice').addEventListener('input', debounce(function() {
    updateClosingCostsDefault();
    updateInsuranceDefault();
    applyCarryingCostRates();
    applyAppreciation();
    updateDpHelper();
  }, 150));

  // === Try Example Deal ===
  window.tryExampleDeal = function() {
    var ex = {
      propName:'456 Oak Avenue, Arlington VA 22201',
      purchasePrice:'250000', arv:'300000', closingCosts:'7500',
      rehabBudget:'15000', valueGrowth:'3', sqft:'1800',
      buildingPct:'80',
      downPayment:'25', interestRate:'6.5', loanTerm:'30', points:'0',
      monthlyRent:'2800', otherIncome:'100', incomeGrowth:'2',
      propertyTaxes:'3000', insurance:'1500', maintenance:'5',
      vacancy:'5', capex:'5', management:'8',
      hoa:'0', utilities:'0', otherExpenses:'0', expenseGrowth:'2', propertyTaxGrowth:''
    };
    Object.keys(ex).forEach(function(k){ var el=$(k); if(el) el.value=ex[k]; });
    if($('cashPurchase')){ $('cashPurchase').checked=false; toggleCashPurchase(); }
    updateDpHelper();
    goToStep(6);
  };

  // Keyboard navigation for wizard steps
  document.querySelectorAll('.wizard-step').forEach(function(s) {
    s.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        wizardClick(parseInt(s.dataset.step));
      }
    });
  });

  // Arrow keys move through the three Results views like a native tab set.
  document.querySelectorAll('[data-results-view]').forEach(function(tab, index, tabs) {
    tab.addEventListener('keydown', function(e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var direction = e.key === 'ArrowRight' ? 1 : -1;
      var next = tabs[(index + direction + tabs.length) % tabs.length];
      showResultsView(next.dataset.resultsView);
      next.focus();
    });
  });

  // Initial setup
  setupCurrencyInputs();
  updateDpHelper();
  calculate();
  refreshScenarioList();
  loadModels();
  loadSearchFilters();
  loadAlertPrefs();

})();
