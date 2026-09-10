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

  // These are editable screening preferences, not market forecasts or lender rules.
  var SCORE_PROFILES = {
    cash_flow: { label: 'Cash flow', weights: [25, 20, 20, 20, 10, 5] },
    hybrid: { label: 'Hybrid', weights: [20, 15, 10, 15, 25, 15] },
    appreciation: { label: 'Appreciation', weights: [5, 10, 5, 15, 50, 15] }
  };
  function scorePreferences(inp) {
    inp = inp || {};
    var raw = inp.scoreTargets || {};
    function target(key, fallback, min, max) {
      var n = Number(raw[key]);
      return raw[key] == null || raw[key] === '' || !isFinite(n) ? fallback : Math.max(min, Math.min(max, n));
    }
    return {
      strategy: Object.prototype.hasOwnProperty.call(SCORE_PROFILES, inp.strategy) ? inp.strategy : 'hybrid',
      coc: target('coc', 8, 1, 30), cashFlow: target('cashFlow', 200, 1, 5000),
      irr: target('irr', 12, 1, 40), maxSubsidy: target('maxSubsidy', 300, 0, 10000)
    };
  }

  function computeQuickScore(listing, userRent, mortgageRate, preferences) {
    var price = Number(listing.price), rent = Number(userRent || listing.estRent);
    var prefs = preferences || {};
    var rate = mortgageRate == null ? 0.07 : Number(mortgageRate);
    if (/multi|duplex|triplex|fourplex|quad/i.test(listing.propertyType || '')) {
      return {strategy:scorePreferences(prefs).strategy,scoreHoldYears:prefs.holdYears || 10,stars:0,numericScore:0,details:[{text:'Enter the per-unit rent roll in Full Analysis to score this multifamily property.',cls:'warn'}],cssClass:'score-0'};
    }
    if (!(price > 0) || !(rent > 0) || !isFinite(price) || !isFinite(rent)) {
      return {strategy:scorePreferences(prefs).strategy,scoreHoldYears:prefs.holdYears || 10,stars:0, numericScore:0, details:[{text:'Price and rent are required to score.', cls:'warn'}], cssClass:'score-0'};
    }
    // All screens use the full cash-flow engine. Costs not supplied by the
    // listing are explicit screening assumptions, never inferred from price bands.
    var inp = Object.assign({
      price:price, arv:price, closingCosts:price * 0.03, rehab:0,
      valueGrowthPct:typeof listing.apprPct === 'number' ? listing.apprPct : 3.5,
      isCash:false, dpPct:25, rate:rate * 100, termYears:30, points:0,
      totalRent:rent, otherIncome:0, incomeGrowthPct:2,
      taxesYr:listing.annualTax > 0 ? Number(listing.annualTax) : price * 0.012,
      insuranceYr:price * 0.006, maintPct:5, vacPct:5, capexPct:5, mgmtPct:8,
      hoaMonth:Number(listing.hoaFee) || 0, utilMonth:0, otherExpMonth:0,
      expGrowthPct:3, sellingCostPct:7, holdYears:10,
      propertyType:'sfh', unitCount:1, sqft:Number(listing.sqft) || 0,
      scoreEvidence:!userRent && listing.rentConfidence !== 'medium' && listing.rentConfidence !== 'high' ? 'low' : 'estimated'
    }, prefs);
    // Preferences may change financing/targets, not listing-specific price/rent.
    inp.price = price; inp.totalRent = rent;
    var result = computeDeal(inp);
    var stars = result.dealPoints >= 90 ? 6 : result.dealPoints >= 75 ? 5
      : result.dealPoints >= 60 ? 4 : result.dealPoints >= 45 ? 3
      : result.dealPoints >= 30 ? 2 : result.dealPoints >= 15 ? 1 : 0;
    var details = [{text:result.dealExpl, cls:'warn'}];
    result.dealFactors.forEach(function(f) {
      details.push({text:f.name + ': ' + f.value + ' · ' + f.points + '/' + f.maxPoints + ' pts. ' + f.reason,
        cls:f.verdict === 'strong' ? 'pass' : f.verdict === 'ok' ? 'warn' : 'fail'});
    });
    details.push({text:'Screen assumptions: ' + (inp.isCash ? 'cash purchase' : inp.dpPct + '% down, ' + inp.rate + '% rate, ' + inp.termYears + ' years')
      + '; 3% closing, ' + inp.points + ' loan points, ' + inp.sellingCostPct + '% sale costs; tax $' + fmtInt(inp.taxesYr) + '/yr, insurance $' + fmtInt(inp.insuranceYr)
      + '/yr; maintenance/vacancy/CapEx 5% each, management 8%; 2% rent / 3% expense growth. HOA $'
      + fmtInt(inp.hoaMonth) + '/mo. Rehab and other costs not verified.', cls:'warn'});
    details.push({text:'Downside: ' + fmtDollar(result.scoreStressCF) + '/mo; total negative cash flow over hold '
      + fmtDollar(result.scoreStressFunding) + ' (excludes upfront cash).', cls:result.scoreStressCF < 0 ? 'warn' : 'pass'});
    if (userRent) details.push({text:'Manual rent override: ' + fmtDollar(rent) + '/mo for all rows.', cls:'warn'});
    return {stars:stars, numericScore:result.dealPoints, details:details, cssClass:'score-' + stars,
      rent:rent, monthlyCashFlow:result.monthlyCF, mortgageRate:inp.rate / 100,
      strategy:result.strategy, provisional:true, scoreHoldYears:result.holdYears};
  }

  function computeBalancedScore(metrics) {
    var prefs = scorePreferences(metrics), profile = SCORE_PROFILES[prefs.strategy];
    var factors = [], incomePoints = 0, holdPoints = 0;
    function factor(index, name, value, floor, target, format, reason) {
      var weight = profile.weights[index];
      var fraction = value == null || !isFinite(value) ? 0 : Math.max(0, Math.min(1, (value - floor) / (target - floor)));
      var points = Math.round(fraction * weight * 10) / 10;
      var category = index < 4 ? 'income' : 'hold';
      if (category === 'income') incomePoints += points; else holdPoints += points;
      factors.push({category:category, name:name, value:value == null ? 'N/A' : format(value),
        verdict:fraction >= 1 ? 'strong' : fraction >= 0.5 ? 'ok' : 'weak',
        reason:reason, points:points, maxPoints:weight});
    }
    factor(0, 'Stabilized Cash-on-Cash', metrics.coc, 0, prefs.coc, fmtPct,
      'Target ' + prefs.coc + '% on all upfront cash, after reserves.');
    factor(1, 'Debt Coverage After Reserves', metrics.isCash ? 1.25 : metrics.dscr, 0.8, 1.25,
      function(v) { return metrics.isCash ? 'N/A — cash purchase' : fmt(v) + 'x'; },
      metrics.isCash ? 'No debt service to cover.' : 'Screening target 1.25x; includes CapEx reserves.');
    factor(2, 'Stabilized CF / Unit', metrics.monthlyCFPerUnit, -prefs.maxSubsidy, prefs.cashFlow,
      function(v) { return fmtDollar(v) + '/mo'; }, 'Target ' + fmtDollar(prefs.cashFlow) + '/unit monthly.');
    factor(3, 'Downside CF / Unit', metrics.stressCFPerUnit, -Math.max(1, prefs.maxSubsidy), prefs.cashFlow,
      function(v) { return fmtDollar(v) + '/mo'; }, 'Rent 10% lower and fixed costs 10% higher; existing vacancy/reserves still apply.');
    factor(4, 'After-Sale Pre-Tax IRR', metrics.scoringIRR, 0, prefs.irr, fmtPct,
      'Target ' + prefs.irr + '%; scoring caps annual appreciation and rent growth at 3%.');
    factor(5, 'No-Appreciation Pre-Tax IRR', metrics.flatIRR, 0, prefs.irr, fmtPct,
      'Same hold and selling costs with 0% value growth; rent growth capped at 3%.');
    var incomeWeight = profile.weights.slice(0,4).reduce(function(a,b) {return a+b;},0);
    var incomeScore = Math.round(incomePoints / incomeWeight * 100);
    var holdScore = Math.round(holdPoints / (100-incomeWeight) * 100);
    var rawScore = Math.round(incomePoints + holdPoints), score = rawScore;
    var limits = [];
    function cap(limit, reason) { score = Math.min(score, limit); limits.push(reason + ' (score ceiling ' + limit + ').'); }
    if (!(metrics.price > 0) || !(metrics.totalCashInvested > 0) || !(metrics.totalRent > 0)) {
      cap(0, 'Enter positive price, rent and cash invested');
    } else {
      if (metrics.monthlyCFPerUnit < -prefs.maxSubsidy) cap(44, 'Monthly loss exceeds your subsidy limit');
      else if (metrics.monthlyCFPerUnit < 0) cap(prefs.strategy === 'cash_flow' ? 44 : 74, 'Current cash flow is negative');
      if (Math.min(metrics.stressCFPerUnit, metrics.stressWorstCFPerUnit == null ? metrics.stressCFPerUnit : metrics.stressWorstCFPerUnit) < -prefs.maxSubsidy) cap(74, 'Downside monthly loss exceeds your subsidy limit');
      if (metrics.scoringIRR != null && metrics.scoringIRR < 0) cap(74, 'Modeled after-sale return is negative');
      if (metrics.scoreEvidence === 'low') cap(59, 'Rent evidence is limited or unavailable');
      if (metrics.missingCosts) cap(74, 'Zero tax, insurance, vacancy or reserves need review');
    }
    var holdYears = metrics.holdYears, rows = (metrics.projRows || []).slice(0,holdYears);
    var positiveYears = rows.filter(function(r) {return r.cf >= 0;}).length;
    return {
      strategy:prefs.strategy, scoreProfile:profile.label, scoreRawPoints:rawScore, scoreLimits:limits,
      dealGrade:score >= 75 ? 'great' : score >= 45 ? 'borderline' : 'pass',
      dealText:score >= 75 ? 'Strong ' + profile.label + ' Fit' : score >= 45 ? 'Conditional ' + profile.label + ' Fit' : 'Weak ' + profile.label + ' Fit',
      dealExpl:profile.label + ' ' + score + '/100 · Income safety ' + incomeScore + '/100 (' + incomeWeight
        + '% weight) · ' + holdYears + '-year performance ' + holdScore + '/100 (' + (100-incomeWeight)
        + '% weight). ' + limits.join(' ') + ' Conditional on entered inputs; not a forecast of market appreciation.',
      dealFactors:factors, dealPoints:score, dealMaxPoints:100, incomeSafetyScore:incomeScore,
      holdPerformanceScore:holdScore, averageAnnualOperatingCoC:metrics.totalCashInvested > 0
        ? metrics.totalReturnCF / holdYears / metrics.totalCashInvested * 100 : null,
      cashPositiveYears:positiveYears, cashPositiveYearPct:rows.length ? positiveYears/rows.length*100 : 0,
      scoreHoldYears:holdYears
    };
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
    var incentives = Array.isArray(inp.incentives) ? inp.incentives : [];

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
    var closingCreditOffered = 0;
    var cashBackApplied = 0;
    var rentCredit = 0;
    incentives.forEach(function(incentive) {
      var amount = Number(incentive && incentive.amount) || 0;
      if (incentive.type === 'closing_credit') closingCreditOffered += amount;
      else if (incentive.type === 'cash_back' || incentive.type === 'unallocated_seller_funds') {
        cashBackApplied += amount;
      } else if (incentive.type === 'rent_credit') rentCredit += amount;
    });
    // A stated closing credit can pay eligible acquisition/loan costs, but it
    // cannot silently become down-payment cash. Preserve any excess so the UI
    // can disclose it instead of manufacturing a benefit.
    var closingCreditApplied = Math.min(
      closingCreditOffered,
      Math.max(0, closingCostsVal + pointsCost)
    );
    var closingCreditUnused = Math.max(0, closingCreditOffered - closingCreditApplied);
    var acquisitionCredits = closingCreditApplied + cashBackApplied;
    var grossUpfrontCosts = closingCostsVal + rehabVal + pointsCost;
    var netUpfrontCosts = grossUpfrontCosts - acquisitionCredits;
    var totalCashInvested = Math.max(0, dpAmount + netUpfrontCosts);

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

    function promotionalMonthsInYear(incentive, year) {
      var promoStart = Math.max(1, Number(incentive.start_month) || 1);
      var promoEnd = Math.max(promoStart, Number(incentive.end_month) || promoStart);
      var yearStart = (year - 1) * 12 + 1;
      var yearEnd = year * 12;
      return Math.max(0, Math.min(promoEnd, yearEnd) - Math.max(promoStart, yearStart) + 1);
    }

    for (var yr = 1; yr <= PROJECTION_YEARS; yr++) {
      // Year 1 is the acquisition-year run rate entered by the user. Growth
      // begins in Year 2; otherwise a $1,550 rent with 2% growth is silently
      // presented as $1,581 in the very first projection year.
      var rentMult = Math.pow(1 + incomeGrowthPct / 100, yr - 1);
      var expMult = Math.pow(1 + expGrowthPct / 100, yr - 1);
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
      var pmIncentiveSavings = 0;
      incentives.forEach(function(incentive) {
        if (!incentive || incentive.type !== 'property_management_discount') return;
        var promoMonths = promotionalMonthsInYear(incentive, yr);
        var promoRate = Number(incentive.promotional_rate_pct);
        if (!promoMonths || !isFinite(promoRate)) return;
        pmIncentiveSavings += moIncome
          * Math.max(0, mgmtPct - promoRate) / 100 * promoMonths;
      });
      var rentCreditForYear = yr === 1 ? rentCredit : 0;
      var incentiveCashFlow = pmIncentiveSavings + rentCreditForYear;
      var annualManagementExpense = Math.max(0, moMgmt * 12 - pmIncentiveSavings);
      var annualDebtService = yr <= amortSchedule.length ? amortSchedule[yr - 1].payment : 0;
      var yrCF = (moIncome - moTotalOpex) * 12 - annualDebtService + incentiveCashFlow;
      cumulativeCF += yrCF;
      var loanBal = (yr <= amortSchedule.length) ? amortSchedule[yr - 1].balance : 0;
      var equity = propVal - loanBal;
      // Unrealized return before selling costs. Upfront costs are still real
      // cash outflows and must be subtracted from profit.
      var unrealizedProfit = cumulativeCF + (equity - initialEquity)
        - netUpfrontCosts;
      var cumROI = totalCashInvested > 0 ? (unrealizedProfit / totalCashInvested) * 100 : 0;

      // The annual P&L lines the what-if table reports. Purely additive --
      // every existing reader picks fields off the row by name.
      projRows.push({ year: yr, cf: yrCF, cumCF: cumulativeCF, propVal: propVal,
                      loanBal: loanBal, equity: equity, cumROI: cumROI,
                      income: moIncome * 12, opex: moTotalOpex * 12,
                      propertyTax: annualPropertyTax,
                      rentIncome: totalRent * rentMult * 12,
                      otherIncome: otherInc * rentMult * 12,
                      managementExpense: annualManagementExpense,
                      noi: (moIncome - moTotalOpex) * 12,
                      incentiveCashFlow: incentiveCashFlow,
                      oneTimeCredits: rentCreditForYear,
                      pmIncentiveSavings: pmIncentiveSavings,
                      rentCredit: rentCreditForYear,
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
      var upfrontCosts = netUpfrontCosts;
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
    // case when a different scenario or custom rate is selected.
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
          note: 'adjusted downside from past ' + (p.band_years || 5) + 'yr windows' },
        { key: 'conservative', label: 'Conservative', pct: p.conservative_pct,
          note: 'lower of market rate and 2.5%' },
        { key: 'historical', label: 'Historical', pct: p.rate_pct,
          note: 'local market rate \u2014 the default' },
        { key: 'strong', label: 'Strong', pct: p.high_pct,
          note: 'adjusted upside from past ' + (p.band_years || 5) + 'yr windows' }
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

    // Recompute operating costs and tax projections for each scoring scenario.
    // The entered forecast remains intact; no recursive scoring inside scenarios.
    var bounded = null, flat = null, stress = null, balancedScore = {};
    if (!inp._skipScore) {
      var scenario = Object.assign({}, inp, {_skipScore:true,
        valueGrowthPct:Math.min(valueGrowthPct, 3), incomeGrowthPct:Math.min(incomeGrowthPct, 3)});
      bounded = computeDeal(scenario);
      flat = computeDeal(Object.assign({}, scenario, {valueGrowthPct:0}));
      stress = computeDeal(Object.assign({}, scenario, {
        valueGrowthPct:Math.min(valueGrowthPct, 0),
        totalRent:totalRent * 0.9, taxesYr:taxesYr * 1.1, insuranceYr:insuranceYr * 1.1,
        hoaMonth:hoaMonth * 1.1, utilMonth:utilMonth * 1.1, otherExpMonth:otherExpMonth * 1.1
      }));
      balancedScore = computeBalancedScore({
        strategy:inp.strategy, scoreTargets:inp.scoreTargets, scoreEvidence:inp.scoreEvidence,
        price:price, totalRent:totalRent, coc:coc, dscr:dscr, isCash:isCash || loanAmount === 0,
        monthlyCFPerUnit:monthlyCFPerUnit, stressCFPerUnit:stress.monthlyCFPerUnit,
        stressWorstCFPerUnit:Math.min.apply(null,stress.projRows.slice(0,holdYearsPre).map(function(row) {return row.cf/12/unitCount;})),
        holdYears:holdYearsPre, projRows:projRows,
        totalReturnCF:totalReturnCF, totalCashInvested:totalCashInvested,
        scoringIRR:bounded.preTaxIRR, flatIRR:flat.preTaxIRR,
        missingCosts:taxesYr <= 0 || insuranceYr <= 0 || vacPct <= 0 || maintPct <= 0 || capexPct <= 0
      });
    }

    // Store results
    return {
      price: price, arv: arvVal, closingCosts: closingCostsVal, rehab: rehabVal,
      valueGrowthPct: valueGrowthPct, isCash: isCash, dpPct: dpPct, dpAmount: dpAmount,
      rate: rate, termYears: termYears, points: pointsVal, pointsCost: pointsCost,
      incentives: incentives, closingCreditOffered: closingCreditOffered,
      closingCreditApplied: closingCreditApplied, closingCreditUnused: closingCreditUnused,
      cashBackApplied: cashBackApplied, acquisitionCredits: acquisitionCredits,
      rentCredit: rentCredit, grossUpfrontCosts: grossUpfrontCosts,
      netUpfrontCosts: netUpfrontCosts,
      loanAmount: loanAmount, totalRent: totalRent, otherIncome: otherInc,
      totalMonthlyIncome: totalMonthlyIncome, incomeGrowthPct: incomeGrowthPct,
      taxesYr: taxesYr, insuranceYr: insuranceYr, maintPct: maintPct, vacPct: vacPct,
      taxGrowthOverridePct: taxGrowthOverridePct, propertyTaxPolicy: propertyTaxPolicy,
      capexPct: capexPct, mgmtPct: mgmtPct, hoaMonth: hoaMonth, utilMonth: utilMonth,
      otherExpMonth: otherExpMonth, expGrowthPct: expGrowthPct,
      monthlyPI: monthlyPI, piti: piti, totalOpex: totalOpex, monthlyCF: monthlyCF,
      annualCF: annualCF, noi: noi, totalCashInvested: totalCashInvested,
      firstYearAnnualCF: projRows.length ? projRows[0].cf : annualCF,
      firstYearMonthlyEquivalent: projRows.length ? projRows[0].cf / 12 : monthlyCF,
      coc: coc, capRate: capRate, grm: grm, breakeven: breakeven, dscr: dscr,
      totalCashClose: totalCashClose, onePercentPass: onePercentPass, onePercentPct: onePercentPct,
      fiftyPctRatio: fiftyPctRatio, show70: show70, seventyPctVal: seventyPctVal,
      seventyPctPass: seventyPctPass, preTaxAnnualizedROI: preTaxAnnualizedROI,
      dealGrade: balancedScore.dealGrade, dealText: balancedScore.dealText,
      dealExpl: balancedScore.dealExpl, dealFactors: balancedScore.dealFactors,
      dealPoints: balancedScore.dealPoints, dealMaxPoints: balancedScore.dealMaxPoints,
      incomeSafetyScore: balancedScore.incomeSafetyScore,
      holdPerformanceScore: balancedScore.holdPerformanceScore,
      averageAnnualOperatingCoC: balancedScore.averageAnnualOperatingCoC,
      cashPositiveYears: balancedScore.cashPositiveYears,
      cashPositiveYearPct: balancedScore.cashPositiveYearPct,
      scoreHoldYears: balancedScore.scoreHoldYears,
      strategy:balancedScore.strategy, scoreProfile:balancedScore.scoreProfile,
      scoreRawPoints:balancedScore.scoreRawPoints, scoreLimits:balancedScore.scoreLimits,
      scoringIRR:bounded ? bounded.preTaxIRR : null, scoreFlatIRR:flat ? flat.preTaxIRR : null,
      scoreAppreciationPct:Math.min(valueGrowthPct, 3), scoreRentGrowthPct:Math.min(incomeGrowthPct, 3),
      scoreStressCF:stress ? stress.monthlyCF : null,
      scoreStressIRR:stress ? stress.preTaxIRR : null,
      scoreStressFunding:stress ? stress.projRows.slice(0,holdYearsPre).reduce(function(total,row) {
        return total + Math.max(0,-row.cf);
      },0) : null,
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
    computeBalancedScore: computeBalancedScore,
    SCORE_PROFILES: SCORE_PROFILES,
    scorePreferences: scorePreferences,
    computeDeal: computeDeal,
    computeTaxContext: computeTaxContext,
    buildAmortSchedule: buildAmortSchedule
  };
});
