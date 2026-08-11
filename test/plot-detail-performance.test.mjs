import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const backend = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const frontend = (file) => readFile(new URL(`../../Frontend/${file}`, import.meta.url), 'utf8');

test('plot detail combines receipt aggregates and preserves scoped route protections', async () => {
  const [controller, installments, routes, migration] = await Promise.all([
    backend('src/controllers/plot.controller.js'),
    backend('src/controllers/installment.controller.js'),
    backend('src/routes/plot.routes.js'),
    backend('src/migrations/109_plot_detail_performance.js'),
  ]);

  assert.match(controller, /const plotIdInt = positiveId\(plot_id, 'plot_id'\)/);
  assert.match(controller, /WITH receipts AS/);
  assert.match(controller, /assigned\.name AS assigned_admin_name/);
  assert.doesNotMatch(controller, /plotPaymentModel\.getFromBreakdown\(plotIdInt/);
  assert.match(installments, /const plotId = positiveId\(id, 'plot_id'\)/);
  assert.match(installments, /const \[plot, installments, totalRes\] = await Promise\.all/);
  assert.match(routes, /accessByQueryPlot, plotReadCache, listPayments/);
  assert.match(routes, /accessByParamPlot, plotReadCache, listInstallments/);
  assert.match(migration, /idx_plot_payments_posted_detail/);
  assert.match(migration, /idx_plot_installment_payments_plot_date/);
  assert.match(migration, /idx_plot_payment_allocations_payment/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test('plot detail loads only essential data first and provides a cancellable skeleton state', async () => {
  const page = await frontend('src/pages/PlotDetail.jsx');

  assert.match(page, /function PlotDetailSkeleton\(\)/);
  assert.match(page, /aria-label="Loading plot payment details"/);
  assert.match(page, /new AbortController\(\)/);
  assert.match(page, /controller\.abort\(\)/);
  assert.match(page, /void ensurePaymentMetadata\(\)/);
  assert.match(page, /api\.get\(`\/plots\/payments\/list\?plot_id=\$\{encodeURIComponent\(id\)\}`/);
  assert.doesNotMatch(page, /api\.get\(`\/plots\/\$\{id\}`\)/);
});
