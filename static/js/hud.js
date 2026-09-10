(function() {
  'use strict';
  var $ = function(id) { return document.getElementById(id); };
  var esc = function(value) { var el=document.createElement('span'); el.textContent=String(value == null ? '' : value); return el.innerHTML; };
  var money = function(value) { return Number(value).toLocaleString('en-US', {style:'currency', currency:'USD', maximumFractionDigits:0}); };
  var result = null, resultSignature = null, requestId = 0, yearTouched = false;
  var areasLoading = false, areaRequestId = 0;
  var propertyAddress = null, manualState = false, loadedState = '';
  var states = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
  states.forEach(function(state) { var o=document.createElement('option'); o.value=state; o.textContent=state; $('hudState').appendChild(o); });
  function context() { return window.getHUDContext ? window.getHUDContext() : {address:$('propName').value, propertyType:'sfh'}; }
  function syncProperty() {
    var address=(context().address || '').trim();
    if (address === propertyAddress) return;
    propertyAddress=address; manualState=false; loadedState='';
    areaRequestId++; areasLoading=false; clearResult();
    $('hudArea').disabled=false;
    $('hudArea').innerHTML='<option value="">Automatic address match</option>';
    // Match state + postal code together so promotional dollar amounts in
    // imported property titles cannot become ZIP codes. Keep leading zeros.
    var match=address.match(new RegExp('\\b('+states.join('|')+')\\s+(\\d{5})(?:-\\d{4})?\\b','i'));
    $('hudState').value=match ? match[1].toUpperCase() : '';
    $('hudZip').value=match ? match[2] : (/^\d{5}(?:-\d{4})?$/.test(address) ? address.slice(0,5) : '');
    $('hudUtilityAllowance').value='';
    if ($('hudPanel').open && $('hudState').value) loadAreas();
  }
  function signature() { return JSON.stringify([context(),$('hudBeds').value,$('hudYear').value,$('hudArea').value,$('hudZip').value]); }
  function status(text) { $('hudStatus').textContent=text; }
  function clearResult() {
    requestId++; result=null; resultSignature=null;
    $('hudResult').hidden=true; $('hudApplyControls').hidden=true;
    $('hudLookupBtn').disabled=areasLoading; $('hudApplyBtn').disabled=true;
    status('');
  }
  function rowHTML(data) {
    if (!data) return '';
    if (data.error) return '<div class="hud-row hud-unavailable">HUD unavailable<small>'+esc(data.error)+'</small></div>';
    var geography = data.geography_level === 'zip' ? 'ZIP '+data.zip : data.area_name;
    return '<div class="hud-row"><span class="hud-tag">HUD FY'+esc(data.year)+'</span> <strong>'+money(data.gross_rent)+'/mo</strong>'+
      '<small>'+esc(geography)+' · '+esc(data.bedrooms)+' bedrooms · utilities included'+
      (data.derived_bedrooms ? ' · derived from 4BR' : '')+
      (data.future_fiscal_year ? ' · future fiscal year' : '')+'</small></div>';
  }
  async function post(properties, year) {
    var response=await fetch('/api/hud/benchmarks', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({properties:properties,year:Number(year)})});
    var data=await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'HUD lookup failed.');
    if (!Array.isArray(data.results) || data.results.length !== properties.length) throw new Error('HUD returned incomplete results. Please retry.');
    return data.results;
  }
  async function lookup() {
    clearResult();
    if ($('hudBeds').value === '') { status('Choose bedrooms per rental unit.'); $('hudBeds').focus(); return; }
    var current=context();
    if (areasLoading) { status('Wait for the HUD county list to finish loading.'); return; }
    if (manualState && $('hudState').value && !$('hudArea').value) {
      status('Choose a HUD county / town for '+$('hudState').value+'. Selecting a state and ZIP alone does not select the HUD area.');
      document.querySelector('.hud-manual').open=true; $('hudArea').focus(); return;
    }
    if (!$('hudArea').value && !/^\s*\d/.test(current.address) && /\b[A-Z]{2}\s+\d{5}\b/.test(current.address)) {
      status('This deal contains only a city/state/ZIP, not a street address. State and ZIP are filled from the property; choose the HUD county / town, or enter a full street address in Property.');
      document.querySelector('.hud-manual').open=true; $('hudState').focus(); return;
    }
    if (!current.address.trim() && !$('hudArea').value) { status('Enter the property address or choose a HUD area manually.'); return; }
    if ($('hudZip').value && !/^\d{5}$/.test($('hudZip').value)) { status('Enter a five-digit ZIP code.'); return; }
    var id=requestId, sig=signature();
    $('hudLookupBtn').disabled=true; status('Looking up HUD rent…');
    try {
      var items=await post([{address:current.address,beds:Number($('hudBeds').value),entity_id:$('hudArea').value || null,zip_code:$('hudZip').value || null}], $('hudYear').value);
      if (id !== requestId || sig !== signature()) return;
      if (items[0].error) throw new Error(items[0].error);
      result=items[0]; resultSignature=sig;
      $('hudResult').innerHTML=rowHTML(result)+'<p>'+esc(result.note)+'</p><a href="https://www.huduser.gov/portal/datasets/fmr.html" target="_blank" rel="noopener">View HUD source</a>';
      $('hudResult').hidden=false;
      $('hudUtilityAllowance').value='';
      $('hudApplyControls').hidden=current.propertyType !== 'sfh';
      status(current.propertyType !== 'sfh' ? 'Benchmark is per rental unit. Enter each unit’s rent separately for multifamily properties.' : 'Benchmark loaded. Your current rent has not changed.');
      updateAdjusted();
    } catch(error) { if (id === requestId) status(error.message || 'HUD lookup failed.'); }
    finally { if (id === requestId) $('hudLookupBtn').disabled=false; }
  }
  function adjustedRent() {
    var raw=$('hudUtilityAllowance').value.trim(), allowance=Number(raw);
    if (!result || resultSignature !== signature() || context().propertyType !== 'sfh' || raw === '' || !Number.isFinite(allowance) || allowance < 0 || allowance >= result.gross_rent) return null;
    return result.gross_rent-allowance;
  }
  function updateAdjusted() {
    var adjusted=adjustedRent();
    $('hudAdjustedRent').textContent=adjusted === null ? 'Enter the tenant-paid utility allowance to calculate rent to the owner.' : 'HUD gross rent '+money(result.gross_rent)+' − tenant utilities '+money(Number($('hudUtilityAllowance').value))+' = '+money(adjusted)+'/month rent to owner.';
    $('hudApplyBtn').disabled=adjusted === null;
  }
  $('hudYear').addEventListener('change',function() { yearTouched=true; });
  $('hudPanel').addEventListener('toggle',function() {
    syncProperty();
    if ($('hudPanel').open && $('hudState').value && loadedState !== $('hudState').value && !areasLoading) loadAreas();
    if ($('hudPanel').open && $('hudBeds').value === '' && context().bedrooms != null) $('hudBeds').value=String(context().bedrooms);
  });
  fetch('/api/hud/status').then(function(response) { return response.json(); }).then(function(data) {
    if (typeof data.configured !== 'boolean') return;
    $('hudConnection').textContent=data.configured ? 'HUD connected through the local server.' : 'HUD is not configured. Add HUD_API_TOKEN to .env and restart the app.';
    if (!yearTouched && !result && data.default_year) {
      var year=String(data.default_year);
      if (!Array.from($('hudYear').options).some(function(o) { return o.value === year; })) {
        var option=document.createElement('option'); option.value=year; option.textContent='FY'+year; $('hudYear').appendChild(option);
      }
      $('hudYear').value=year;
    }
  }).catch(function() { $('hudConnection').textContent='HUD connection status unavailable.'; });
  $('hudLookupBtn').addEventListener('click',lookup);
  $('hudUtilityAllowance').addEventListener('input',updateAdjusted);
  $('hudApplyBtn').addEventListener('click',function() {
    var adjusted=adjustedRent(); if (adjusted === null) return;
    window.dispatchEvent(new CustomEvent('hud:apply',{detail:{rent:adjusted,benchmark:result,utilityAllowance:Number($('hudUtilityAllowance').value)}}));
    status('Adjusted HUD benchmark applied to Monthly Rent.');
  });
  ['hudBeds','hudYear','hudArea','hudZip','propName'].forEach(function(id) { $(id).addEventListener('input',clearResult); $(id).addEventListener('change',clearResult); });
  async function loadAreas() {
    loadedState='';
    var loadId=++areaRequestId; areasLoading=false;
    clearResult(); var state=$('hudState').value;
    $('hudArea').disabled=false;
    var selected=$('hudArea').value;
    $('hudArea').innerHTML=state && manualState ? '<option value="">Choose county / town (required)</option>' : '<option value="">Automatic address match</option>';
    if (!state) return;
    areasLoading=true; $('hudArea').disabled=true; $('hudLookupBtn').disabled=true;
    status('Loading HUD areas…');
    try {
      var response=await fetch('/api/hud/areas?state='+encodeURIComponent(state)); var data=await response.json();
      if (loadId !== areaRequestId) return;
      if (!response.ok || data.error) throw new Error(data.error || 'Could not load HUD areas.');
      if (!Array.isArray(data.areas) || !data.areas.length) throw new Error('No HUD counties were returned. Select the state again to retry.');
      (data.areas || []).forEach(function(area) { var option=document.createElement('option'); option.value=area.id; option.textContent=area.name; $('hudArea').appendChild(option); });
      if (Array.from($('hudArea').options).some(function(o) { return o.value === selected; })) $('hudArea').value=selected;
      loadedState=state;
      status(manualState ? 'Choose the county or town containing the property.' : 'State and ZIP filled from the property. County selection is needed if automatic address matching cannot resolve this property.');
    } catch(error) { if (loadId === areaRequestId) status(error.message); }
    finally { if (loadId === areaRequestId) { areasLoading=false; $('hudArea').disabled=false; $('hudLookupBtn').disabled=false; } }
  }
  $('hudState').addEventListener('change',function() { manualState=true; $('hudArea').value=''; loadAreas(); });
  $('propName').addEventListener('input',syncProperty);
  window.HUDRentUI={
    rowHTML:rowHTML,
    syncProperty:syncProperty,
    reset:function() { propertyAddress=null; manualState=false; loadedState=''; areaRequestId++; areasLoading=false; clearResult(); $('hudArea').disabled=false; $('hudBeds').value=''; $('hudArea').innerHTML='<option value="">Automatic address match</option>'; $('hudState').value=''; $('hudZip').value=''; $('hudUtilityAllowance').value=''; },
    setBedrooms:function(beds) { if (beds != null) $('hudBeds').value=String(beds); },
    enrich:async function(rows) {
      var values=await post(rows.map(function(row) { return {address:row.address || '',beds:row.beds == null ? null : Number(row.beds)}; }),$('hudYear').value);
      rows.forEach(function(row,index) { row.hudBenchmark=values[index]; });
    },
    snapshot:function() { return {result:result && resultSignature === signature() ? result : null, manualState:manualState, beds:$('hudBeds').value,year:$('hudYear').value,area:$('hudArea').value,areaLabel:$('hudArea').selectedOptions[0].textContent,zip:$('hudZip').value,state:$('hudState').value,utility:$('hudUtilityAllowance').value}; },
    restore:function(data) {
      if (!data) { syncProperty(); return; }
      areaRequestId++; areasLoading=false; clearResult(); $('hudArea').disabled=false;
      propertyAddress=(context().address || '').trim(); manualState=!!data.manualState; loadedState='';
      $('hudBeds').value=data.beds; $('hudYear').value=data.year; $('hudZip').value=data.zip || ''; $('hudState').value=data.state || '';
      if (data.area) { var o=document.createElement('option'); o.value=data.area; o.textContent=data.areaLabel; $('hudArea').appendChild(o); $('hudArea').value=data.area; }
      if (!data.result) return;
      loadedState=data.state || '';
      result=data.result; resultSignature=signature();
      $('hudResult').innerHTML=rowHTML(result)+'<p>'+esc(result.note)+'</p>';
      $('hudResult').hidden=false; $('hudApplyControls').hidden=context().propertyType !== 'sfh'; $('hudUtilityAllowance').value=data.utility || ''; updateAdjusted();
    }
  };
})();
