import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BUCKETS as backendBuckets,
  classifyPaymentMode as classifyBackend,
} from '../src/utils/paymentMode.js';
import {
  BUCKETS as frontendBuckets,
  NON_CASH_BUCKETS,
  classifyPaymentMode as classifyFrontend,
} from '../../rgaccount/src/utils/paymentMode.js';

const CASES = [
  ['CASH', 'cash'],
  ['cash in hand', 'cash'],
  ['CHEQUE', 'cheque'],
  ['Bank Cheque 4471', 'cheque'],
  ['BANK', 'bank'],
  ['UPI - GPAY', 'bank'],
  ['PHONEPE', 'bank'],
  ['PAYTM', 'bank'],
  ['NEFT', 'bank'],
  ['RTGS', 'bank'],
  ['IMPS', 'bank'],
  ['ONLINE TRANSFER', 'bank'],
  ['BOOKING', 'bank'],
  ['ADJUST', 'bank'],
  ['RETURN', 'bank'],
  ['REFUND', 'bank'],
  ['custom legacy mode', 'bank'],
  ['', 'bank'],
  [null, 'bank'],
  [undefined, 'bank'],
];

test('cash is the only cash book; every other settlement is non-cash', () => {
  for (const [raw, expected] of CASES) {
    assert.equal(classifyBackend(raw), expected, `backend: ${String(raw)}`);
    assert.equal(classifyFrontend(raw), expected, `frontend: ${String(raw)}`);
  }
});

test('frontend and backend expose the same exhaustive buckets', () => {
  assert.deepEqual(frontendBuckets, backendBuckets);
  assert.deepEqual(backendBuckets, ['cash', 'bank', 'cheque']);
  assert.deepEqual(NON_CASH_BUCKETS, ['bank', 'cheque']);

  for (const bucket of backendBuckets) {
    assert.equal(classifyBackend(bucket), bucket);
    assert.equal(classifyFrontend(bucket), bucket);
  }
});

test('Main partitions exactly into Cash and Bank books', () => {
  const amounts = CASES.map(([mode], index) => ({ mode, amount: index + 1 }));
  const main = amounts.reduce((sum, row) => sum + row.amount, 0);
  const cash = amounts
    .filter((row) => classifyBackend(row.mode) === 'cash')
    .reduce((sum, row) => sum + row.amount, 0);
  const bank = amounts
    .filter((row) => classifyBackend(row.mode) !== 'cash')
    .reduce((sum, row) => sum + row.amount, 0);

  assert.equal(main, cash + bank);
});

test('registry mappings are never configured as financial sync sources', async () => {
  for (const name of [
    '080_cashflow_sync_full_coverage.js',
    '081_unified_ledger_bucket.js',
  ]) {
    const source = await readFile(new URL(`../src/migrations/${name}`, import.meta.url), 'utf8');
    const tableList = source.match(/const TABLES = \[([\s\S]*?)\];/)?.[1] || '';

    assert.doesNotMatch(tableList, /plot_registry_payments/, `${name} sync table list`);
    assert.doesNotMatch(source, /ELSIF TG_TABLE_NAME = 'plot_registry_payments'/, `${name} trigger branch`);
    assert.match(source, /DROP TRIGGER IF EXISTS trg_sync_cfe_plot_registry_payments/, `${name} trigger cleanup`);
    assert.match(source, /plot_registry_payments_person/, `${name} historical mirror cleanup`);
  }
});

test('registry mapping accepts every posted plot receipt and rejects unposted rows', async () => {
  const model = await readFile(
    new URL('../src/models/PlotRegistry.model.js', import.meta.url),
    'utf8'
  );
  const controller = await readFile(
    new URL('../src/controllers/registry.controller.js', import.meta.url),
    'utf8'
  );

  assert.doesNotMatch(model, /payment_type[^\n]*IN \('BANK', 'CHEQUE'\)/);
  assert.match(model, /LOWER\(COALESCE\(pp\.status, 'approved'\)\) = 'approved'/);
  assert.match(model, /NOT IN \('BOUNCED', 'RETURNED'\)/);
  assert.match(controller, /LOWER\(COALESCE\(pp\.status, 'approved'\)\) = 'approved'/);
});

test('registry and NOC totals exclude ineligible linked and inline mappings', async () => {
  const model = await readFile(
    new URL('../src/models/PlotRegistry.model.js', import.meta.url),
    'utf8'
  );
  const controller = await readFile(
    new URL('../src/controllers/registry.controller.js', import.meta.url),
    'utf8'
  );

  for (const [name, source, expectedUses] of [
    ['registry model', model, 2],
    ['registry controller', controller, 2],
  ]) {
    const predicate = source.match(/const REGISTRY_PAYMENT_ELIGIBILITY_SQL = `([\s\S]*?)`;/)?.[1] || '';
    assert.match(predicate, /prp\.source_plot_payment_id IS NULL/);
    assert.match(predicate, /UPPER\(COALESCE\(prp\.cheque_status, ''\)\) NOT IN \('BOUNCED', 'RETURNED'\)/);
    assert.match(predicate, /prp\.source_plot_payment_id IS NOT NULL/);
    assert.match(predicate, /LOWER\(COALESCE\(pp\.status, 'approved'\)\) = 'approved'/);
    assert.match(predicate, /UPPER\(COALESCE\(pp\.cheque_status, ''\)\) NOT IN \('BOUNCED', 'RETURNED'\)/);
    assert.equal(
      (source.match(/\$\{REGISTRY_PAYMENT_ELIGIBILITY_SQL\}/g) || []).length,
      expectedUses,
      `${name} must apply eligibility to every registry/NOC aggregate`
    );
  }

  const existingSelectionUpdate = controller.match(
    /UPDATE plot_registry_payments prp[\s\S]*?\[registryId, includedIds, registry\.plot_id/
  )?.[0] || '';
  assert.match(existingSelectionUpdate, /LOWER\(COALESCE\(pp\.status, 'approved'\)\) = 'approved'/);
  assert.match(existingSelectionUpdate, /UPPER\(COALESCE\(pp\.cheque_status, ''\)\) NOT IN \('BOUNCED', 'RETURNED'\)/);
  assert.match(controller, /WHERE prp\.registry_id = \$1 AND prp\.source_plot_payment_id IS NULL\s+AND UPPER\(COALESCE\(prp\.cheque_status, ''\)\) NOT IN \('BOUNCED', 'RETURNED'\)/);
  assert.match(controller, /include_in_noc = CASE[\s\S]*?COALESCE\(cheque_status, ''\)[\s\S]*?THEN FALSE/);
  assert.match(controller, /REGISTRY_PAYMENT_AMOUNT_SQL[\s\S]*?ELSE COALESCE\(pp\.amount, 0\)/);
  assert.match(model, /REGISTRY_PAYMENT_AMOUNT_SQL[\s\S]*?ELSE COALESCE\(pp\.amount, 0\)/);
  assert.match(controller, /pp\.cheque_no, pp\.cheque_status/);
  assert.match(controller, /Linked registry rows mirror their source Plot Payment and cannot be edited independently/);
});

test('farmer split payments are constrained to one exact Cash/Bank partition', async () => {
  const source = await readFile(
    new URL('../src/migrations/082_farmer_split_invariant.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /farmer_payments_split_partition_check/);
  assert.match(source, /cash_amount, 0\) \+ COALESCE\(bank_amount, 0\) = COALESCE\(amount, 0\)/);
  assert.match(source, /COALESCE\(cash_amount, 0\) >= 0/);
  assert.match(source, /COALESCE\(bank_amount, 0\) >= 0/);
});

test('daily DayBook deduplicates vendor mirrors and reads live canonical balance', async () => {
  const source = await readFile(
    new URL('../src/controllers/daybook.controller.js', import.meta.url),
    'utf8'
  );
  const cashFlowModel = await readFile(
    new URL('../src/models/CashFlow.model.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /linkedVendorIds/);
  assert.match(source, /!linkedVendorIds\.has\(Number\(vp\.id\)\)/);
  assert.match(source, /seenLinkedMirrors/);
  assert.match(source, /farmer_payment_id/);
  assert.match(source, /getCanonicalDailyBalance/);
  assert.doesNotMatch(source, /getOrSeedDailyBalance/);
  assert.match(cashFlowModel, /NULLIF\(TRIM\(COALESCE\(cfe\.source_module, ''\)\), ''\) IS NULL/);
});

test('daily DayBook shows specialized mirrors only on the authoritative source date', async () => {
  const source = await readFile(
    new URL('../src/controllers/daybook.controller.js', import.meta.url),
    'utf8'
  );
  const authorityMap = source.match(
    /const authoritativeSourceByMirrorField = new Map\(\[([\s\S]*?)\]\);/
  )?.[1] || '';

  for (const field of [
    'farmer_payment_id',
    'commission_id',
    'cash_flow_entry_id',
    'firm_transaction_id',
    'plot_payment_id',
    'vendor_payment_id',
  ]) {
    assert.match(authorityMap, new RegExp(`'${field}'`), `${field} must use source-date authority`);
  }

  assert.match(source, /const authoritativeSource = authoritativeSourceByMirrorField\.get\(field\)/);
  assert.match(source, /if \(!authoritativeSource\?\.has\(Number\(entry\[field\]\)\)\) return false/);
});

test('DayBook presentation filters do not rewrite book running or closing balances', async () => {
  const source = await readFile(
    new URL('../../rgaccount/src/pages/DayBook.jsx', import.meta.url),
    'utf8'
  );

  assert.match(source, /const routeOpeningBalance = useMemo/);
  assert.match(source, /const dailyRunningBalances = useMemo/);
  assert.match(source, /routeScopedEntries[\s\S]*?sort\(compareEntriesChronologically\)/);
  assert.match(source, /dailyRunningBalances\.get\(String\(e\.id\)\) \?\? routeOpeningBalance/);
  assert.match(source, /Book totals\/closing above remain authoritative/);
  assert.match(source, /const grossRows = \(\(\) =>/);
  assert.match(source, /if \(gi > 0\.001\) inRows\.push\(\{ source: src, label, amount: gi \}\)/);
  assert.match(source, /if \(go > 0\.001\) outRows\.push\(\{ source: src, label, amount: go \}\)/);
});

test('Balance Sheet exports distinguish whole-book accounting from filtered rows', async () => {
  const source = await readFile(
    new URL('../../rgaccount/src/pages/BalanceSheet.jsx', import.meta.url),
    'utf8'
  );

  assert.match(source, /BOOK ACCOUNTING SUMMARY · WHOLE SELECTED BOOK/);
  assert.match(source, /FILTERED SELECTION SUMMARY · PRESENTATION ROWS ONLY/);
  assert.match(source, /does not form a separate closing balance/);
  assert.match(source, /Book accounting summary · whole selected book/);
  assert.match(source, /Filtered selection summary · rows only/);
  assert.match(source, /Row movement only · no closing balance/);
});

test('plot payment accounting uses payment_type, never payment_from', async () => {
  const source = await readFile(
    new URL('../src/controllers/plot.controller.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /normalizePlotPaymentType\(payment_type\)/);
  assert.doesNotMatch(source, /normalizePlotPaymentType\(payment_type, payment_from\)/);
  assert.doesNotMatch(source, /normalizeCashType\(paymentFrom \|\| paymentType\)/);
});

test('firm transactions have one canonical ledger post', async () => {
  const controller = await readFile(
    new URL('../src/controllers/firm.controller.js', import.meta.url),
    'utf8'
  );
  const createBody = controller.match(
    /export const createTransaction[\s\S]*?export const createFirmToFirmTransfer/
  )?.[0] || '';
  const migration = await readFile(
    new URL('../src/migrations/083_firm_single_ledger_post.js', import.meta.url),
    'utf8'
  );

  assert.doesNotMatch(createBody, /cashFlowEntryModel\.create/);
  assert.match(migration, /canonical\.source_module = 'firm_transactions'/);
  assert.match(migration, /DELETE FROM cash_flow_entries/);
});

test('firm-to-firm transfers are constrained to one synchronized row per side', async () => {
  const approval = await readFile(
    new URL('../src/controllers/approval.controller.js', import.meta.url),
    'utf8'
  );
  const migration = await readFile(
    new URL('../src/migrations/084_firm_transfer_pair_invariant.js', import.meta.url),
    'utf8'
  );

  assert.match(migration, /uq_firm_transfer_group_direction/);
  assert.match(migration, /PARTITION BY transfer_group_id, transfer_direction/);
  assert.match(migration, /NOT EXISTS \([\s\S]*?transfer_direction = 'IN'/);
  assert.match(migration, /payment_mode = ledger_bucket\(outbound\.payment_mode\)/);
  assert.match(approval, /ON CONFLICT \(transfer_group_id, transfer_direction\)/);
  assert.match(approval, /Approve the outbound side of this firm transfer/);
  assert.match(approval, /Entry changed while it was being approved/);
  assert.doesNotMatch(approval, /if \(!entry\?\.is_firm_to_firm_transfer\) return/);
});

test('bulk approvals enforce module grants or explicit assignment', async () => {
  const approval = await readFile(
    new URL('../src/controllers/approval.controller.js', import.meta.url),
    'utf8'
  );
  const approveBody = approval.match(
    /export const bulkApprove[\s\S]*?export const bulkReject/
  )?.[0] || '';
  const rejectBody = approval.match(
    /export const bulkReject[\s\S]*?\/\/ ═+/
  )?.[0] || '';

  for (const body of [approveBody, rejectBody]) {
    assert.match(body, /const allowedModules = await getAllowedModules\(req\.user\)/);
    assert.match(body, /isModuleAllowed\(allowedModules, group\.source\)/);
    assert.match(body, /: 'assigned_admin_id = \$3'/);
    assert.match(body, /AND \$\{assignmentCondition\}/);
  }
});

test('cheque status changes preserve transaction amounts', async () => {
  const approval = await readFile(
    new URL('../src/controllers/approval.controller.js', import.meta.url),
    'utf8'
  );
  const body = approval.match(
    /export const updateChequeStatus[\s\S]*?\/\/ If this is a plot commission payment/
  )?.[0] || '';

  assert.doesNotMatch(body, /debit = 0/);
  assert.doesNotMatch(body, /credit = 0/);
  assert.match(body, /cheque_status = \$1/);
});

test('direct Cash Flow mode edits preserve the cheque lifecycle', async () => {
  const source = await readFile(
    new URL('../src/controllers/cashflow.controller.js', import.meta.url),
    'utf8'
  );
  const createBody = source.match(
    /export const createEntry[\s\S]*?export const listEntries/
  )?.[0] || '';
  const updateBody = source.match(
    /export const updateEntry[\s\S]*?export const listFirmsForCashFlow/
  )?.[0] || '';

  assert.match(createBody, /const normalizedCashType = normalizeCashType\(cash_type\)/);
  assert.match(createBody, /cheque_status: normalizedCashType === 'cheque' \? 'PENDING' : null/);
  assert.match(updateBody, /cfe\.cash_type, cfe\.cheque_status, cfe\.cheque_no/);
  assert.match(updateBody, /wasCheque \? \(existing\.cheque_status \|\| 'PENDING'\) : 'PENDING'/);
  assert.match(updateBody, /nextCashType === 'cheque'/);
  assert.match(updateBody, /: null;/);
});

test('DayBook ignores orphan specialized mirrors and V2 approval does not create one', async () => {
  const daybook = await readFile(
    new URL('../src/controllers/daybook.controller.js', import.meta.url),
    'utf8'
  );
  const approval = await readFile(
    new URL('../src/controllers/approval.controller.js', import.meta.url),
    'utf8'
  );
  const approveBody = approval.match(
    /export const approveEntry[\s\S]*?export const rejectEntry/
  )?.[0] || '';

  assert.match(daybook, /requiredMirrorLink/);
  assert.match(daybook, /if \(requiredLink && !entry\[requiredLink\]\) return false/);
  assert.doesNotMatch(approveBody, /INSERT INTO day_book/);
});

test('person-ledger KPI includes mapped mirrors without adding them to site balance', async () => {
  const source = await readFile(
    new URL('../src/graphql/services/kpi.service.js', import.meta.url),
    'utf8'
  );
  const siteCashflow = source.match(/export async function getSiteCashflow[\s\S]*?export async function getOutstanding/)?.[0] || '';
  const outstanding = source.match(/export async function getOutstanding[\s\S]*?export async function getPersonalLedgerCredit/)?.[0] || '';
  const personalCredit = source.match(/export async function getPersonalLedgerCredit[\s\S]*?export async function getRegistryPayments/)?.[0] || '';

  assert.match(siteCashflow, /NOT LIKE '%\\\\_person'/);
  assert.doesNotMatch(outstanding, /NOT LIKE '%\\\\_person'/);
  assert.doesNotMatch(personalCredit, /NOT LIKE '%\\\\_person'/);
  assert.match(outstanding, /cfe\.date < \$2/);
  assert.match(outstanding, /\[siteId, end\]/);
  assert.match(outstanding, /'plot_registry_payments', 'plot_registry_payments_person'/);
  assert.match(outstanding, /GREATEST\(-COALESCE\(cfe\.credit, 0\), 0\)/);
  assert.match(outstanding, /GREATEST\(-COALESCE\(cfe\.debit, 0\), 0\)/);
  assert.match(outstanding, /LOWER\(COALESCE\(cfe\.status, 'approved'\)\) = 'approved'/);
  assert.match(outstanding, /NOT IN \('BOUNCED','RETURNED'\)/);
  assert.match(personalCredit, /GREATEST\(-COALESCE\(cfe\.debit, 0\), 0\)/);
});

test('integrity verifier independently checks cumulative signed person outstanding', async () => {
  const source = await readFile(
    new URL('../src/graphql/services/consistency.service.js', import.meta.url),
    'utf8'
  );
  const runA = source.match(/async function runFromSourceTables[\s\S]*?async function runFromCashFlowEntries/)?.[0] || '';
  const runB = source.match(/async function runFromCashFlowEntries[\s\S]*?function compareRuns/)?.[0] || '';
  const runBOutstanding = runB.match(/Outstanding Run B[\s\S]*?const outstanding/)?.[0] || '';

  assert.match(runA, /WITH source_person_movements AS/);
  assert.match(runA, /direct_person_movements AS/);
  for (const table of [
    'farmer_payments', 'plot_commission_payments', 'day_book',
    'firm_transactions', 'plot_payments', 'expenses', 'vendor_payments',
  ]) {
    assert.match(runA, new RegExp(`FROM ${table}(?:\\s|$)`), `${table} mapped movement must be independently verified`);
  }
  assert.equal(
    (runA.match(/mapped_member_id IS NOT NULL OR [a-z]+\.mapped_user_id IS NOT NULL/g) || []).length,
    7,
    'all seven person-mappable source tables must contribute to Run A'
  );
  assert.match(runA, /GREATEST\(-COALESCE\(credit, 0\), 0\)/);
  assert.match(runA, /GREATEST\(-COALESCE\(debit, 0\), 0\)/);
  assert.match(runA, /'plot_registry_payments', 'plot_registry_payments_person'/);
  assert.match(runA, /\[siteId, end\]/);

  assert.match(runBOutstanding, /cfe\.date < \$2/);
  assert.match(runBOutstanding, /GREATEST\(-COALESCE\(cfe\.credit, 0\), 0\)/);
  assert.match(runBOutstanding, /GREATEST\(-COALESCE\(cfe\.debit, 0\), 0\)/);
  assert.match(runBOutstanding, /'plot_registry_payments', 'plot_registry_payments_person'/);
  assert.match(runBOutstanding, /LOWER\(COALESCE\(cfe\.status, 'approved'\)\) = 'approved'/);
  assert.match(runBOutstanding, /NOT IN \('BOUNCED','RETURNED'\)/);
  assert.doesNotMatch(runBOutstanding, /NOT LIKE '%\\\\_person'/);
  assert.match(runBOutstanding, /\[siteId, end\]/);
});

test('profit KPI, chart, and verifier net expense credits as reversals', async () => {
  const kpi = await readFile(
    new URL('../src/graphql/services/kpi.service.js', import.meta.url),
    'utf8'
  );
  const charts = await readFile(
    new URL('../src/graphql/services/charts.service.js', import.meta.url),
    'utf8'
  );
  const consistency = await readFile(
    new URL('../src/graphql/services/consistency.service.js', import.meta.url),
    'utf8'
  );
  const daybook = await readFile(
    new URL('../src/controllers/daybook.controller.js', import.meta.url),
    'utf8'
  );

  for (const [name, source] of [
    ['KPI', kpi],
    ['charts', charts],
    ['consistency verifier', consistency],
    ['DayBook profit summary', daybook],
  ]) {
    assert.match(
      source,
      /COALESCE\(debit, 0\) - COALESCE\(credit, 0\)/,
      `${name} must reduce expense by approved credit reversals`
    );
  }

  const monthly = daybook.match(
    /export const getProfitMonthly[\s\S]*?export const getLatestDate/
  )?.[0] || '';
  assert.match(monthly, /FROM day_book/);
  assert.match(monthly, /UPPER\(COALESCE\(entry_type, ''\)\) = 'EXPENSE'/);
  assert.match(monthly, /farmer_payment_id IS NULL/);
  assert.match(monthly, /commission_id IS NULL/);
  assert.match(monthly, /vendor_payment_id IS NULL/);
});

test('generic financial reports aggregate posted, non-bounced records only', async () => {
  const source = await readFile(
    new URL('../src/services/reportDefinitions.js', import.meta.url),
    'utf8'
  );

  for (const alias of ['pp', 'e', 'vp', 'fp', 'db', 'ce', 'ft']) {
    assert.match(
      source,
      new RegExp(`LOWER\\(COALESCE\\(${alias}\\.status, 'approved'\\)\\) = 'approved'`),
      `${alias} report must exclude unapproved rows`
    );
    assert.match(
      source,
      new RegExp(`UPPER\\(COALESCE\\(${alias}\\.cheque_status, ''\\)\\) NOT IN \\('BOUNCED','RETURNED'\\)`),
      `${alias} report must exclude bounced/returned rows`
    );
  }

  assert.match(source, /source_module, ''\) NOT IN \('plot_registry_payments', 'plot_registry_payments_person'\)/);
  assert.match(source, /ledger_bucket\(pp\.payment_type\)/);
});

test('plot report received amount sums each posted direct and installment receipt once', async () => {
  const source = await readFile(
    new URL('../src/services/reportDefinitions.js', import.meta.url),
    'utf8'
  );
  const receivedExpr = source.match(/\{ key: 'received',[\s\S]*?label: 'Received'/)?.[0] || '';

  assert.match(receivedExpr, /FROM plot_payments x/);
  assert.match(receivedExpr, /LOWER\(COALESCE\(x\.status, 'approved'\)\) = 'approved'/);
  assert.match(receivedExpr, /FROM plot_installment_payments pip/);
  assert.match(receivedExpr, /UPPER\(COALESCE\(pip\.cheque_status, ''\)\) NOT IN \('BOUNCED','RETURNED'\)/);
  assert.equal((receivedExpr.match(/FROM plot_payments x/g) || []).length, 1);
  assert.equal((receivedExpr.match(/FROM plot_installment_payments pip/g) || []).length, 1);
});

test('dashboard forecast uses posted movements and signed reversal directions', async () => {
  const source = await readFile(
    new URL('../src/controllers/forecast.controller.js', import.meta.url),
    'utf8'
  );

  assert.doesNotMatch(source, /status\s*(?:!=|<>)\s*'rejected'/);
  assert.match(source, /LOWER\(COALESCE\(pp\.status, 'approved'\)\) = 'approved'/);
  assert.match(source, /LOWER\(COALESCE\(fp\.status, 'approved'\)\) = 'approved'/);
  assert.match(source, /RUN_RATE_MOVEMENT_SQL/);
  assert.match(source, /GREATEST\(-COALESCE\(debit, 0\), 0\)/);
  assert.match(source, /GREATEST\(-COALESCE\(credit, 0\), 0\)/);
});

test('member financial summaries include posted non-bounced rows only', async () => {
  const source = await readFile(
    new URL('../src/controllers/member.controller.js', import.meta.url),
    'utf8'
  );

  for (const alias of ['e', 'd', 'pc', 'pp', 'fp', 'ft']) {
    assert.match(
      source,
      new RegExp(`LOWER\\(COALESCE\\(${alias}\\.status, 'approved'\\)\\) = 'approved'`),
      `${alias} member ledger rows must be approved`
    );
    assert.match(
      source,
      new RegExp(`UPPER\\(COALESCE\\(${alias}\\.cheque_status, ''\\)\\) NOT IN \\('BOUNCED', 'RETURNED'\\)`),
      `${alias} member ledger rows must exclude bounced/returned cheques`
    );
  }

  assert.match(source, /normalizedDebit\(row\)/);
  assert.match(source, /normalizedCredit\(row\)/);
});

test('legacy commission cheque metadata follows payment-mode transitions and mirrors DayBook', async () => {
  const source = await readFile(
    new URL('../src/controllers/commission.controller.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /import \{ classifyPaymentMode \}/);
  assert.match(source, /classifyPaymentMode\(currentMode\) !== 'cheque'\) return 'PENDING'/);
  assert.match(source, /cheque_status: isCheque \? 'PENDING' : null/);
  assert.match(source, /cheque_no: isCheque && cheque_no/);
  assert.match(source, /updateData\.cheque_no = nextIsCheque/);
  assert.match(source, /cheque_no: updated\.cheque_no \|\| null/);
  assert.match(source, /cheque_status: updated\.cheque_status \|\| null/);
});

test('V2 commission payment mode edits preserve or reset cheque lifecycle atomically', async () => {
  const source = await readFile(
    new URL('../src/controllers/plotCommissionV2.controller.js', import.meta.url),
    'utf8'
  );
  const updateBody = source.match(
    /export const updatePlotCommissionPayment[\s\S]*?export const deletePlotCommissionPayment/
  )?.[0] || '';

  assert.match(updateBody, /ledger_bucket\(\$\$?\{?paymentModeParamIndex\}?::text\) = 'cheque'/);
  assert.match(updateBody, /ledger_bucket\(plot_commission_payments\.payment_mode\) = 'cheque'/);
  assert.match(updateBody, /ELSE 'PENDING'/);
  assert.match(updateBody, /fields\.push\('cheque_no = NULL'\)/);
  assert.match(source, /const isCheque = classifyPaymentMode\(mode\) === 'cheque'/);
  assert.match(source, /const chequeNumber = isCheque && cheque_no/);
});

test('commission outstanding balances subtract approved non-bounced payments only', async () => {
  const controller = await readFile(
    new URL('../src/controllers/plotCommissionV2.controller.js', import.meta.url),
    'utf8'
  );
  const model = await readFile(
    new URL('../src/models/PlotCommissionV2.model.js', import.meta.url),
    'utf8'
  );

  assert.doesNotMatch(
    model,
    /total_commission - COALESCE\(SUM\(pcp\.amount\) FILTER \(WHERE [^\n]*IN \('approved', 'pending'\)[^\n]*AS balance/
  );
  assert.match(model, /LOWER\(COALESCE\(pcp\.status, 'approved'\)\) = 'approved'/);
  assert.match(model, /UPPER\(COALESCE\(pcp\.cheque_status, ''\)\) NOT IN \('BOUNCED', 'RETURNED'\)/);

  assert.match(controller, /'balance', pc\.total_commission - COALESCE\(paid_agg\.total_paid, 0\)/);
  assert.doesNotMatch(controller, /'balance', pc\.total_commission - COALESCE\(paid_agg\.total_paid_all, 0\)/);
  assert.match(controller, /grand\.balance = grand\.total_commission - grand\.total_paid;/);
  assert.match(controller, /balance: totalCommission - totalPaid/);
  assert.match(controller, /\(m\.total_commission - m\.already_paid\)/);
  assert.doesNotMatch(controller, /m\.already_paid \+ \$3::numeric/);
});
