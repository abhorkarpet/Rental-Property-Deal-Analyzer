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

  // Balanced underwriting score used by both the full wizard and enriched
  // batch rows. Current income durability stays the majority of the verdict;
  // selected-hold performance gets meaningful weight without allowing assumed
  // appreciation to erase weak debt coverage.
  function computeBalancedScore(metrics) {
    var factors = [];
    var incomePoints = 0;
    var holdPoints = 0;

    function addBand(options) {
      var value = options.value;
      var strong = value !== null && value !== undefined
        && (options.higher ? value >= options.strong : value <= options.strong);
      var ok = value !== null && value !== undefined
        && (options.higher ? value >= options.ok : value <= options.ok);
      var verdict = strong ? 'strong' : (ok ? 'ok' : 'weak');
      var earned = strong ? options.weight : (ok ? options.weight / 2 : 0);
      if (options.category === 'income') incomePoints += earned;
      else holdPoints += earned;
      factors.push({
        category: options.category,
        name: options.name,
        value: options.format(value),
        verdict: verdict,
        reason: strong ? options.strongReason : (ok ? options.okReason : options.weakReason),
        points: earned,
        maxPoints: options.weight
      });
    }

    addBand({
      category: 'income', name: 'Stabilized Cash-on-Cash', value: metrics.coc,
      higher: true, strong: 8, ok: 4, weight: 15, format: fmtPct,
      strongReason: 'At or above the 8% stabilized target',
      okReason: 'Positive but below the 8% target',
      weakReason: 'Below the 4% minimum'
    });
    addBand({
      category: 'income', name: 'Cap Rate', value: metrics.capRate,
      higher: true, strong: 6, ok: 4, weight: 10, format: fmtPct,
      strongReason: 'At or above the 6% unlevered target',
      okReason: 'Between 4% and 6%', weakReason: 'Below 4%'
    });

    if (metrics.dscr === null && metrics.isCash) {
      incomePoints += 15;
      factors.push({
        category: 'income', name: 'Stabilized DSCR', value: 'N/A — cash purchase',
        verdict: 'strong', reason: 'No debt service to cover', points: 15, maxPoints: 15
      });
    } else {
      addBand({
        category: 'income', name: 'Stabilized DSCR', value: metrics.dscr,
        higher: true, strong: 1.25, ok: 1.0, weight: 15,
        format: function(value) { return value === null ? 'N/A' : fmt(value); },
        strongReason: 'NOI covers debt service by at least 1.25x',
        okReason: 'Covers debt, but with a thin margin',
        weakReason: 'NOI does not cover debt service'
      });
    }

    addBand({
      category: 'income', name: 'Stabilized CF / Unit', value: metrics.monthlyCFPerUnit,
      higher: true, strong: 200, ok: 100, weight: 10,
      format: function(value) { return fmtDollar(value) + '/mo'; },
      strongReason: 'At or above $200 per unit monthly',
      okReason: 'Between $100 and $200 per unit monthly',
      weakReason: 'Below $100 per unit monthly'
    });
    addBand({
      category: 'income', name: 'Break-even Occupancy', value: metrics.breakeven,
      higher: false, strong: 75, ok: 85, weight: 10, format: fmtPct,
      strongReason: 'At least a 25% occupancy cushion',
      okReason: 'Positive but thin occupancy cushion',
      weakReason: 'Requires more than 85% occupancy'
    });

    var holdYears = Math.max(1, Number(metrics.holdYears) || 1);
    var rows = (metrics.projRows || []).slice(0, holdYears);
    var positiveYears = rows.filter(function(row) { return row.cf >= 0; }).length;
    var positiveYearPct = rows.length ? positiveYears / rows.length * 100 : 0;
    var averageAnnualOperatingCoC = metrics.totalCashInvested > 0
      ? (Number(metrics.totalReturnCF) || 0) / holdYears / metrics.totalCashInvested * 100
      : null;

    addBand({
      category: 'hold', name: 'After-Sale Pre-Tax IRR', value: metrics.preTaxIRR,
      higher: true, strong: 12, ok: 8, weight: 15,
      format: function(value) { return value === null ? 'N/A' : fmtPct(value); },
      strongReason: 'At or above 12% after modeled selling costs',
      okReason: 'Between 8% and 12% after selling costs',
      weakReason: 'Below 8% or no calculable positive-return IRR'
    });
    addBand({
      category: 'hold', name: 'Avg Annual Operating CoC', value: averageAnnualOperatingCoC,
      higher: true, strong: 8, ok: 4, weight: 15,
      format: function(value) { return value === null ? 'N/A' : fmtPct(value); },
      strongReason: 'Hold-period cash flow averages at least 8% of cash invested yearly',
      okReason: 'Hold-period cash flow averages between 4% and 8% yearly',
      weakReason: 'Hold-period cash flow averages below 4% yearly'
    });
    addBand({
      category: 'hold', name: 'Cash-Flow Positive Years', value: positiveYearPct,
      higher: true, strong: 80, ok: 50, weight: 10,
      format: function(value) {
        return positiveYears + '/' + rows.length + ' (' + fmtPct(value) + ')';
      },
      strongReason: 'At least 80% of held years are cash-flow positive',
      okReason: 'At least half of held years are cash-flow positive',
      weakReason: 'Fewer than half of held years are cash-flow positive'
    });

    var incomeSafetyScore = Math.round(incomePoints / 60 * 100);
    var holdPerformanceScore = Math.round(holdPoints / 40 * 100);
    var overallScore = Math.round(incomePoints + holdPoints);
    var dealGrade = overallScore >= 75 ? 'great' : (overallScore >= 45 ? 'borderline' : 'pass');
    var dealText = overallScore >= 75 ? 'Great Deal'
      : (overallScore >= 45 ? 'Borderline Deal' : 'Pass on This Deal');
    var riskNote = incomeSafetyScore < 45 && holdPerformanceScore >= 50
      ? ' Weak current income; projected hold returns depend on time and exit assumptions.'
      : '';
    return {
      dealGrade: dealGrade,
      dealText: dealText,
      dealExpl: 'Balanced ' + overallScore + '/100 · Income safety '
        + incomeSafetyScore + '/100 · ' + holdYears + '-year performance '
        + holdPerformanceScore + '/100.' + riskNote,
      dealFactors: factors,
      dealPoints: overallScore,
      dealMaxPoints: 100,
      incomeSafetyScore: incomeSafetyScore,
      holdPerformanceScore: holdPerformanceScore,
      averageAnnualOperatingCoC: averageAnnualOperatingCoC,
      cashPositiveYears: positiveYears,
      cashPositiveYearPct: positiveYearPct,
      scoreHoldYears: holdYears
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
      var yrCF = (moIncome - moTotalOpex - monthlyPI) * 12 + incentiveCashFlow;
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

    var balancedScore = computeBalancedScore({
      coc: coc, capRate: capRate, dscr: dscr, isCash: isCash,
      monthlyCFPerUnit: monthlyCFPerUnit, breakeven: breakeven,
      holdYears: holdYearsPre, projRows: projRows,
      totalReturnCF: totalReturnCF, totalCashInvested: totalCashInvested,
      preTaxIRR: exitBase.irr
    });

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
    computeDeal: computeDeal,
    computeTaxContext: computeTaxContext,
    buildAmortSchedule: buildAmortSchedule
  };
});
