import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const backend = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const frontend = (file) => readFile(new URL(`../../Frontend/${file}`, import.meta.url), 'utf8');

test('plot list uses set-based aggregates and the matching rollup indexes', async () => {
  const [service, migration] = await Promise.all([
    backend('src/graphql/services/plotPayments.service.js'),
    backend('src/migrations/110_plot_payments_list_rollup.js'),
  ]);
  const listService = service.slice(0, service.indexOf('export async function getPlotAutocomplete'));
  const pageService = service.slice(service.indexOf('export async function getPlotPageData'), service.indexOf('export async function getPlotPaymentDetail'));

  assert.match(listService, /WITH direct_rollup AS/);
  assert.match(listService, /installment_rollup AS/);
  assert.match(listService, /LEFT JOIN direct_rollup/);
  assert.match(listService, /WHERE pp\.site_id = \$1/);
  assert.match(pageService, /const plots = await getPlotsWithTotals\(siteId\)/);
  assert.doesNotMatch(pageService, /getPlotAutocomplete/);
  assert.match(migration, /idx_plot_payments_site_plot_rollup/);
  assert.match(migration, /idx_plot_installment_payments_plot_rollup/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test('plot list defers form metadata and has a real table skeleton', async () => {
  const [page, query] = await Promise.all([
    frontend('src/pages/PlotPayments.jsx'),
    frontend('src/graphql/queries.js'),
  ]);
  const pageQuery = query.slice(query.indexOf('export const GET_PLOT_PAGE_DATA'), query.indexOf('export const GET_PLOT_PAYMENT_DETAIL'));

  assert.match(page, /function PlotPaymentsSkeleton\(\)/);
  assert.match(page, /aria-label="Loading plot payments"/);
  assert.match(page, /const ensureAutocomplete = useCallback/);
  assert.match(page, /const ensureApprovers = useCallback/);
  assert.match(page, /requestIdleCallback/);
  assert.match(page, /void Promise\.all\(\[ensureAutocomplete\(\), ensureApprovers\(\)\]\)/);
  assert.doesNotMatch(pageQuery, /autocomplete \{/);
});
