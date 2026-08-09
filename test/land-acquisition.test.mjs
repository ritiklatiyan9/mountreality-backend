import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  acquisitionCompletionChecklist,
  deriveAcquisitionLifecycle,
  deriveFinancialStatus,
  makeAcquisitionReference,
  normalizeAgreement,
  normalizeFinancialTerms,
  normalizeLandDetails,
} from '../src/services/landAcquisition.service.js';

const source = async (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('structured land details require location, parcel identity and area', () => {
  assert.deepEqual(normalizeLandDetails({
    village: 'Bhopa', tehsil: 'Jansath', district: 'Muzaffarnagar',
    khasra: '214/2', land_area: '4.25', area_unit: 'BIGHA', ownership_share: 100,
  }), {
    village: 'Bhopa', tehsil: 'Jansath', district: 'Muzaffarnagar', state: undefined,
    khasra_number: '214/2', survey_number: undefined, parcel_number: undefined,
    land_size_bigha: 4.25, land_size_unit: 'BIGHA', land_type: undefined,
    ownership_share: 100, land_notes: undefined,
  });
  assert.throws(() => normalizeLandDetails({ village: 'Bhopa', land_area: 4.25 }), /Khasra, survey or parcel/);
});

test('executed agreements require a date and remain a separate revision payload', () => {
  assert.throws(() => normalizeAgreement({ agreement_type: 'Purchase', status: 'EXECUTED' }), /date is required/);
  const agreement = normalizeAgreement({
    agreement_type: 'Purchase Agreement', status: 'EXECUTED',
    agreement_date: '2026-08-05', agreement_number: 'AGR-2026-0032', value: 18400000,
  });
  assert.equal(agreement.agreement_status, 'EXECUTED');
  assert.equal(agreement.agreement_value, 18400000);
});

test('financial terms distinguish agreed value from posted transactions', () => {
  const terms = normalizeFinancialTerms({
    total_agreed_value: 18400000,
    cash_component: 7000000,
    bank_component: 11400000,
    schedule: [
      { description: 'Advance', amount: 2000000, due_date: '2026-08-09', preferred_mode: 'CASH' },
      { description: 'Final', amount: 16400000, due_date: '2026-12-01', preferred_mode: 'BANK' },
    ],
  });
  assert.equal(terms.payment_mode, 'SPLIT');
  assert.equal(terms.schedule.length, 2);
  assert.throws(() => normalizeFinancialTerms({
    total_amount: 100, cash_amount: 40, bank_amount: 50,
  }), /must equal/);
});

test('lifecycle and financial status are centralized and deterministic', () => {
  const base = {
    village: 'Bhopa', khasra_number: '214/2', land_size_bigha: 4.25,
    agreement_status: 'EXECUTED', financial_terms_status: 'CONFIRMED',
    total_amount: 18400000, total_paid: 6000000,
  };
  assert.equal(deriveAcquisitionLifecycle(base), 'PAYMENT_IN_PROGRESS');
  assert.equal(deriveFinancialStatus({ totalAmount: 18400000, totalPaid: 6000000 }), 'PARTIALLY_PAID');
  assert.equal(deriveFinancialStatus({ totalAmount: 18400000, totalPaid: 6000000, hasOverdue: true }), 'OVERDUE');
  assert.equal(deriveAcquisitionLifecycle({ ...base, total_paid: 18400000 }), 'FULLY_PAID');
  assert.equal(deriveAcquisitionLifecycle({ ...base, completed_at: '2026-08-09T00:00:00Z' }), 'COMPLETED');
});

test('completion fails closed until business prerequisites are satisfied', () => {
  const incomplete = acquisitionCompletionChecklist({
    village: 'Bhopa', khasra_number: '214/2', land_size_bigha: 4.25,
    agreement_status: 'DRAFT', financial_terms_status: 'CONFIRMED',
    total_amount: 18400000, total_paid: 18400000,
  });
  assert.equal(incomplete.eligible, false);
  assert.equal(incomplete.checks.find((check) => check.key === 'agreement').complete, false);

  const complete = acquisitionCompletionChecklist({
    village: 'Bhopa', khasra_number: '214/2', land_size_bigha: 4.25,
    agreement_status: 'EXECUTED', financial_terms_status: 'CONFIRMED',
    total_amount: 18400000, total_paid: 18400000,
  });
  assert.equal(complete.eligible, true);
});

test('human acquisition reference follows the requested convention', () => {
  assert.equal(makeAcquisitionReference(42, '2026-08-09T00:00:00Z'), 'LA-2026-0042');
});

test('migration is additive and marks untouched legacy rows for review', async () => {
  const migration = await source('src/migrations/095_land_acquisition_workspace.js');
  assert.match(migration, /ALTER TABLE farmers/);
  assert.match(migration, /legacy_mapping_status[\s\S]*REVIEW_REQUIRED/);
  assert.doesNotMatch(migration, /UPDATE\s+farmers\s+SET\s+acquisition_reference/i);
  assert.match(migration, /land_acquisition_agreements/);
  assert.match(migration, /land_acquisition_payment_schedules/);
  assert.match(migration, /land_acquisition_payment_allocations/);
});

test('new workspace reuses farmer_payments and the existing Day Book writer', async () => {
  const controller = await source('src/controllers/landAcquisition.controller.js');
  const farmerController = await source('src/controllers/farmer.controller.js');
  assert.match(controller, /createPayment as createLegacyFarmerPayment/);
  assert.match(controller, /return createLegacyFarmerPayment\(req, res, next\)/);
  assert.match(farmerController, /INSERT INTO farmer_payments/);
  assert.match(farmerController, /INSERT INTO day_book/);
  assert.doesNotMatch(controller, /CREATE TABLE|land_acquisition_transactions/);
});

test('payment submission is idempotent, schedule-bound and completion-aware', async () => {
  const controller = await source('src/controllers/farmer.controller.js');
  const migration = await source('src/migrations/095_land_acquisition_workspace.js');
  assert.match(controller, /idempotency_key/);
  assert.match(controller, /financial_terms_status='CONFIRMED'/);
  assert.match(controller, /f\.completed_at IS NULL/);
  assert.match(controller, /land_acquisition_payment_allocations/);
  assert.match(migration, /uq_farmer_payment_idempotency/);
  assert.match(migration, /uq_farmer_payment_reversal/);
});

test('routes derive the real Site before applying farmers permission', async () => {
  const routes = await source('src/routes/landAcquisition.routes.js');
  assert.match(routes, /byAcquisition, requirePermission\('farmers', 'read'\),[^\n]*getLandAcquisition/);
  assert.match(routes, /byAcquisition, requirePermission\('farmers', 'write'\),[^\n]*recordLandAcquisitionPayment/);
  assert.match(routes, /byQuerySite, requirePermission\('farmers', 'read'\),[^\n]*getLandAcquisitionReports/);
});

test('Land Acquisition documents reuse private compliance evidence storage', async () => {
  const documents = await source('src/controllers/complianceDocument.controller.js');
  const storage = await source('src/utils/plotDocStorage.js');
  assert.match(documents, /LAND_ACQUISITION: \{ module: 'farmers'/);
  assert.match(documents, /SITE_SCOPED_ENTITY_TYPES/);
  assert.match(storage, /startsWith\('compliance\/'\)/);
});

test('frontend exposes exactly the four requested primary Land Acquisition items', async () => {
  const navigation = await source('../Frontend/src/components/sidebar/navConfig.js');
  const app = await source('../Frontend/src/App.jsx');
  assert.match(navigation, /label: term\('land_module', 'Land Acquisition'\)/);
  const acquisitionBlock = navigation.match(/label: term\('land_module', 'Land Acquisition'\)[\s\S]*?\n\s*},\n\s*\{/i)?.[0] || '';
  for (const label of ['Overview', 'Acquisitions', 'Transactions', 'Reports & Analytics']) {
    assert.match(acquisitionBlock, new RegExp(`label: '${label.replace('&', '\\&')}'`));
  }
  assert.doesNotMatch(acquisitionBlock, /label: '(Agreements|Land Details|Payment Schedule|Documents)'/);
  assert.match(app, /path="\/land-acquisition"/);
  assert.match(app, /path="\/land-acquisition\/:id"/);
});

test('new transaction UI records once and offers audited reversal instead of deletion', async () => {
  const detail = await source('../Frontend/src/pages/LandAcquisitionDetail.jsx');
  const drawers = await source('../Frontend/src/components/land-acquisition/AcquisitionEditDrawers.jsx');
  assert.match(drawers, /post\(`\/land-acquisitions\/\$\{acquisition\.id\}\/transactions`/);
  assert.match(drawers, /idempotency_key/);
  assert.match(detail, /Create reversal/);
  assert.doesNotMatch(detail, /delete\(`\/land-acquisitions|Delete payment/);
});
