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

const extraClosing = context.computeDeal({ ...input, closingCosts: input.closingCosts + 5000 });
assert.ok(Math.abs((result.preTaxProfit - extraClosing.preTaxProfit) - 5000) < 1e-7,
  'additional closing costs must reduce profit dollar for dollar');

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
