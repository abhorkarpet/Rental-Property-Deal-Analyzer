const assert = require('node:assert/strict');
const {
  computeDeal,
  computeQuickScore,
  computeTaxContext
} = require('../static/js/deal-engine.js');

const context = { computeDeal, computeQuickScore, computeTaxContext };

const quickScore = computeQuickScore(
  { price: 200000, estRent: 2200, apprPct: 2.5 },
  null,
  0.065
);
assert.ok(quickScore.numericScore > 0, 'quick scoring should be available from the shared engine');
assert.equal(
  computeQuickScore({ price: 200000 }, null, 0.065).numericScore,
  0,
  'a listing without rent must remain unscored'
);

const input = {
  price: 250000,
  arv: 300000,
  closingCosts: 7500,
  rehab: 15000,
  valueGrowthPct: 3,
  isCash: false,
  dpPct: 25,
  rate: 6.5,
  termYears: 30,
  points: 1,
  totalRent: 2800,
  otherIncome: 100,
  incomeGrowthPct: 2,
  taxesYr: 3000,
  insuranceYr: 1500,
  maintPct: 5,
  vacPct: 5,
  capexPct: 5,
  mgmtPct: 8,
  hoaMonth: 0,
  utilMonth: 0,
  otherExpMonth: 0,
  expGrowthPct: 2,
  sqft: 1800,
  buildingPct: 80,
  sellingCostPct: 7,
  holdYears: 10,
  propertyType: 'sfh',
  unitCount: 1,
  appreciationProfile: null,
  projectionStartYear: 2026,
  taxGrowthOverridePct: null,
  propertyTaxPolicy: {
    model: 'market_value', label: 'Projected market-value reassessment',
    annual_cap_pct: null, coverage: 'general'
  }
};

const result = context.computeDeal(input);
assert.equal(result.strategy, 'hybrid', 'Hybrid is the default strategy');
const profiles = ['cash_flow', 'hybrid', 'appreciation'];
const {computeBalancedScore, scorePreferences} = require('../static/js/deal-engine.js');
const incomeCase = {price:250000, totalRent:3000, totalCashInvested:80000,
  coc:10, dscr:1.5, monthlyCFPerUnit:300, stressCFPerUnit:250,
  scoringIRR:3, flatIRR:2, holdYears:10, projRows:[], totalReturnCF:80000};
const scoreFor = (metrics, strategy) => computeBalancedScore({...metrics, strategy}).dealPoints;
assert.ok(scoreFor(incomeCase, 'cash_flow') > scoreFor(incomeCase, 'hybrid'));
assert.ok(scoreFor(incomeCase, 'hybrid') > scoreFor(incomeCase, 'appreciation'));
const holdCase = {...incomeCase, coc:1, dscr:1.02, monthlyCFPerUnit:20,
  stressCFPerUnit:-150, scoringIRR:12, flatIRR:5};
assert.ok(scoreFor(holdCase, 'appreciation') > scoreFor(holdCase, 'hybrid'));
assert.ok(scoreFor(holdCase, 'hybrid') > scoreFor(holdCase, 'cash_flow'));
profiles.forEach(strategy => {
  const metrics = computeDeal({...input, strategy});
  assert.equal(metrics.dealFactors.reduce((sum,f) => sum+f.maxPoints,0),100);
  assert.ok(metrics.scoreStressCF < metrics.monthlyCF);
  assert.ok(scoreFor({...incomeCase, monthlyCFPerUnit:-301}, strategy) <= 44,
    'An unfunded recurring loss cannot be offset by appreciation');
  assert.ok(scoreFor({...incomeCase, monthlyCFPerUnit:-1}, strategy) < 75,
    'Negative current income is never labeled a strong fit');
  assert.ok(scoreFor({...incomeCase, scoreEvidence:'low'}, strategy) <= 59);
  assert.ok(scoreFor({...incomeCase, missingCosts:true}, strategy) <= 74);
});
const cappedGrowth = computeDeal({...input, valueGrowthPct:3, incomeGrowthPct:3});
const aggressiveGrowth = computeDeal({...input, valueGrowthPct:15, incomeGrowthPct:15});
assert.equal(cappedGrowth.dealPoints, aggressiveGrowth.dealPoints,
  'Increasing appreciation or rent growth above 3% cannot inflate the score');
assert.equal(cappedGrowth.scoringIRR, aggressiveGrowth.scoringIRR);
assert.ok(aggressiveGrowth.preTaxIRR > cappedGrowth.preTaxIRR,
  'The user forecast is retained separately from the bounded scoring scenario');
const flatCase = computeDeal({...input, valueGrowthPct:0});
assert.equal(result.scoreFlatIRR, flatCase.preTaxIRR,
  'No-appreciation return recomputes taxes and costs, not just the sale price');
const stricterTarget = computeDeal({...input,scoreTargets:{coc:20, cashFlow:1000, irr:25}});
assert.ok(stricterTarget.dealPoints <= result.dealPoints);
assert.equal(scorePreferences({strategy:'bogus'}).strategy,'hybrid');
const paidOff = computeDeal({...input,termYears:5,holdYears:10});
assert.equal(paidOff.projRows[5].loanBal,0);
assert.ok(Math.abs(paidOff.projRows[5].cf - (paidOff.projRows[5].income-paidOff.projRows[5].opex)) < 1e-7,
  'Mortgage payments stop after payoff');
const zeroRateScreen = computeQuickScore({price:240000,estRent:2500,rentConfidence:'medium'},null,0);
const cashScreen = computeQuickScore({price:240000,estRent:2500,rentConfidence:'medium'},null,0,{isCash:true});
assert.equal(zeroRateScreen.mortgageRate,0);
assert.ok(Math.abs(cashScreen.monthlyCashFlow-zeroRateScreen.monthlyCashFlow-500) < 1e-7,
  'A 0% loan still repays principal and must differ from buying with cash');
const listingScreen = computeQuickScore({price:250000,estRent:2800,annualTax:3000,hoaFee:25,rentConfidence:'medium'},null,.065);
const equivalentFull = computeDeal({...input,arv:250000,rehab:0,points:0,otherIncome:0,
  insuranceYr:1500,hoaMonth:25,expGrowthPct:3});
assert.equal(listingScreen.numericScore,equivalentFull.dealPoints,
  'Search and full analysis produce the same score with the same assumptions');
assert.equal(listingScreen.monthlyCashFlow,equivalentFull.monthlyCF);
assert.equal(computeQuickScore({price:250000,estRent:2800},null,.065).provisional,true);
assert.equal(result.dealMaxPoints, 100,
  'the balanced score must use an intuitive 100-point scale');
assert.ok(result.dealFactors.some(factor => factor.category === 'income'),
  'the score must expose current income-safety factors');
assert.ok(result.dealFactors.some(factor => factor.category === 'hold'),
  'the score must expose selected-hold performance factors');
assert.ok(!result.dealFactors.some(factor => /1% Rule|50% Rule/.test(factor.name)),
  'rough rules of thumb must remain diagnostics rather than weighted factors');
assert.ok(Math.abs(result.projRows[0].rentIncome
  - input.totalRent * 12) < 1e-7,
  'Year 1 gross rent must use the entered run rate without premature growth');
assert.ok(Math.abs(result.projRows[1].rentIncome
  - input.totalRent * Math.pow(1 + input.incomeGrowthPct / 100, 1) * 12) < 1e-7,
  'rent growth must begin in Year 2');
assert.ok(result.projRows[0].managementExpense > 0,
  'each projection row must expose the net property-management expense');
assert.match(result.growthWarning, /Held 10 years/,
  'the growth warning must use the selected hold period');
const heldRow = result.projRows[result.holdYears - 1];
const directProfit = heldRow.cumCF
  + result.preTaxNetSaleProceeds
  - result.totalCashInvested;
assert.ok(Math.abs(result.preTaxProfit - directProfit) < 1e-7,
  'pre-tax profit must reconcile to cash flow + sale proceeds - initial cash');

const componentProfit = result.totalReturnCF
  + result.appreciationAfterSellingCosts
  + result.totalReturnDebtPaydown
  - result.closingCosts
  - result.rehab
  - result.pointsCost;
assert.ok(Math.abs(result.preTaxProfit - componentProfit) < 1e-7,
  'displayed return components must reconcile to pre-tax profit');

const slowTrajectory = context.computeDeal({
  ...input, arv: input.price, rehab: 0, points: 0, rate: 7,
  totalRent: 1800, otherIncome: 0, incomeGrowthPct: 0,
  expGrowthPct: 3, valueGrowthPct: 2.5
});
const improvingTrajectory = context.computeDeal({
  ...input, arv: input.price, rehab: 0, points: 0, rate: 7,
  totalRent: 1800, otherIncome: 0, incomeGrowthPct: 8,
  expGrowthPct: 1, valueGrowthPct: 2.5
});
assert.equal(improvingTrajectory.incomeSafetyScore, slowTrajectory.incomeSafetyScore,
  'income safety must compare the same stabilized opening run rate');
assert.ok(improvingTrajectory.holdPerformanceScore > slowTrajectory.holdPerformanceScore,
  'the performance score must reward a stronger multi-year cash-flow trajectory');

const percentageOnlyNoGrowth = context.computeDeal({
  ...input, taxesYr: 0, insuranceYr: 0, hoaMonth: 0,
  utilMonth: 0, otherExpMonth: 0, expGrowthPct: 0
});
const percentageOnlyHighGrowth = context.computeDeal({
  ...input, taxesYr: 0, insuranceYr: 0, hoaMonth: 0,
  utilMonth: 0, otherExpMonth: 0, expGrowthPct: 10
});
assert.ok(Math.abs(percentageOnlyNoGrowth.projRows[4].opex
  - percentageOnlyHighGrowth.projRows[4].opex) < 1e-7,
  'fixed-expense growth must not compound rent-percentage expenses');

const fixedExpenseNoGrowth = context.computeDeal({
  ...input, taxesYr: 3000, insuranceYr: 1200, expGrowthPct: 0
});
const fixedExpenseTenGrowth = context.computeDeal({
  ...input, taxesYr: 3000, insuranceYr: 1200, expGrowthPct: 10
});
assert.ok(Math.abs((fixedExpenseTenGrowth.projRows[1].opex
  - fixedExpenseNoGrowth.projRows[1].opex) - 120) < 1e-7,
  'Year 2 fixed-expense growth must apply once to annual insurance');
assert.equal(fixedExpenseTenGrowth.projRows[1].propertyTax,
  fixedExpenseNoGrowth.projRows[1].propertyTax,
  'fixed-expense growth must not alter the separate property-tax projection');

const extraClosing = context.computeDeal({ ...input, closingCosts: input.closingCosts + 5000 });
assert.ok(Math.abs((result.preTaxProfit - extraClosing.preTaxProfit) - 5000) < 1e-7,
  'additional closing costs must reduce profit dollar for dollar');

const incentiveDeal = context.computeDeal({
  ...input,
  incentives: [
    {
      type: 'property_management_discount', promotional_rate_pct: 0,
      normal_rate_pct: 8, start_month: 1, end_month: 24
    },
    { type: 'rent_credit', amount: 900, start_month: 1, end_month: 12 },
    { type: 'closing_credit', amount: 6900 }
  ]
});
assert.equal(incentiveDeal.closingCreditApplied, 6900,
  'a closing credit must reduce eligible acquisition costs');
assert.equal(incentiveDeal.totalCashInvested, result.totalCashInvested - 6900,
  'an applied closing credit must reduce actual cash invested');
assert.equal(incentiveDeal.monthlyCF, result.monthlyCF,
  'temporary incentives must not inflate stabilized monthly cash flow');
assert.equal(incentiveDeal.projRows[0].rentCredit, 900,
  'rent credit must enter Year 1 exactly once');
assert.ok(incentiveDeal.projRows[0].pmIncentiveSavings > 0,
  'the first promotional PM year must include management savings');
assert.ok(incentiveDeal.projRows[1].pmIncentiveSavings > 0,
  'the second promotional PM year must include management savings');
assert.equal(incentiveDeal.projRows[0].managementExpense, 0,
  '0% promotional PM must display zero net PM expense in Year 1');
assert.equal(incentiveDeal.projRows[1].managementExpense, 0,
  '0% promotional PM must display zero net PM expense in Year 2');
assert.equal(incentiveDeal.projRows[2].pmIncentiveSavings, 0,
  'the PM benefit must expire after month 24');
assert.ok(incentiveDeal.projRows[2].managementExpense > 0,
  'stabilized PM expense must return after the promotion expires');
assert.equal(incentiveDeal.projRows[0].oneTimeCredits, 900,
  'the projection must display the Year-1 rent credit');
assert.equal(incentiveDeal.projRows[1].oneTimeCredits, 0,
  'the projection must not repeat a one-time rent credit');
assert.ok(Math.abs(incentiveDeal.projRows[0].pmIncentiveSavings
  - (input.totalRent + input.otherIncome) * input.mgmtPct / 100 * 12) < 1e-7,
  'Year 1 PM savings must use the entered income before growth');
const incentiveBenefit = 6900 + 900
  + incentiveDeal.projRows[0].pmIncentiveSavings
  + incentiveDeal.projRows[1].pmIncentiveSavings;
assert.ok(Math.abs((incentiveDeal.preTaxProfit - result.preTaxProfit) - incentiveBenefit) < 1e-7,
  'hold-period profit must include each timed incentive exactly once');

const cappedCreditDeal = context.computeDeal({
  ...input, points: 0, closingCosts: 3000,
  incentives: [{ type: 'closing_credit', amount: 6900 }]
});
assert.equal(cappedCreditDeal.closingCreditApplied, 3000,
  'closing credits must not silently fund the down payment');
assert.equal(cappedCreditDeal.closingCreditUnused, 3900,
  'unused closing credit must remain disclosed');

const noBuilding = context.computeDeal({ ...input, buildingPct: 0 });
const allBuilding = context.computeDeal({ ...input, buildingPct: 100 });
assert.equal(noBuilding.preTaxProfit, allBuilding.preTaxProfit,
  'tax-context building allocation must not change underwriting profit');
assert.equal(noBuilding.preTaxIRR, allBuilding.preTaxIRR,
  'tax-context building allocation must not change underwriting IRR');
const noBuildingTax = context.computeTaxContext({ ...input, buildingPct: 0 });
const allBuildingTax = context.computeTaxContext({ ...input, buildingPct: 100 });
assert.notEqual(noBuildingTax.roughAnnualDepreciation, allBuildingTax.roughAnnualDepreciation,
  'building allocation should still change the informational depreciation amount');

const flows = [-result.totalCashInvested];
for (let year = 0; year < result.holdYears; year++) flows.push(result.projRows[year].cf);
flows[flows.length - 1] += result.preTaxNetSaleProceeds;
const irrRate = result.preTaxIRR / 100;
const irrNpv = flows.reduce((sum, flow, year) => sum + flow / Math.pow(1 + irrRate, year), 0);
assert.ok(Math.abs(irrNpv) < 1e-6, 'reported pre-tax IRR must zero the same cash-flow vector');

const caPolicy = {
  model: 'assessed_value_cap', label: 'California Proposition 13',
  annual_cap_pct: 2, reassesses_on_sale: true
};
const caDeal = context.computeDeal({
  ...input, valueGrowthPct: 10, expGrowthPct: 20, propertyTaxPolicy: caPolicy
});
assert.equal(caDeal.projRows[0].propertyTax, input.taxesYr,
  'year 1 must use the entered acquisition-year tax bill');
assert.ok(Math.abs(caDeal.projRows[1].propertyTax - input.taxesYr * 1.02) < 1e-7,
  'California tax projection must use the 2% assessment cap, not expense inflation');
assert.ok(Math.abs(caDeal.projRows[4].propertyTax - input.taxesYr * Math.pow(1.02, 4)) < 1e-7,
  'assessment cap must compound from the acquisition-year bill');

const marketDeal = context.computeDeal({
  ...input, valueGrowthPct: 10,
  propertyTaxPolicy: { model: 'market_value', annual_cap_pct: null }
});
assert.ok(Math.abs(marketDeal.projRows[1].propertyTax - input.taxesYr * 1.10) < 1e-7,
  'uncapped states must follow projected market value');

const overrideDeal = context.computeDeal({
  ...input, valueGrowthPct: 10, taxGrowthOverridePct: 4,
  propertyTaxPolicy: caPolicy
});
assert.ok(Math.abs(overrideDeal.projRows[1].propertyTax - input.taxesYr * 1.04) < 1e-7,
  'manual tax-growth override must take precedence over the state policy');

console.log('core calculation tests: OK');
