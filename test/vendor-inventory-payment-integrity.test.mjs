import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('procurement orders expose their payment-derived status instead of a stale delivery status', async () => {
  const controller = await source('src/controllers/vendorInventory.controller.js');
  assert.match(controller, /const ORDER_PAYMENT_STATUS_SQL = `CASE/);
  assert.match(controller, /WHEN COALESCE\(o\.total_paid, 0\) >= \$\{ORDER_VALUE_SQL\} THEN 'completed'/);
  assert.match(controller, /ORDER_PAYMENT_STATUS_SQL\} = \$\$\{idx\}/);
  assert.match(controller, /ORDER_PAYMENT_STATUS_SQL\} AS payment_status/);
});

test('recorded non-cheque vendor payments post to approved financial state', async () => {
  const controller = await source('src/controllers/vendor.controller.js');
  assert.match(controller, /const paymentStatus = isChequePayment \? 'pending' : 'approved'/);
  assert.match(controller, /approved_by, approved_at/);
  assert.match(controller, /const nextStatus = nextPaymentMode === 'cheque'/);
});

test('migration replaces the legacy delivery-based trigger and reconciles linked payment records', async () => {
  const migration = await source('src/migrations/097_procurement_payment_integrity.js');
  assert.match(migration, /097_procurement_payment_integrity_v1/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.sync_vendor_inventory_order/);
  assert.match(migration, /v_paid >= v_value/);
  assert.match(migration, /UPDATE vendor_payments vp/);
  assert.match(migration, /LOWER\(COALESCE\(vp\.payment_mode, 'cash'\)\) <> 'cheque'/);
  assert.match(migration, /UPDATE vendor_payments[\s\S]*SET status = status/);
});
