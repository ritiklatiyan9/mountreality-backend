import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveBankAccountSelection } from '../src/services/bankAccount.service.js';

const backend = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const frontend = (file) => readFile(new URL(`../../Frontend/${file}`, import.meta.url), 'utf8');

test('non-cash API writes require an active account from the same Site', async () => {
  assert.equal(await resolveBankAccountSelection({ siteId: 1, paymentMode: 'CASH' }), null);
  assert.equal(await resolveBankAccountSelection({ siteId: 1, paymentMode: '' }), null);
  await assert.rejects(
    resolveBankAccountSelection({ siteId: 1, paymentMode: 'NEFT' }),
    (error) => error.code === 'BANK_ACCOUNT_REQUIRED' && error.status === 400,
  );
  await assert.rejects(
    resolveBankAccountSelection({
      siteId: 1,
      paymentMode: 'BANK',
      bankAccountId: 9,
      db: { query: async () => ({ rows: [] }) },
    }),
    (error) => error.code === 'BANK_ACCOUNT_SCOPE_MISMATCH' && error.status === 409,
  );
  assert.equal(await resolveBankAccountSelection({
    siteId: 1,
    paymentMode: 'UPI',
    bankAccountId: 9,
    db: { query: async () => ({ rows: [{ id: 9, site_id: 1, is_active: true }] }) },
  }), 9);
});

test('bank-account schema covers every canonical financial source', async () => {
  const migration = await backend('src/migrations/107_bank_account_ledger.js');
  for (const table of [
    'day_book', 'expenses', 'farmer_payments', 'cash_flow_entries',
    'firm_transactions', 'plot_payments', 'plot_installment_payments',
    'vendor_payments', 'vendor_inventory_payments', 'plot_commissions',
    'plot_commission_payments', 'plot_registry_payments', 'booking_refunds',
    'imprest_returns',
  ]) {
    assert.match(migration, new RegExp(`'${table}'`), `${table} must be bank-account mapped`);
  }
  assert.match(migration, /REFERENCES upi_accounts\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /WHERE bank_account_id IS NOT NULL/);
  assert.match(migration, /site_id,bank_account_id/);
  assert.match(migration, /idx_upi_accounts_site_active_name/);
});

test('bank-account APIs are authenticated, permissioned, and site scoped', async () => {
  const [routes, controller, service] = await Promise.all([
    backend('src/routes/bankAccount.routes.js'),
    backend('src/controllers/bankAccount.controller.js'),
    backend('src/services/bankAccount.service.js'),
  ]);
  assert.match(routes, /router\.use\(authMiddleware\)/);
  assert.match(routes, /requireRole\('admin', 'sub_admin'\)/);
  assert.match(routes, /accessByQuerySite/);
  assert.match(routes, /accessByBodySite/);
  assert.match(routes, /accessByParamAccount/);
  assert.match(routes, /requirePermission\('plot_payments', 'write'\)/);
  assert.match(service, /WHERE id=\$1 AND site_id=\$2/);
  assert.match(service, /required = true/);
  assert.match(service, /BANK_ACCOUNT_REQUIRED/);
  assert.match(service, /Selected bank account does not belong to this Site/);
  assert.match(service, /Selected bank account is inactive/);
  assert.match(controller, /RIGHT\(COALESCE\(account_no,''\),4\) AS account_last4/);
  assert.doesNotMatch(
    controller.match(/export const listBankAccountOptions[\s\S]*?export const listBankAccounts/)?.[0] || '',
    /SELECT \*/,
  );
});

test('the account ledger includes direct, installment, vendor, commission and registry sources', async () => {
  const controller = await backend('src/controllers/bankAccount.controller.js');
  for (const source of [
    'plot-payment', 'installment-payment', 'vendor-payment',
    'vendor-inventory-payment', 'commission', 'commission-payment',
    'registry-payment',
  ]) {
    assert.match(controller, new RegExp(`'${source}'`), `${source} must appear in account history`);
  }
  assert.match(controller, /source_plot_payment_id IS NULL/);
  assert.match(controller, /const limit = Math\.min\(positiveId\(req\.query\.limit\) \|\| 25, 100\)/);
  assert.match(controller, /const \[aggregate, \{ rows \}\] = await Promise\.all/);
  assert.match(controller, /ORDER BY date DESC,id DESC[\s\S]*?LIMIT[\s\S]*?OFFSET/);
});

test('all financial entry surfaces use the shared bank-account selector', async () => {
  const files = [
    'src/components/QuickEntry.jsx',
    'src/components/land-acquisition/AcquisitionEditDrawers.jsx',
    'src/pages/Commissions.jsx',
    'src/pages/CreateCommission.jsx',
    'src/pages/CustomerInventory.jsx',
    'src/pages/DayBook.jsx',
    'src/pages/Expenses.jsx',
    'src/pages/FarmerPayments.jsx',
    'src/pages/FirmDetail.jsx',
    'src/pages/FirmTransactions.jsx',
    'src/pages/ImprestDashboard.jsx',
    'src/pages/PaymentManagementPlots.jsx',
    'src/pages/PlotCommissionDetail.jsx',
    'src/pages/PlotDetail.jsx',
    'src/pages/PlotRegistry.jsx',
    'src/pages/PlotRegistryNoc.jsx',
    'src/pages/VendorCommitmentDetail.jsx',
    'src/pages/VendorInventoryDetail.jsx',
    'src/pages/VendorManagement.jsx',
  ];
  for (const file of files) {
    const source = await frontend(file);
    assert.match(source, /BankAccountSelect/, `${file} must render the shared selector`);
    assert.match(source, /bank_account_id/, `${file} must send the selected account id`);
  }
});

test('bank-account options are cached and Bank Configs has no client-side password gate', async () => {
  const [selector, configs] = await Promise.all([
    frontend('src/components/BankAccountSelect.jsx'),
    frontend('src/pages/BankConfigs.jsx'),
  ]);
  assert.match(selector, /CACHE_TTL_MS = 120_000/);
  assert.match(selector, /optionCache/);
  assert.match(selector, /bank-accounts:changed/);
  assert.doesNotMatch(configs, /password/i);
});
