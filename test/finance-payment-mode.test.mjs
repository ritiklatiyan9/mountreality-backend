import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  assertFinancePaymentModeAllowed,
  FINANCE_PAYMENT_MODES,
  resolvePolicyFromProfile,
} from '../src/services/sitePolicy.service.js';
import {
  normalizeOperatingProfileInput,
  validateOperatingProfile,
} from '../src/services/operatingProfile.service.js';

const publishedProfile = (financePaymentMode) => ({
  id: 9,
  organization_id: 2,
  site_id: 4,
  revision_number: 3,
  lifecycle_status: 'PUBLISHED',
  effective_to: null,
  deleted_at: null,
  operating_model: 'GENERIC_LAND_DEVELOPER',
  project_shape: 'PLOTTED_DEVELOPMENT',
  development_basis: 'OTHER',
  regulatory_status: 'APPLICABILITY_UNDER_REVIEW',
  project_structure: 'SINGLE_PROJECT',
  finance_payment_mode: financePaymentMode,
});

test('finance policy is backward compatible and published-profile driven', () => {
  const legacy = resolvePolicyFromProfile();
  assert.deepEqual(legacy.finance, { payment_mode: 'ALL_MODES', cash_allowed: true });

  const bankOnly = resolvePolicyFromProfile({
    profile: publishedProfile(FINANCE_PAYMENT_MODES.BANK_ONLY),
  });
  assert.deepEqual(bankOnly.finance, { payment_mode: 'BANK_ONLY', cash_allowed: false });
  assert.equal(bankOnly.profile.finance_payment_mode, 'BANK_ONLY');

  const draft = resolvePolicyFromProfile({
    profile: { ...publishedProfile('BANK_ONLY'), lifecycle_status: 'DRAFT' },
  });
  assert.deepEqual(draft.finance, { payment_mode: 'ALL_MODES', cash_allowed: true });
});

test('operating profile validates finance modes and defaults old profiles safely', () => {
  assert.equal(normalizeOperatingProfileInput({}).finance_payment_mode, 'ALL_MODES');
  assert.equal(normalizeOperatingProfileInput({ finance_payment_mode: 'BANK_ONLY' }).finance_payment_mode, 'BANK_ONLY');
  assert.throws(
    () => normalizeOperatingProfileInput({ finance_payment_mode: 'CASH_ONLY' }),
    /Unsupported finance payment mode/,
  );
});

test('a non-regulatory Site can publish its finance choice without a RERA ruleset', async () => {
  let queryCount = 0;
  const validation = await validateOperatingProfile({
    ...publishedProfile('BANK_ONLY'),
    ruleset_version_id: null,
  }, {
    organizationId: 2,
    siteId: 4,
    db: { query: async () => { queryCount += 1; return { rows: [] }; } },
  });
  assert.equal(validation.valid, true);
  assert.equal(queryCount, 0);
});

test('bank-only write guard uses one indexed profile header lookup only for Cash', async () => {
  let queryCount = 0;
  const db = {
    query: async () => {
      queryCount += 1;
      return { rows: [{ site_id: 4, finance_payment_mode: 'BANK_ONLY' }] };
    },
  };

  await assertFinancePaymentModeAllowed({ organizationId: 2, siteId: 4, paymentMode: 'BANK', db });
  assert.equal(queryCount, 0);
  await assert.rejects(
    assertFinancePaymentModeAllowed({ organizationId: 2, siteId: 4, paymentMode: 'CASH', db }),
    (error) => error.code === 'CASH_DISABLED_BY_FINANCE_PROFILE' && error.statusCode === 422,
  );
  assert.equal(queryCount, 1);
});

test('cash restriction is enforced in APIs and at the database boundary', async () => {
  const [plotController, lifecycleController, migration] = await Promise.all([
    readFile(new URL('../src/controllers/plot.controller.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/controllers/propertyLifecycle.controller.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/migrations/116_finance_payment_mode_policy.js', import.meta.url), 'utf8'),
  ]);
  assert.match(plotController, /assertFinancePaymentModeAllowed/);
  assert.match(lifecycleController, /assertFinancePaymentModeAllowed/);
  assert.match(migration, /trg_plot_payments_finance_mode/);
  assert.match(migration, /trg_booking_refunds_finance_mode/);
  assert.match(migration, /idx_site_profiles_tenant_status/);
});
