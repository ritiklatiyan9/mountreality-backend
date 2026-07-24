import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'dotenv/config';
import { graphql } from 'graphql';

import { getProfit, getProfitMargin } from '../src/graphql/services/kpi.service.js';
import { getFinanceForecast } from '../src/services/forecastEngine.service.js';
import { schema } from '../src/graphql/schema.js';
import pool from '../src/config/db.js';

// ── Pure unit tests: Profit is always Revenue − Expense ──

test('getProfit always equals revenue minus expense', () => {
  assert.equal(getProfit(100000, 40000), 60000);
  assert.equal(getProfit(0, 0), 0);
  assert.equal(getProfit(500, 800), -300); // a loss is a valid, correctly-signed profit
});

test('getProfitMargin is 0-guarded and matches (profit / revenue) * 100', () => {
  assert.equal(getProfitMargin(0, 0), 0);
  assert.equal(getProfitMargin(-100, -50), 0); // never divide by a non-positive revenue
  assert.equal(getProfitMargin(1000, 250), 25);
  assert.equal(getProfitMargin(3, 1), 33.33);
});

// ── Integration tests: GraphQL authorization + tenant/site isolation ──
// These exercise the real financeForecast resolver end-to-end. The
// denial paths never touch the database (requireModuleRead rejects before
// any query runs), so they're as fast and deterministic as a unit test.

const FORECAST_QUERY = `query($siteId: ID!) { financeForecast(siteId: $siteId) { modelVersion } }`;

test('financeForecast rejects an unauthenticated request', async () => {
  const result = await graphql({
    schema, source: FORECAST_QUERY, variableValues: { siteId: '1' },
    contextValue: {},
  });
  assert.ok(result.errors?.length, 'expected an authentication error');
  assert.equal(result.errors[0].extensions.code, 'UNAUTHENTICATED');
});

test('financeForecast rejects a sub_admin without the finance_forecast permission', async () => {
  const result = await graphql({
    schema, source: FORECAST_QUERY, variableValues: { siteId: '1' },
    contextValue: { user: { id: 999, role: 'sub_admin' }, permissions: new Map(), siteIds: new Set([1]) },
  });
  assert.ok(result.errors?.length, 'expected a permission error');
  assert.equal(result.errors[0].extensions.code, 'FORBIDDEN');
  assert.match(result.errors[0].message, /finance_forecast/);
});

test('financeForecast rejects a sub_admin with permission but no access to the requested site (tenant isolation)', async () => {
  const result = await graphql({
    schema, source: FORECAST_QUERY, variableValues: { siteId: '999999' },
    contextValue: {
      user: { id: 999, role: 'sub_admin' },
      permissions: new Map([['finance_forecast', { can_read: true }]]),
      siteIds: new Set([1, 2, 3]), // does not include 999999
    },
  });
  assert.ok(result.errors?.length, 'expected a site-access error');
  assert.equal(result.errors[0].extensions.code, 'FORBIDDEN');
  assert.match(result.errors[0].message, /site/i);
});

test('financeForecast rejects a non-integer siteId before touching the database', async () => {
  const result = await graphql({
    schema, source: FORECAST_QUERY, variableValues: { siteId: 'not-a-number' },
    contextValue: { user: { id: 1, role: 'admin' } },
  });
  assert.ok(result.errors?.length, 'expected a bad-input error');
  assert.equal(result.errors[0].extensions.code, 'BAD_USER_INPUT');
});

// ── Live-DB smoke test: shape + invariants hold for a real site ──
// Skips gracefully (does not fail) if this environment has no sites yet —
// the invariants themselves are exercised either way via the tests above.

test('getFinanceForecast returns an internally-consistent payload for a real site', async (t) => {
  const { rows } = await pool.query('SELECT id FROM sites ORDER BY id LIMIT 1');
  if (!rows[0]) {
    t.skip('no sites in this database — nothing to smoke-test against');
    return;
  }
  const siteId = rows[0].id;
  const result = await getFinanceForecast(siteId, { horizonMonths: 3, lookbackMonths: 6 });

  assert.equal(result.months.length, 3, 'horizonMonths controls the number of forecast months');
  assert.equal(result.history.length, 6, 'lookbackMonths controls the number of history months');
  assert.equal(
    Math.round((result.expectedTotalInflow - result.expectedTotalOutflow) * 100),
    Math.round(result.netMovement * 100),
    'netMovement must equal expectedTotalInflow - expectedTotalOutflow'
  );
  assert.ok(['low', 'medium', 'high'].includes(result.confidenceLevel));
  assert.ok(['low', 'medium', 'high'].includes(result.riskLevel));
  assert.ok(Number.isFinite(result.currentCash));
  assert.ok(result.deficitMonthCount >= 0);

  // Every month's base-scenario net must equal its own inflow minus outflow —
  // never silently summed on top of the scheduled figure (the MAX-not-SUM rule).
  for (const m of result.months) {
    const base = m.scenarios.base;
    assert.equal(
      Math.round((base.inflow - base.outflow) * 100),
      Math.round(base.net * 100),
      `month ${m.key}: net must equal inflow - outflow`
    );
  }

  await pool.end();
});

// ── Policy assertions (static — matches the house style in accounting-policy.test.mjs) ──

test('canonical revenue/expense formula is consolidated, not re-derived, in daybook + consistency services', async () => {
  const daybook = await readFile(new URL('../src/controllers/daybook.controller.js', import.meta.url), 'utf8');
  const consistency = await readFile(new URL('../src/graphql/services/consistency.service.js', import.meta.url), 'utf8');
  const forecastEngine = await readFile(new URL('../src/services/forecastEngine.service.js', import.meta.url), 'utf8');

  assert.match(daybook, /import \{ getRevenue, getExpenseBreakdown, getProfit \} from '\.\.\/graphql\/services\/kpi\.service\.js'/);
  assert.match(consistency, /import \{ getRevenue, getExpenseBreakdown, getProfit, getProfitMargin \} from '\.\/kpi\.service\.js'/);
  assert.match(forecastEngine, /import \{ getRevenue, getExpenseBreakdown, getSiteCashflow \} from '\.\.\/graphql\/services\/kpi\.service\.js'/);
});

test('firm_transactions never appears in the expense/profit or forecast movement unions', async () => {
  const kpi = await readFile(new URL('../src/graphql/services/kpi.service.js', import.meta.url), 'utf8');
  const forecastEngine = await readFile(new URL('../src/services/forecastEngine.service.js', import.meta.url), 'utf8');

  // Slice out just the expense/movement UNION blocks so this doesn't
  // accidentally pass by matching an unrelated part of either file.
  const kpiExpenseBlock = kpi.slice(kpi.indexOf('getExpenseBreakdown'), kpi.indexOf('getSiteCashflow'));
  assert.doesNotMatch(kpiExpenseBlock, /FROM firm_transactions/);

  const movementsBlock = forecastEngine.slice(
    forecastEngine.indexOf('MOVEMENTS_UNION_SQL ='),
    forecastEngine.indexOf('async function getMonthlyHistory')
  );
  assert.doesNotMatch(movementsBlock, /FROM firm_transactions/);
});

test('forecast scenarios never sum the pattern baseline and the scheduled due — always MAX', async () => {
  const forecastEngine = await readFile(new URL('../src/services/forecastEngine.service.js', import.meta.url), 'utf8');
  assert.match(forecastEngine, /combineBaselineAndScheduled = \(pattern, scheduled\) => Math\.max\(pattern, scheduled\)/);
  assert.doesNotMatch(forecastEngine, /scenarioPatternInflow \+ scheduledInflow/);
});

test('forecast movements union excludes bounced/returned cheques and non-approved rows, matching kpi.service.js', async () => {
  const forecastEngine = await readFile(new URL('../src/services/forecastEngine.service.js', import.meta.url), 'utf8');
  const occurrences = forecastEngine.match(/UPPER\(COALESCE\([a-z.]*cheque_status, ''\)\) NOT IN \('BOUNCED','RETURNED'\)/g) || [];
  assert.ok(occurrences.length >= 6, 'every movement union member should exclude bounced/returned cheques');
  assert.doesNotMatch(forecastEngine, /status\s*(?:!=|<>)\s*'rejected'/);
});
