import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CERTIFICATION_TRANSITIONS,
  FILING_TRANSITIONS,
  assertTransition,
  calculateCostPosition,
  deriveOperationalProgress,
  evaluateFilingReadiness,
} from '../src/services/constructionPhase3.service.js';

test('operational weighted progress uses configured weights and never invents missing inputs', () => {
  const result = deriveOperationalProgress({
    method: 'TASK_WEIGHTED',
    items: [
      { id: 1, weight: 40, progress_pct: 100 },
      { id: 2, weight: 60, progress_pct: 50 },
    ],
  });
  assert.equal(result.progress, 70);
  assert.deepEqual(result.blockers, []);

  const incomplete = deriveOperationalProgress({
    method: 'TASK_WEIGHTED',
    items: [{ id: 1, progress_pct: 90 }],
  });
  assert.equal(incomplete.progress, null);
  assert.match(incomplete.blockers[0], /Missing weights/);
});

test('quantity progress is deterministic and capped at 100 percent', () => {
  const result = deriveOperationalProgress({
    method: 'QUANTITY_WEIGHTED',
    items: [
      { id: 7, weight: 25, planned_quantity: 100, completed_quantity: 120 },
      { id: 8, weight: 75, planned_quantity: 300, completed_quantity: 150 },
    ],
  });
  assert.equal(result.progress, 62.5);
});

test('cost position keeps budget, commitment, paid, consumed and allocated actual distinct', () => {
  assert.deepEqual(calculateCostPosition({
    budget: 20_000_000,
    committed: 15_000_000,
    paid: 9_000_000,
    materialConsumed: 6_000_000,
    allocatedActual: 5_000_000,
    estimatedAdditionalCost: 10_500_000,
  }), {
    approvedBudget: 20_000_000,
    committedCost: 15_000_000,
    paidCost: 9_000_000,
    materialConsumedCost: 6_000_000,
    financeAllocatedActual: 5_000_000,
    actualCost: 11_000_000,
    costToComplete: 10_500_000,
    estimateAtCompletion: 21_500_000,
    budgetVariance: -1_500_000,
    outstandingCommitment: 6_000_000,
  });
});

test('certification and filing workflows fail closed on invalid jumps', () => {
  assert.equal(assertTransition(CERTIFICATION_TRANSITIONS, 'INTERNAL_REVIEW', 'CERTIFIED'), 'CERTIFIED');
  assert.equal(assertTransition(FILING_TRANSITIONS, 'READY', 'SUBMITTED'), 'SUBMITTED');
  assert.throws(
    () => assertTransition(CERTIFICATION_TRANSITIONS, 'DRAFT', 'APPROVED'),
    (error) => error.code === 'INVALID_TRANSITION',
  );
  assert.throws(
    () => assertTransition(FILING_TRANSITIONS, 'DRAFT', 'SUBMITTED'),
    (error) => error.code === 'INVALID_TRANSITION',
  );
});

test('filing readiness blocks unreviewed rules, unresolved requirements and reconciliation errors', () => {
  const blocked = evaluateFilingReadiness({
    ruleset: { source_review_status: 'PENDING', contains_legal_requirements: true },
    requirements: [{ id: 4, requirement_code: 'QPR-EVIDENCE', title: 'Evidence', is_blocking: true, status: 'MISSING', source_review_status: 'PENDING' }],
    reconciliation: [{ check_code: 'COLLECTIONS', status: 'ERROR', reason: 'Receipt mismatch' }],
  });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockingIssueCount >= 3);

  const ready = evaluateFilingReadiness({
    ruleset: { source_review_status: 'REVIEWED', contains_legal_requirements: true },
    requirements: [{ id: 4, is_blocking: true, status: 'COMPLETE', source_review_status: 'REVIEWED' }],
    reconciliation: [{ check_code: 'COLLECTIONS', status: 'PASS', reason: 'Matched' }],
  });
  assert.equal(ready.ready, true);
});

test('Phase 3 migration extends canonical domains and protects immutable snapshots', async () => {
  const migration = await readFile(new URL('../src/migrations/098_construction_certification_filing.js', import.meta.url), 'utf8');
  assert.match(migration, /ALTER TABLE construction_projects/);
  assert.match(migration, /ALTER TABLE construction_tasks/);
  assert.match(migration, /ALTER TABLE inventory_movements/);
  assert.match(migration, /ALTER TABLE project_transaction_allocations/);
  assert.match(migration, /construction_work_package_commitments/);
  assert.match(migration, /protect_final_construction_certification/);
  assert.match(migration, /protect_rera_filing_snapshot/);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS rera_expenses/i);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS rera_documents/i);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS rera_construction_projects/i);
});

test('server routes enforce entity-derived Site access before RBAC', async () => {
  const routes = await readFile(new URL('../src/routes/construction.routes.js', import.meta.url), 'utf8');
  assert.match(routes, /accessByCertification, requirePermission\('rera_evidence', 'update'\)/);
  assert.match(routes, /accessByFiling, requirePermission\('rera_projects', 'update'\)/);
  assert.match(routes, /accessByPackage, requirePermission\('construction', 'update'\)/);
});

test('certification remains distinct from operational progress and filing snapshots retain source IDs', async () => {
  const controller = await readFile(new URL('../src/controllers/constructionPhase3.controller.js', import.meta.url), 'utf8');
  assert.match(controller, /operational_progress_snapshot/);
  assert.match(controller, /proposed_certified_progress_pct/);
  assert.match(controller, /certified_progress_pct/);
  assert.match(controller, /source_record_references/);
  assert.match(controller, /reconciliationRunKey/);
  assert.match(controller, /SEGREGATION_OF_DUTIES/);
  assert.match(controller, /READY snapshot is required/);
});
