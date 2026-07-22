/**
 * Self-check for the report engine: every module definition must produce a
 * valid report against the real schema.  node test_reports.mjs
 */
import assert from 'node:assert';
import 'dotenv/config';
import pool from './src/config/db.js';
import { REPORTS } from './src/services/reportDefinitions.js';
import { buildReport } from './src/controllers/report.controller.js';

const run = async () => {
  const { rows: [site] } = await pool.query('SELECT id, name FROM sites WHERE ($1::int IS NULL OR id = $1) ORDER BY id LIMIT 1', [process.env.SITE_ID || null]);
  assert(site, 'need at least one site');

  const from = '2000-01-01';
  const to = new Date().toISOString().slice(0, 10);
  let withData = 0;

  for (const key of Object.keys(REPORTS)) {
    const report = await buildReport(key, site.id, from, to, { rowLimit: 25 });
    assert.equal(report.module, key);
    assert.ok(report.kpis.length >= 2, `${key}: kpis`);
    assert.ok(Array.isArray(report.rows), `${key}: rows`);
    assert.ok(report.columns.length > 0, `${key}: columns`);
    // Every declared column must actually come back on a row.
    if (report.rows.length) {
      withData++;
      const cols = Object.keys(report.rows[0]);
      for (const c of report.columns) assert.ok(cols.includes(c.key), `${key}: missing column ${c.key}`);
      // Trend/breakdown must agree with the record count.
      const trendCount = report.trend.reduce((s, t) => s + t.count, 0);
      const kpiCount = report.kpis.find((k) => k.key === 'records').value;
      assert.equal(trendCount, kpiCount, `${key}: trend count != record count`);
      const breakdownCount = report.breakdown.reduce((s, b) => s + b.count, 0);
      assert.ok(breakdownCount <= kpiCount, `${key}: breakdown over-counts`);
    }
    console.log(`  ${key.padEnd(20)} ${String(report.rows.length).padStart(4)} rows  ${report.breakdown.length} groups  ${report.trend.length} buckets`);
  }

  // Date filtering actually narrows the result.
  const wide = await buildReport('plot_payments', site.id, from, to, { rowLimit: 5000 });
  const narrow = await buildReport('plot_payments', site.id, to, to, { rowLimit: 5000 });
  assert.ok(narrow.rows.length <= wide.rows.length, 'date filter must narrow');

  console.log(`✓ ${Object.keys(REPORTS).length} report modules valid (${withData} with data on site "${site.name}")`);
  await pool.end();
};

run().catch((e) => { console.error(e); process.exit(1); });
