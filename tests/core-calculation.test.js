const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'missing function ' + name);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = brace; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unclosed function ' + name);
}

const context = {
  PROJECTION_YEARS: 30,
  fmt: value => Number(value).toFixed(2),
  fmtDollar: value => '$' + Number(value).toFixed(2),
  fmtPct: value => Number(value).toFixed(2) + '%'
};
vm.createContext(context);
vm.runInContext(
  extractFunction('buildAmortSchedule') + '\n'
    + extractFunction('computeDeal') + '\n'
    + extractFunction('computeTaxContext'),
  context
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
  appreciationProfile: null
};

const result = context.computeDeal(input);
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

console.log('core calculation tests: OK');
