import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AGREEMENT_TRANSITIONS,
  BOOKING_TRANSITIONS,
  assertTransition,
  collectionSummary,
  evaluateCollectionPolicy,
  normalizeBookingPayload,
  normalizeSchedule,
} from '../src/services/propertyLifecycle.service.js';

test('booking normalization preserves an immutable commercial snapshot', () => {
  const payload = normalizeBookingPayload({
    plot_id: 42,
    primary_allottee_id: 8,
    joint_allottee_ids: [9, 9, 8],
    base_price: '3000000.00',
    charges: '100000.00',
    discount_amount: '50000.00',
    price_version: 'PG-2026-08',
    booking_date: '2026-08-01',
    payment_schedule: [
      { name: 'Booking', amount: '200000', due_date: '2026-08-01' },
      { name: 'Agreement', amount: '500000', due_date: '2026-08-08' },
      { name: 'Installment 1', amount: '500000', due_date: '2026-08-20' },
      { name: 'Installment 2', amount: '500000', due_date: '2026-09-20' },
      { name: 'Registry', amount: '1350000', due_date: '2026-10-15' },
    ],
  });
  assert.equal(payload.final_consideration, '3050000.00');
  assert.deepEqual(payload.joint_allottee_ids, [9]);
  assert.equal(payload.commercial_snapshot.price_version, 'PG-2026-08');
  assert.equal(payload.payment_schedule.length, 5);
});

test('schedule cannot silently diverge from booking consideration', () => {
  assert.throws(
    () => normalizeSchedule([{ name: 'Booking', amount: '100', due_date: '2026-08-01' }], '200.00'),
    (error) => error.code === 'SCHEDULE_TOTAL_MISMATCH',
  );
});

test('state transitions are centralized and fail closed', () => {
  assert.equal(assertTransition(BOOKING_TRANSITIONS, 'BOOKED', 'ALLOTTED', 'Booking'), 'ALLOTTED');
  assert.equal(assertTransition(AGREEMENT_TRANSITIONS, 'APPROVED_FOR_EXECUTION', 'EXECUTED', 'Agreement'), 'EXECUTED');
  assert.throws(
    () => assertTransition(BOOKING_TRANSITIONS, 'BOOKED', 'POSSESSED', 'Booking'),
    (error) => error.code === 'INVALID_STATE_TRANSITION',
  );
});

test('unreviewed ruleset configuration warns but never invents a legal block', () => {
  const result = evaluateCollectionPolicy({
    workflowPolicy: { collections: { agreement_guard: { enabled: true, decision: 'BLOCKED' } } },
    ruleset: { id: 1, code: 'HRERA_FOUNDATION', version: 1, source_review_status: 'PENDING' },
    agreementStatus: 'NOT_STARTED',
    proposedAmount: '500000',
  });
  assert.equal(result.decision, 'WARNING');
  assert.equal(result.code, 'COLLECTION_POLICY_SOURCE_NOT_REVIEWED');
});

test('reviewed explicit agreement control produces an explainable decision', () => {
  const result = evaluateCollectionPolicy({
    workflowPolicy: {
      collections: {
        agreement_guard: {
          enabled: true,
          accepted_statuses: ['EXECUTED'],
          decision: 'REQUIRES_APPROVAL',
          message: 'Agreement review is required before this collection',
          rule_reference: 'TENANT-REVIEWED-1',
        },
      },
    },
    ruleset: { id: 12, code: 'TENANT_RULES', version: 2, source_review_status: 'REVIEWED' },
    agreementStatus: 'PREPARED',
    currentQualifyingCollection: '300000',
    proposedAmount: '200000',
  });
  assert.equal(result.decision, 'REQUIRES_APPROVAL');
  assert.equal(result.after_receipt, '500000.00');
  assert.equal(result.rule, 'TENANT-REVIEWED-1');
});

test('collection summary keeps schedule, receipts, refunds and outstanding distinct', () => {
  assert.deepEqual(collectionSummary({ consideration: 3050000, scheduled: 3050000, received: 1500000, refunded: 100000, overdue: 200000, future: 1350000 }), {
    consideration: '3050000.00',
    scheduled: '3050000.00',
    received: '1500000.00',
    refunded: '100000.00',
    net_received: '1400000.00',
    overdue: '200000.00',
    future: '1350000.00',
    outstanding: '1650000.00',
    percentage: 45.9,
  });
});

test('Phase 2 migration extends existing financial engines instead of shadowing them', async () => {
  const migration = await readFile(new URL('../src/migrations/096_property_customer_finance_lifecycle.js', import.meta.url), 'utf8');
  assert.match(migration, /ALTER TABLE plot_payments/);
  assert.match(migration, /ALTER TABLE plot_registries/);
  assert.match(migration, /ALTER TABLE documents/);
  assert.match(migration, /ALTER TABLE firm_transactions/);
  assert.match(migration, /ALTER TABLE day_book/);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS rera_customer_payments/i);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS rera_plot_registr/i);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS customer_documents/i);
});

test('existing Plot Payment route performs booking allocation and ruleset guard', async () => {
  const controller = await readFile(new URL('../src/controllers/plot.controller.js', import.meta.url), 'utf8');
  assert.match(controller, /resolveCollectionGuard/);
  assert.match(controller, /INSERT INTO plot_payments/);
  assert.match(controller, /INSERT INTO plot_payment_allocations/);
  assert.match(controller, /Idempotency-Key/);
});

test('existing Registry create path derives booking, allottee, project, phase and agreement context', async () => {
  const controller = await readFile(new URL('../src/controllers/registry.controller.js', import.meta.url), 'utf8');
  assert.match(controller, /current_booking_id/);
  assert.match(controller, /booking_id,allottee_member_id,rera_project_id,rera_project_phase_id,agreement_id/);
});

test('database migration serializes booking and enforces lifecycle relationship scope', async () => {
  const migration = await readFile(new URL('../src/migrations/096_property_customer_finance_lifecycle.js', import.meta.url), 'utf8');
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /uq_bookings_one_active_plot/);
  assert.match(migration, /validate_property_booking_scope/);
  assert.match(migration, /validate_property_project_mapping/);
  assert.match(migration, /validate_plot_payment_lifecycle_scope/);
  assert.match(migration, /validate_plot_payment_allocation_scope/);
  assert.match(migration, /validate_plot_registry_lifecycle_scope/);
  assert.match(migration, /validate_project_account_scope/);
  assert.match(migration, /uq_project_allocation_scope/);
});

test('only approved cleared receipts reduce schedule due and overdue balances', async () => {
  const controller = await readFile(new URL('../src/controllers/propertyLifecycle.controller.js', import.meta.url), 'utf8');
  assert.match(controller, /JOIN plot_payments allocated_payment ON allocated_payment\.id=ppa\.plot_payment_id/);
  assert.match(controller, /LOWER\(COALESCE\(allocated_payment\.status,'approved'\)\)='approved'/);
  assert.match(controller, /NOT IN \('BOUNCED','RETURNED'\)/);
});

test('cancellation preserves receipts and posts refunds through the canonical bank-mapped Day Book path', async () => {
  const controller = await readFile(new URL('../src/controllers/propertyLifecycle.controller.js', import.meta.url), 'utf8');
  assert.match(controller, /releaseWithoutRefund/);
  assert.match(controller, /current_booking_id=NULL/);
  assert.match(controller, /INSERT INTO day_book/);
  assert.match(controller, /bank_account_id/);
  assert.doesNotMatch(controller, /INSERT INTO firm_transactions/);
  assert.doesNotMatch(controller, /DELETE FROM plot_payments/);
});

test('project finance adds reviewed mappings and allocations over original transactions', async () => {
  const controller = await readFile(new URL('../src/controllers/propertyLifecycle.controller.js', import.meta.url), 'utf8');
  const routes = await readFile(new URL('../src/routes/propertyLifecycle.routes.js', import.meta.url), 'utf8');
  assert.match(controller, /INSERT INTO project_account_mappings/);
  assert.match(controller, /INSERT INTO project_transaction_allocations/);
  assert.match(controller, /PROJECT_ALLOCATION_SOURCES/);
  assert.match(controller, /Project allocations exceed the original transaction amount/);
  assert.match(routes, /project-finance\/accounts/);
  assert.match(routes, /project-finance\/allocations/);
});

test('project finance binds contiguous query parameters for legacy property reads', async () => {
  const controller = await readFile(new URL('../src/controllers/propertyLifecycle.controller.js', import.meta.url), 'utf8');

  assert.match(controller, /const projectParams = \[siteId, projectId, phaseId\];/);
  assert.match(controller, /const projectScope = `p\.site_id=\$1 AND p\.rera_project_id=\$2 AND \(\$3::bigint IS NULL OR p\.rera_project_phase_id=\$3\)`/);
  assert.match(controller, /const organizationProjectParams = \[siteId, req\.user\.organization_id, projectId, phaseId\];/);
  assert.match(controller, /WHERE \$\{projectScope\}`, projectParams\)/);
  assert.match(controller, /e\.rera_project_id=\$2 AND \(\$3::bigint IS NULL OR e\.rera_project_phase_id=\$3\).*projectParams/);
});

test('Phase 2 frontend keeps existing modules reachable and uses contextual drawers', async () => {
  const app = await readFile(new URL('../../Frontend/src/App.jsx', import.meta.url), 'utf8');
  const workspace = await readFile(new URL('../../Frontend/src/pages/CustomerInventory.jsx', import.meta.url), 'utf8');
  const finance = await readFile(new URL('../../Frontend/src/pages/ProjectFinance.jsx', import.meta.url), 'utf8');
  assert.match(app, /path="\/plot-payments"/);
  assert.match(app, /path="\/plot-registry"/);
  assert.match(app, /path="\/customer-inventory"/);
  assert.match(app, /path="\/project-finance"/);
  assert.match(workspace, /LifecycleRequestPanel/);
  assert.match(workspace, /VoucherUpload/);
  assert.match(workspace, /CustomerPropertyLifecycle/);
  assert.match(finance, /original accounting row remains authoritative/);
});

test('sidebar page failures do not clear a valid browser session', async () => {
  const api = await readFile(new URL('../../Frontend/src/api/api.js', import.meta.url), 'utf8');
  const sidebar = await readFile(new URL('../../Frontend/src/components/sidebar/SidebarItem.jsx', import.meta.url), 'utf8');
  assert.match(api, /error\.response\?\.status === 401/);
  assert.match(api, /\[400, 401, 403\]\.includes\(refreshStatus\)/);
  assert.match(api, /temporarily unavailable\. Your session has been kept/);
  assert.match(api, /error\.response\?\.status === 403[\s\S]*toast\.error/);
  assert.doesNotMatch(sidebar, /logout\(|removeItem\(|window\.location/);
});
