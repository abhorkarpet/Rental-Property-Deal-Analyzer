(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DealEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var PROJECTION_YEARS = 30;
  var INVESTOR_DOWN_PAYMENT = 0.25;
  var fmt = function(n) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var fmtDollar = function(n) { return '$' + fmt(n); };
  var fmtPct = function(n) { return fmt(n) + '%'; };
  var fmtInt = function(n) { return Math.round(n).toLocaleString('en-US'); };

  function computeQuickScore(listing, userRent, mortgageRate) {
    var price = listing.price;
    // A rent typed by the user overrides everything; otherwise use this
    // listing's own estimate. Applying one rent to every row would make cash
    // flow, the 1% rule and GRM monotonic in price, collapsing the ranking
    // into "cheapest first".
    var rent = userRent || listing.estRent;
    var rate = mortgageRate || 0.07; // default 7% if not provided
    if (!price || price <= 0 || !rent || rent <= 0) return { stars: 0, numericScore: 0, details: [], cssClass: 'score-0' };

    // Flag suspiciously cheap listings (likely vacant lots or teardowns)
    var isLikelyLot = price < 20000;

    var stars = 0;
    var details = [];
    var numericScore = 0; // 0-100 continuous score for ranking

    // --- Common calculations ---
    var expenseRatio = price >= 250000 ? 0.45 : price >= 100000 ? 0.50 : 0.55;
    var loanAmt = price * (1 - INVESTOR_DOWN_PAYMENT);
    var monthlyRate = rate / 12;
    var nPayments = 360;
    var mortgage = monthlyRate > 0 ? loanAmt * (monthlyRate * Math.pow(1 + monthlyRate, nPayments)) / (Math.pow(1 + monthlyRate, nPayments) - 1) : 0;
    var noi = rent * (1 - expenseRatio);
    var cashFlow = noi - mortgage;
    var downPayment = price * INVESTOR_DOWN_PAYMENT;

    // === 1. Cap Rate (aligned with full scorecard: 6%+ strong, 4%+ ok) ===
    var capRate = (rent * 12 * (1 - expenseRatio)) / price * 100;
    numericScore += Math.min(20, (capRate / 8) * 20);
    if (capRate >= 6) {
      stars++;
      details.push({ text: 'Est. Cap: ' + capRate.toFixed(1) + '%', cls: 'pass' });
    } else if (capRate >= 4) {
      details.push({ text: 'Est. Cap: ' + capRate.toFixed(1) + '%', cls: 'warn' });
    } else {
      details.push({ text: 'Est. Cap: ' + capRate.toFixed(1) + '%', cls: 'fail' });
    }

    // === 2. Estimated DSCR (aligned: 1.25+ strong, 1.0+ ok) ===
    var dscr = mortgage > 0 ? noi / mortgage : 99;
    numericScore += Math.min(20, Math.max(0, (dscr / 1.5) * 20));
    if (dscr >= 1.25) {
      stars++;
      details.push({ text: 'Est. DSCR: ' + dscr.toFixed(2), cls: 'pass' });
    } else if (dscr >= 1.0) {
      details.push({ text: 'Est. DSCR: ' + dscr.toFixed(2), cls: 'warn' });
    } else {
      details.push({ text: 'Est. DSCR: ' + dscr.toFixed(2), cls: 'fail' });
    }

    // === 3. Estimated Monthly Cash Flow ===
    numericScore += Math.min(20, Math.max(0, ((cashFlow + 500) / 1000) * 20));
    if (cashFlow >= 100) {
      stars++;
      details.push({ text: 'Est. CF: +$' + Math.round(cashFlow) + '/mo', cls: 'pass' });
    } else if (cashFlow >= 0) {
      details.push({ text: 'Est. CF: +$' + Math.round(cashFlow) + '/mo', cls: 'warn' });
    } else {
      details.push({ text: 'Est. CF: -$' + Math.abs(Math.round(cashFlow)) + '/mo', cls: 'fail' });
    }

    // === 4. 1% Rule (aligned with full scorecard: pass/fail) ===
    var onePercentPct = (rent / price) * 100;
    numericScore += Math.min(15, (onePercentPct / 1.0) * 15);
    if (onePercentPct >= 1.0) {
      stars++;
      details.push({ text: '1% Rule: ' + onePercentPct.toFixed(2) + '%', cls: 'pass' });
    } else if (onePercentPct >= 0.75) {
      details.push({ text: '1% Rule: ' + onePercentPct.toFixed(2) + '%', cls: 'warn' });
    } else {
      details.push({ text: '1% Rule: ' + onePercentPct.toFixed(2) + '%', cls: 'fail' });
    }

    // === 5. GRM (lower is better) ===
    var grm = price / (rent * 12);
    numericScore += Math.min(15, Math.max(0, ((20 - grm) / 20) * 15));
    if (grm <= 12) {
      stars++;
      details.push({ text: 'GRM: ' + grm.toFixed(1), cls: 'pass' });
    } else if (grm <= 15) {
      details.push({ text: 'GRM: ' + grm.toFixed(1), cls: 'warn' });
    } else {
      details.push({ text: 'GRM: ' + grm.toFixed(1), cls: 'fail' });
    }

    // === 6. Estimated Year-1 Total Return ===
    // The listing carries its own ZIP's historical rate, so a row scores on
    // the same appreciation assumption the analyzer will use for it. Falls
    // back to 3% only when the search returned no local index.
    var apprPct = (listing && typeof listing.apprPct === 'number') ? listing.apprPct : 3;
    var yearlyAppreciation = price * apprPct / 100;
    var yearlyEquity = (mortgage * 12) - (loanAmt * monthlyRate * 12);
    var yearlyCashFlow = cashFlow * 12;
    var totalReturn = yearlyCashFlow + yearlyAppreciation + yearlyEquity;
    var totalReturnPct = downPayment > 0 ? (totalReturn / downPayment * 100) : 0;
    numericScore += Math.min(10, Math.max(0, (totalReturnPct / 15) * 10));
    if (totalReturnPct >= 10) {
      stars++;
      details.push({ text: 'Est. Return: ' + totalReturnPct.toFixed(0) + '% yr1', cls: 'pass' });
    } else if (totalReturnPct >= 5) {
      details.push({ text: 'Est. Return: ' + totalReturnPct.toFixed(0) + '% yr1', cls: 'warn' });
    } else {
      details.push({ text: 'Est. Return: ' + totalReturnPct.toFixed(0) + '% yr1', cls: 'fail' });
    }

    // Apply condition risk discount for cheap properties
    if (price < 100000) {
      var riskPenalty = 0;
      if (price < 50000) { riskPenalty = 25; stars = Math.min(stars, 2); }
      else if (price < 75000) { riskPenalty = 15; }
      else { riskPenalty = 5; }
      numericScore -= riskPenalty;
    }

    numericScore = Math.round(Math.min(100, Math.max(0, numericScore)));

    // Warn on suspiciously cheap properties
    if (isLikelyLot) {
      details.push({ text: 'Verify: may be land only', cls: 'warn' });
    } else if (price < 75000) {
      details.push({ text: 'Likely needs rehab — budget $20-50K+', cls: 'warn' });
    }

    // Say where the rent came from — the score is only as good as this input.
    if (!userRent && listing.rentSource === 'rentcast_market') {
      var comps = listing.rentSampleSize ? ', ' + listing.rentSampleSize + ' comps' : '';
      details.push({ text: 'Rent: $' + fmtInt(rent) + '/mo est' + comps, cls: 'pass' });
      if (listing.rentDaysOnMarket && listing.rentDaysOnMarket > 60) {
        details.push({ text: 'Slow rental market: ' + listing.rentDaysOnMarket + 'd on market', cls: 'warn' });
      }
    } else if (userRent) {
      details.push({ text: 'Rent: your $' + fmtInt(rent) + '/mo for all rows', cls: 'warn' });
    }

    // Flag when rent estimate seems unusually high relative to price
    if (rent > price * 0.015 && price >= 50000) {
      details.push({ text: 'Verify rent estimate', cls: 'warn' });
    }

    var cssClass = 'score-' + Math.min(stars, 6);
    return { stars: stars, numericScore: numericScore, details: details, cssClass: cssClass };
  }

  function computeDeal(inp) {
    var price = inp.price;
    var arvVal = inp.arv;
    var closingCostsVal = inp.closingCosts;
    var rehabVal = inp.rehab;
    var valueGrowthPct = inp.valueGrowthPct;

    var isCash = inp.isCash;
    var dpPct = inp.dpPct;
    var rate = inp.rate;
    var termYears = inp.termYears;
    var pointsVal = inp.points;

    var totalRent = inp.totalRent;
    var otherInc = inp.otherIncome;
    var totalMonthlyIncome = totalRent + otherInc;
    var incomeGrowthPct = inp.incomeGrowthPct;

    var taxesYr = inp.taxesYr;
    var taxGrowthOverridePct = inp.taxGrowthOverridePct;
    var propertyTaxPolicy = inp.propertyTaxPolicy || {
      model: 'market_value', label: 'Projected market-value reassessment',
      annual_cap_pct: null, coverage: 'general'
    };
    var insuranceYr = inp.insuranceYr;
    var maintPct = inp.maintPct;
    var vacPct = inp.vacPct;
    var capexPct = inp.capexPct;
    var mgmtPct = inp.mgmtPct;
    var hoaMonth = inp.hoaMonth;
    var utilMonth = inp.utilMonth;
    var otherExpMonth = inp.otherExpMonth;
    var expGrowthPct = inp.expGrowthPct;
    var propertyType = inp.propertyType;
    var appreciationProfile = inp.appreciationProfile;

    // Loan
    var dpAmount = isCash ? price : price * dpPct / 100;
    var loanAmount = isCash ? 0 : price - dpAmount;
    var n = termYears * 12;
    var monthlyRate = rate / 100 / 12;

    var monthlyPI = 0;
    if (!isCash && loanAmount > 0) {
      if (monthlyRate > 0) {
        monthlyPI = loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, n)) / (Math.pow(1 + monthlyRate, n) - 1);
      } else {
        monthlyPI = loanAmount / n;
      }
    }

    var monthlyTaxes = taxesYr / 12;
    var monthlyInsurance = insuranceYr / 12;
    var piti = monthlyPI + monthlyTaxes + monthlyInsurance;

    // Monthly operating expenses
    var maintExp = totalMonthlyIncome * maintPct / 100;
    var vacExp = totalMonthlyIncome * vacPct / 100;
    var capexExp = totalMonthlyIncome * capexPct / 100;
    var mgmtExp = totalMonthlyIncome * mgmtPct / 100;
    var totalOpex = monthlyTaxes + monthlyInsurance + maintExp + vacExp + capexExp + mgmtExp + hoaMonth + utilMonth + otherExpMonth;

    // Cash flow
    var monthlyCF = totalMonthlyIncome - totalOpex - monthlyPI;
    var annualCF = monthlyCF * 12;

    // NOI
    var noi = (totalMonthlyIncome * 12) - (totalOpex * 12);

    // Total cash invested
    var pointsCost = loanAmount * pointsVal / 100;
    var totalCashInvested = dpAmount + closingCostsVal + rehabVal + pointsCost;

    // Cash on Cash
    var coc = totalCashInvested > 0 ? (annualCF / totalCashInvested) * 100 : 0;

    // Cap rate
    var capRate = price > 0 ? (noi / price) * 100 : 0;

    // GRM
    var annualRent = totalMonthlyIncome * 12;
    var grm = annualRent > 0 ? price / annualRent : 0;

    // Break-even occupancy (expenses excl vacancy + mortgage / rent)
    var expExVacancy = totalOpex - vacExp;
    var breakeven = totalMonthlyIncome > 0 ? ((expExVacancy + monthlyPI) / totalMonthlyIncome) * 100 : 0;

    // DSCR
    var dscr = (monthlyPI * 12 > 0) ? noi / (monthlyPI * 12) : null;

    var totalCashClose = totalCashInvested;

    // New metrics: per-unit, per-sqft and OER
    var sqft = inp.sqft;
    var unitCount = inp.unitCount;

    var pricePerSqft = sqft > 0 ? price / sqft : null;
    var pricePerUnit = price / unitCount;
    var rentPerSqft = sqft > 0 ? totalMonthlyIncome / sqft : null;
    var monthlyCFPerUnit = monthlyCF / unitCount;
    var opexForOER = monthlyTaxes + monthlyInsurance + maintExp + mgmtExp + hoaMonth + utilMonth + otherExpMonth;
    var oer = totalMonthlyIncome > 0 ? (opexForOER / totalMonthlyIncome) * 100 : 0;

    // 1% Rule
    var onePercentPass = totalMonthlyIncome >= price * 0.01;
    var onePercentPct = price > 0 ? (totalMonthlyIncome / price) * 100 : 0;

    // 50% Rule (operating expenses excluding vacancy, as % of gross rent)
    var opexExVacancy = totalOpex - vacExp;
    var fiftyPctRatio = totalMonthlyIncome > 0 ? (opexExVacancy / totalMonthlyIncome) * 100 : 0;

    // 70% Rule
    var seventyPctVal = arvVal > 0 ? ((price + rehabVal) / arvVal) * 100 : 0;
    var seventyPctPass = arvVal > 0 ? (price + rehabVal) <= arvVal * 0.70 : false;
    var show70 = rehabVal > 0 || arvVal > 0;

    // ---- Year-by-year projection ----
    // Runs to PROJECTION_YEARS so every selectable holding period and the
    // what-if horizon table use the same projection path.
    // Build amortization schedule for loan balance lookups
    var amortSchedule = buildAmortSchedule(loanAmount, monthlyRate, n, termYears, monthlyPI);
    var initialEquity = price - loanAmount; // = dpAmount effectively

    var cumulativeCF = 0;
    var projRows = [];

    // Year 1 is the entered/acquisition-year tax bill. Later years are kept
    // separate from general expense inflation and follow either the user's
    // explicit override or the state assessment/tax-bill rule returned by the
    // server. A capped assessed value also cannot outrun projected market
    // value; this captures decline-in-value relief without inventing a refund.
    function projectedAnnualPropertyTax(year) {
      var elapsed = Math.max(0, year - 1);
      if (taxGrowthOverridePct !== null && taxGrowthOverridePct !== undefined) {
        return taxesYr * Math.pow(1 + taxGrowthOverridePct / 100, elapsed);
      }
      var marketTax = taxesYr * Math.pow(1 + valueGrowthPct / 100, elapsed);
      if (propertyTaxPolicy.model === 'assessed_value_cap'
          && propertyTaxPolicy.annual_cap_pct !== null
          && propertyTaxPolicy.annual_cap_pct !== undefined) {
        var cappedTax = taxesYr * Math.pow(1 + propertyTaxPolicy.annual_cap_pct / 100, elapsed);
        // Texas's temporary circuit breaker is not projected beyond its
        // statutory end date unless a later version of the policy extends it.
        if (propertyTaxPolicy.expires_after
            && ((inp.projectionStartYear || new Date().getFullYear()) + elapsed) > propertyTaxPolicy.expires_after) {
          return marketTax;
        }
        return Math.min(cappedTax, marketTax);
      }
      if (propertyTaxPolicy.model === 'tax_bill_cap'
          && propertyTaxPolicy.annual_cap_pct !== null
          && propertyTaxPolicy.annual_cap_pct !== undefined) {
        return Math.min(
          taxesYr * Math.pow(1 + propertyTaxPolicy.annual_cap_pct / 100, elapsed),
          marketTax
        );
      }
      return marketTax;
    }

    for (var yr = 1; yr <= PROJECTION_YEARS; yr++) {
      var rentMult = Math.pow(1 + incomeGrowthPct / 100, yr);
      var expMult = Math.pow(1 + expGrowthPct / 100, yr);
      var valMult = Math.pow(1 + valueGrowthPct / 100, yr);

      var propVal = price * valMult;
      var annualPropertyTax = projectedAnnualPropertyTax(yr);
      var moIncome = totalMonthlyIncome * rentMult;
      var moMaint = moIncome * maintPct / 100;
      var moVac = moIncome * vacPct / 100;
      var moCapex = moIncome * capexPct / 100;
      var moMgmt = moIncome * mgmtPct / 100;
      var moFixedOpex = annualPropertyTax / 12
        + (monthlyInsurance + hoaMonth + utilMonth + otherExpMonth) * expMult;
      var moTotalOpex = moFixedOpex + moMaint + moVac + moCapex + moMgmt;
      var yrCF = (moIncome - moTotalOpex - monthlyPI) * 12;
      cumulativeCF += yrCF;
      var loanBal = (yr <= amortSchedule.length) ? amortSchedule[yr - 1].balance : 0;
      var equity = propVal - loanBal;
      // Unrealized return before selling costs. Upfront costs are still real
      // cash outflows and must be subtracted from profit.
      var unrealizedProfit = cumulativeCF + (equity - initialEquity)
        - closingCostsVal - rehabVal - pointsCost;
      var cumROI = totalCashInvested > 0 ? (unrealizedProfit / totalCashInvested) * 100 : 0;

      // The annual P&L lines the what-if table reports. Purely additive --
      // every existing reader picks fields off the row by name.
      projRows.push({ year: yr, cf: yrCF, cumCF: cumulativeCF, propVal: propVal,
                      loanBal: loanBal, equity: equity, cumROI: cumROI,
                      income: moIncome * 12, opex: moTotalOpex * 12,
                      propertyTax: annualPropertyTax,
                      noi: (moIncome - moTotalOpex) * 12,
                      coc: totalCashInvested > 0 ? (yrCF / totalCashInvested) * 100 : 0 });
    }

    var holdYearsPre = Math.max(1, Math.min(PROJECTION_YEARS, inp.holdYears || 5));
    var holdIdxPre = Math.min(holdYearsPre, projRows.length) - 1;
    // Return components over the selected hold. The exit calculation below
    // turns these into a fully reconciled pre-income-tax profit.
    var totalReturnCF = projRows.length > 0 ? projRows[holdIdxPre].cumCF : cumulativeCF;
    var saleValue = projRows.length > 0 ? projRows[holdIdxPre].propVal : price;
    var exitLoanBal = projRows.length > 0 ? projRows[holdIdxPre].loanBal : loanAmount;
    var totalReturnAppreciation = saleValue - price;
    var totalReturnDebtPaydown = projRows.length > 0 ? loanAmount - exitLoanBal : 0;

    // ---- Cost of getting out ----
    // The gross figure above is what the property is worth, not what you keep.
    // Selling costs at exit can consume a large share of a short-hold gain,
    // which is enough to flip a deal, so they are computed rather than implied.
    //
    // Written as a function of the growth rate because the same arithmetic has
    // to answer "what if appreciation were X" for the comparison figure and for
    // every row of the sensitivity table. Only the sale side varies: cash flow
    // and the loan balance do not depend on the rate, so they are
    // computed once above and closed over here.
    var sellingCostPct = inp.sellingCostPct;
    // An annualized figure computed from total profit ignores *when* the
    // cash arrived; IRR does not, and it is the number these reports are
    // usually read against -- so both are offered rather than one passed off
    // as the other. Bisection rather than Newton: the NPV polynomial has flat
    // stretches where a derivative step overshoots, and halving a bounded
    // bracket 80 times is exact well past the precision anything here displays.
    function irrOf(flows) {
      var npv = function(r) {
        var t = 0;
        for (var i = 0; i < flows.length; i++) t += flows[i] / Math.pow(1 + r, i);
        return t;
      };
      var lo = -0.9999, hi = 10;
      var nlo = npv(lo), nhi = npv(hi);
      // No sign change means no root in the bracket. A deal that never turns
      // positive has no IRR worth quoting, so report nothing rather than a
      // number that looks like an answer.
      if (!isFinite(nlo) || !isFinite(nhi) || (nlo > 0) === (nhi > 0)) return null;
      for (var k = 0; k < 80; k++) {
        var mid = (lo + hi) / 2, nm = npv(mid);
        if ((nm > 0) === (nlo > 0)) { lo = mid; nlo = nm; } else { hi = mid; }
      }
      return ((lo + hi) / 2) * 100;
    }

    function exitAt(ratePct, years) {
      years = years || holdYearsPre;
      var row = projRows[Math.min(years, projRows.length) - 1];
      var value = price * Math.pow(1 + ratePct / 100, years);
      var costs = value * sellingCostPct / 100;
      var netSale = value - costs;
      var appreciationAfterSellingCosts = (value - price) - costs;
      var loanBal = row ? row.loanBal : loanAmount;
      var cumCF = row ? row.cumCF : 0;
      var paydown = loanAmount - loanBal;
      var upfrontCosts = closingCostsVal + rehabVal + pointsCost;
      var preTaxProfit = cumCF + appreciationAfterSellingCosts + paydown - upfrontCosts;
      var annualized = 0;
      if (totalCashInvested > 0) {
        var multiple = 1 + (preTaxProfit / totalCashInvested);
        if (multiple > 0) annualized = (Math.pow(multiple, 1 / years) - 1) * 100;
      }
      // Year 0 is the cash going in; each held year returns its own cash flow,
      // and the last year also returns what the sale nets after paying off the
      // loan. Income taxes are outside this underwriting cash-flow vector.
      var irrPct = null;
      if (totalCashInvested > 0) {
        var flows = [-totalCashInvested];
        for (var fy = 1; fy <= years; fy++) {
          var frow = projRows[Math.min(fy, projRows.length) - 1];
          flows.push(frow ? frow.cf : 0);
        }
        flows[flows.length - 1] += (netSale - loanBal);
        irrPct = irrOf(flows);
      }
      return {
        ratePct: ratePct, years: years, saleValue: value, sellingCosts: costs,
        grossAppreciation: value - price, exitLoanBal: loanBal,
        cumulativeCF: cumCF, debtPaydown: paydown, upfrontCosts: upfrontCosts,
        preTaxNetSaleProceeds: netSale - loanBal,
        appreciationAfterSellingCosts: appreciationAfterSellingCosts,
        preTaxProfit: preTaxProfit, preTaxAnnualizedROI: annualized,
        irr: irrPct
      };
    }

    var exitBase = exitAt(valueGrowthPct, holdYearsPre);
    // The same deal at what this ZIP historically did, shown beside the base
    // case so the conservative default never hides the upside.
    var exitHistorical = null;
    if (appreciationProfile && appreciationProfile.rate_pct !== undefined
        && Math.abs(appreciationProfile.rate_pct - valueGrowthPct) >= 0.05) {
      exitHistorical = exitAt(appreciationProfile.rate_pct, holdYearsPre);
    }

    var sellingCosts = exitBase.sellingCosts;
    var preTaxNetSaleProceeds = exitBase.preTaxNetSaleProceeds;
    var appreciationAfterSellingCosts = exitBase.appreciationAfterSellingCosts;
    var preTaxProfit = exitBase.preTaxProfit;
    var preTaxAnnualizedROI = exitBase.preTaxAnnualizedROI;

    // ---- What the rate could have been ----
    // A single compounding curve implies a confidence the data does not
    // support. The band is the spread of every overlapping five-year window in
    // this ZIP's history, so it reflects how volatile this market actually is
    // rather than a generic error bar.
    var apprBand = null;
    if (appreciationProfile && appreciationProfile.worst_pct !== null
        && appreciationProfile.worst_pct !== undefined) {
      var p = appreciationProfile;
      var atRate = function(pct) { return price * Math.pow(1 + pct / 100, holdYearsPre); };
      // Ordered worst to best so it reads as a risk ladder.
      var scenarios = [
        { key: 'downturn', label: 'Downturn', pct: p.low_pct,
          note: 'weakest 10% of past ' + (p.band_years || 5) + 'yr windows' },
        { key: 'conservative', label: 'Conservative', pct: p.conservative_pct,
          note: 'near inflation \u2014 the default' },
        { key: 'historical', label: 'Historical', pct: p.rate_pct,
          note: 'what this area averaged' },
        { key: 'strong', label: 'Strong', pct: p.high_pct,
          note: 'strongest 10% of past ' + (p.band_years || 5) + 'yr windows' }
      ];
      scenarios.forEach(function(sc) {
        sc.value = atRate(sc.pct);
        // Float comparison: the field rounds to the same 2dp the API sends.
        sc.active = Math.abs(sc.pct - valueGrowthPct) < 0.005;
      });
      apprBand = {
        rate: valueGrowthPct,
        scenarios: scenarios,
        custom: !scenarios.some(function(sc) { return sc.active; }),
        worstPct: p.worst_pct,
        worst: price * (1 + p.worst_pct / 100),
        bandYears: p.band_years,
        label: p.label, window: p.window, source: p.source
      };
    }

    // ---- Price-to-rent drift ----
    // Value growing faster than rent means the price-to-rent ratio expands
    // every year. Over a long hold that is a large unstated bet on cap rate
    // compression, so it gets said out loud rather than compounding quietly.
    var growthGap = valueGrowthPct - incomeGrowthPct;
    var growthWarning = null;
    if (growthGap > 0.5) {
      var ratioDrift = (Math.pow((1 + valueGrowthPct / 100) / (1 + incomeGrowthPct / 100), holdYearsPre) - 1) * 100;
      growthWarning = 'Value growth exceeds rent growth by ' + growthGap.toFixed(1) +
        ' points. Held ' + holdYearsPre + ' years that implies the price-to-rent ratio rises ' +
        Math.round(ratioDrift) + '% \u2014 an implicit bet that cap rates keep compressing.';
    }

    // Deal Score — point-based scorecard
    var dealFactors = [];
    var dealPoints = 0;
    var dealMaxPoints = 0;

    // CoC Return (2/1/0)
    dealMaxPoints += 2;
    if (coc >= 8) { dealPoints += 2; dealFactors.push({ name: 'Cash-on-Cash Return', value: fmtPct(coc), verdict: 'strong', reason: 'Exceeds 8% target' }); }
    else if (coc >= 4) { dealPoints += 1; dealFactors.push({ name: 'Cash-on-Cash Return', value: fmtPct(coc), verdict: 'ok', reason: 'Above 4% minimum but below 8% target' }); }
    else { dealFactors.push({ name: 'Cash-on-Cash Return', value: fmtPct(coc), verdict: 'weak', reason: 'Below 4% minimum threshold' }); }

    // Cap Rate (2/1/0)
    dealMaxPoints += 2;
    if (capRate >= 6) { dealPoints += 2; dealFactors.push({ name: 'Cap Rate', value: fmtPct(capRate), verdict: 'strong', reason: 'Exceeds 6% target' }); }
    else if (capRate >= 4) { dealPoints += 1; dealFactors.push({ name: 'Cap Rate', value: fmtPct(capRate), verdict: 'ok', reason: 'Above 4% but below 6% target' }); }
    else { dealFactors.push({ name: 'Cap Rate', value: fmtPct(capRate), verdict: 'weak', reason: 'Below 4% minimum threshold' }); }

    // DSCR (skip if cash)
    if (dscr !== null) {
      dealMaxPoints += 2;
      if (dscr >= 1.25) { dealPoints += 2; dealFactors.push({ name: 'DSCR', value: fmt(dscr), verdict: 'strong', reason: 'Strong debt service coverage (>= 1.25)' }); }
      else if (dscr >= 1.0) { dealPoints += 1; dealFactors.push({ name: 'DSCR', value: fmt(dscr), verdict: 'ok', reason: 'Covers debt but thin margin (1.0-1.25)' }); }
      else { dealFactors.push({ name: 'DSCR', value: fmt(dscr), verdict: 'weak', reason: 'Cannot cover debt payments (< 1.0)' }); }
    }

    // CF per Unit/mo (2/1/0)
    dealMaxPoints += 2;
    if (monthlyCFPerUnit >= 200) { dealPoints += 2; dealFactors.push({ name: 'Cash Flow / Unit', value: fmtDollar(monthlyCFPerUnit) + '/mo', verdict: 'strong', reason: 'Exceeds $200/unit target' }); }
    else if (monthlyCFPerUnit >= 100) { dealPoints += 1; dealFactors.push({ name: 'Cash Flow / Unit', value: fmtDollar(monthlyCFPerUnit) + '/mo', verdict: 'ok', reason: 'Above $100 but below $200/unit' }); }
    else { dealFactors.push({ name: 'Cash Flow / Unit', value: fmtDollar(monthlyCFPerUnit) + '/mo', verdict: 'weak', reason: 'Below $100/unit minimum' }); }

    // Break-even Occupancy (2/1/0)
    dealMaxPoints += 2;
    if (breakeven <= 75) { dealPoints += 2; dealFactors.push({ name: 'Break-even Occupancy', value: fmtPct(breakeven), verdict: 'strong', reason: 'Strong safety margin (<= 75%)' }); }
    else if (breakeven <= 85) { dealPoints += 1; dealFactors.push({ name: 'Break-even Occupancy', value: fmtPct(breakeven), verdict: 'ok', reason: 'Acceptable but tight margin (75-85%)' }); }
    else { dealFactors.push({ name: 'Break-even Occupancy', value: fmtPct(breakeven), verdict: 'weak', reason: 'High vacancy risk (> 85%)' }); }

    // 1% Rule (2/0)
    dealMaxPoints += 2;
    if (onePercentPass) { dealPoints += 2; dealFactors.push({ name: '1% Rule', value: fmt(onePercentPct) + '%', verdict: 'strong', reason: 'Rent meets or exceeds 1% of price' }); }
    else { dealFactors.push({ name: '1% Rule', value: fmt(onePercentPct) + '%', verdict: 'weak', reason: 'Rent below 1% of purchase price' }); }

    // 50% Rule (2/0)
    var fiftyPass = fiftyPctRatio <= 50;
    dealMaxPoints += 2;
    if (fiftyPass) { dealPoints += 2; dealFactors.push({ name: '50% Rule', value: fmt(fiftyPctRatio) + '%', verdict: 'strong', reason: 'Operating expenses under 50% of income' }); }
    else { dealFactors.push({ name: '50% Rule', value: fmt(fiftyPctRatio) + '%', verdict: 'weak', reason: 'Operating expenses exceed 50% of income' }); }

    var dealPctScore = dealMaxPoints > 0 ? (dealPoints / dealMaxPoints) * 100 : 0;
    var dealGrade, dealText, dealExpl;
    if (dealPctScore >= 75) {
      dealGrade = 'great';
      dealText = 'Great Deal';
      dealExpl = dealPoints + '/' + dealMaxPoints + ' points — Strong across key investment metrics.';
    } else if (dealPctScore >= 45) {
      dealGrade = 'borderline';
      dealText = 'Borderline Deal';
      dealExpl = dealPoints + '/' + dealMaxPoints + ' points — Some metrics are acceptable but the deal has weaknesses.';
    } else {
      dealGrade = 'pass';
      dealText = 'Pass on This Deal';
      dealExpl = dealPoints + '/' + dealMaxPoints + ' points — Most metrics fall below investment thresholds.';
    }

    // Store results
    return {
      price: price, arv: arvVal, closingCosts: closingCostsVal, rehab: rehabVal,
      valueGrowthPct: valueGrowthPct, isCash: isCash, dpPct: dpPct, dpAmount: dpAmount,
      rate: rate, termYears: termYears, points: pointsVal, pointsCost: pointsCost,
      loanAmount: loanAmount, totalRent: totalRent, otherIncome: otherInc,
      totalMonthlyIncome: totalMonthlyIncome, incomeGrowthPct: incomeGrowthPct,
      taxesYr: taxesYr, insuranceYr: insuranceYr, maintPct: maintPct, vacPct: vacPct,
      taxGrowthOverridePct: taxGrowthOverridePct, propertyTaxPolicy: propertyTaxPolicy,
      capexPct: capexPct, mgmtPct: mgmtPct, hoaMonth: hoaMonth, utilMonth: utilMonth,
      otherExpMonth: otherExpMonth, expGrowthPct: expGrowthPct,
      monthlyPI: monthlyPI, piti: piti, totalOpex: totalOpex, monthlyCF: monthlyCF,
      annualCF: annualCF, noi: noi, totalCashInvested: totalCashInvested,
      coc: coc, capRate: capRate, grm: grm, breakeven: breakeven, dscr: dscr,
      totalCashClose: totalCashClose, onePercentPass: onePercentPass, onePercentPct: onePercentPct,
      fiftyPctRatio: fiftyPctRatio, show70: show70, seventyPctVal: seventyPctVal,
      seventyPctPass: seventyPctPass, preTaxAnnualizedROI: preTaxAnnualizedROI,
      dealGrade: dealGrade, dealText: dealText, dealExpl: dealExpl,
      dealFactors: dealFactors, dealPoints: dealPoints, dealMaxPoints: dealMaxPoints,
      sqft: sqft, pricePerSqft: pricePerSqft, pricePerUnit: pricePerUnit,
      rentPerSqft: rentPerSqft, monthlyCFPerUnit: monthlyCFPerUnit, oer: oer,
      unitCount: unitCount,
      totalReturnCF: totalReturnCF, totalReturnAppreciation: totalReturnAppreciation,
      saleValue: saleValue, sellingCostPct: sellingCostPct, sellingCosts: sellingCosts,
      preTaxNetSaleProceeds: preTaxNetSaleProceeds,
      appreciationAfterSellingCosts: appreciationAfterSellingCosts,
      exitHistorical: exitHistorical, exitAt: exitAt,
      preTaxProfit: preTaxProfit, preTaxAnnualizedROI: preTaxAnnualizedROI,
      preTaxIRR: exitBase.irr,
      exitLoanBal: exitLoanBal, apprBand: apprBand, growthWarning: growthWarning,
      holdYears: holdYearsPre,
      totalReturnDebtPaydown: totalReturnDebtPaydown,
      projRows: projRows, amortSchedule: amortSchedule, monthlyRate: monthlyRate,
      propertyType: propertyType, n: n
    };
  }

  // ======================================================================
  // Optional Tax Context
  //
  // Deliberately separate from computeDeal(). This is only a rough display
  // aid; it never enters underwriting cash flow, profit, ROI or IRR.
  // ======================================================================
  function computeTaxContext(inp) {
    var buildingPct = inp.buildingPct;
    var roughBuildingBasis = inp.price * buildingPct / 100;
    return {
      buildingPct: buildingPct,
      roughBuildingBasis: roughBuildingBasis,
      roughAnnualDepreciation: roughBuildingBasis / 27.5
    };
  }

  // ======================================================================
  // Amortization schedule builder (returns array of yearly entries)
  // ======================================================================
  function buildAmortSchedule(loanAmount, monthlyRate, totalPayments, termYears, monthlyPI) {
    if (loanAmount <= 0 || totalPayments <= 0) return [];

    var schedule = [];
    var balance = loanAmount;
    var totalPrincipalPaid = 0;

    for (var year = 1; year <= termYears; year++) {
      var yearPayment = 0, yearPrincipal = 0, yearInterest = 0;

      for (var m = 0; m < 12; m++) {
        if (balance <= 0.01) break;
        var interestPayment = balance * monthlyRate;
        var principalPayment = Math.min(monthlyPI - interestPayment, balance);
        balance -= principalPayment;
        if (balance < 0) balance = 0;
        yearPayment += monthlyPI;
        yearPrincipal += principalPayment;
        yearInterest += interestPayment;
      }

      totalPrincipalPaid += yearPrincipal;

      schedule.push({
        year: year,
        payment: yearPayment,
        principal: yearPrincipal,
        interest: yearInterest,
        balance: Math.max(0, balance),
        totalPrincipalPaid: totalPrincipalPaid
      });
    }

    return schedule;
  }

  // ======================================================================
  // Render Results (Step 6 DOM updates)

  return {
    PROJECTION_YEARS: PROJECTION_YEARS,
    INVESTOR_DOWN_PAYMENT: INVESTOR_DOWN_PAYMENT,
    computeQuickScore: computeQuickScore,
    computeDeal: computeDeal,
    computeTaxContext: computeTaxContext,
    buildAmortSchedule: buildAmortSchedule
  };
});
