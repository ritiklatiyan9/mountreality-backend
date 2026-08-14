import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  isReraRegistryOperatingModel,
  isRegistryProjectContextComplete,
  resolveRegistryOperatingPolicy,
} from '../src/services/registryPolicy.service.js';

test('registry policy identifies only explicit published RERA operating models', () => {
  assert.equal(isReraRegistryOperatingModel('RERA_PROJECT_PROMOTER'), true);
  assert.equal(isReraRegistryOperatingModel('rera_ongoing_project_regularisation'), true);
  assert.equal(isReraRegistryOperatingModel('GENERIC_LAND_DEVELOPER'), false);
  assert.equal(isReraRegistryOperatingModel('HARYANA'), false);
  assert.equal(isReraRegistryOperatingModel(null), false);
});

test('registry project context requires a phase only for phase-wise profiles', () => {
  assert.equal(isRegistryProjectContextComplete({
    projectStructure: 'SINGLE_PROJECT',
    projectId: 22,
    phaseId: null,
  }), true);
  assert.equal(isRegistryProjectContextComplete({
    projectStructure: 'PHASE_WISE',
    projectId: 22,
    phaseId: null,
  }), false);
  assert.equal(isRegistryProjectContextComplete({
    projectStructure: 'phase_wise',
    projectId: 22,
    phaseId: 4,
  }), true);
  assert.equal(isRegistryProjectContextComplete({
    projectStructure: 'SINGLE_PROJECT',
    projectId: null,
    phaseId: null,
  }), false);
});

test('registry operating policy remains legacy-compatible without a published RERA profile', async () => {
  const fakeDb = {
    async query() {
      return { rows: [{
        organization_id: 7,
        profile_revision_id: null,
        revision_number: null,
        operating_model: null,
      }] };
    },
  };
  const result = await resolveRegistryOperatingPolicy({ siteId: 14, organizationId: 7, db: fakeDb });
  assert.equal(result.rera_enforced, false);
  assert.equal(result.profile_revision_id, null);
});

test('registry operating policy activates from an exact published RERA profile', async () => {
  let queryText = '';
  const fakeDb = {
    async query(sql) {
      queryText = sql;
      return { rows: [{
        organization_id: 7,
        profile_revision_id: 91,
        revision_number: 3,
        operating_model: 'RERA_PROJECT_PROMOTER',
        project_structure: 'SINGLE_PROJECT',
      }] };
    },
  };
  const result = await resolveRegistryOperatingPolicy({ siteId: 14, organizationId: 7, db: fakeDb });
  assert.equal(result.rera_enforced, true);
  assert.equal(result.profile_revision_id, 91);
  assert.equal(result.project_structure, 'SINGLE_PROJECT');
  assert.match(queryText, /lifecycle_status='PUBLISHED'/);
  assert.match(queryText, /effective_to IS NULL/);
  assert.match(queryText, /deleted_at IS NULL/);
});

test('RERA registry APIs allow staged preparation but accept only canonical receipt mappings', async () => {
  const controller = await readFile(new URL('../src/controllers/registry.controller.js', import.meta.url), 'utf8');
  const model = await readFile(new URL('../src/models/PlotRegistry.model.js', import.meta.url), 'utf8');

  assert.match(controller, /RERA_CANONICAL_RECEIPT_REQUIRED/);
  assert.match(controller, /operatingPolicy\.rera_enforced && manualRows\.length/);
  assert.match(controller, /!operatingPolicy\.rera_enforced\s*&& \(linkable\.length \+ manualRows\.length === 0/);
  assert.doesNotMatch(controller, /operatingPolicy\.rera_enforced && linkable\.length === 0/);
  assert.match(controller, /!operatingPolicy\.rera_enforced && !workflowUnlocked && (?:approveDue|due) > 0\.005/);
  assert.doesNotMatch(controller, /\(!workflowUnlocked \|\| operatingPolicy\.rera_enforced\)/);
  assert.match(controller, /operatingPolicy\.rera_enforced && Array\.isArray\(inline_payments\)/);
  assert.match(controller, /prp\.source_plot_payment_id IS NOT NULL/);
  assert.match(controller, /pp\.booking_id=\$6/);
  assert.match(model, /rera_registry_controls/);
  assert.match(model, /usable_for_registry/);
  assert.match(model, /active_profile\.operating_model NOT IN/);
  assert.match(model, /pp\.booking_id=pr\.booking_id/);
});

test('canonical registry receipt reads consistently exclude reversals and reversed originals', async () => {
  const controller = await readFile(new URL('../src/controllers/registry.controller.js', import.meta.url), 'utf8');
  const lifecycle = await readFile(new URL('../src/controllers/propertyLifecycle.controller.js', import.meta.url), 'utf8');
  const model = await readFile(new URL('../src/models/PlotRegistry.model.js', import.meta.url), 'utf8');

  for (const source of [controller, lifecycle, model]) {
    assert.match(source, /reversal_of_payment_id IS NULL/);
    assert.match(source, /reversal\.reversal_of_payment_id=(?:pp|receipt)\.id/);
    assert.match(source, /LOWER\(COALESCE\(reversal\.status,'approved'\)\)='approved'/);
    assert.match(source, /UPPER\(COALESCE\(reversal\.cheque_status,''\)\) NOT IN \('BOUNCED','RETURNED'\)/);
  }
});

test('RERA registry money is server-derived and manual amount overrides stay generic-only', async () => {
  const controller = await readFile(new URL('../src/controllers/registry.controller.js', import.meta.url), 'utf8');

  assert.match(controller, /syncReraRegistryAmounts/);
  assert.match(controller, /SET registry_payment=totals\.total_amount/);
  assert.match(controller, /bank_amount=totals\.bank_amount/);
  assert.match(controller, /ledger_bucket\(pp\.payment_type\)<>'cash'/);
  assert.match(controller, /!operatingPolicy\.rera_enforced && bank_amount !== undefined/);
  assert.match(controller, /!operatingPolicy\.rera_enforced && registry_payment !== undefined/);
  assert.match(controller, /monetary_fields_derived: operatingPolicy\.rera_enforced/);
});

test('RERA registry execution exposes an explainable mandatory readiness checklist', async () => {
  const controller = await readFile(new URL('../src/controllers/propertyLifecycle.controller.js', import.meta.url), 'utf8');

  assert.match(controller, /RERA_REGISTRY_EXECUTION_NOT_READY/);
  assert.match(controller, /canonical_receipt_count/);
  assert.match(controller, /agreement_registered/);
  assert.match(controller, /controlled_registry_documents/);
  assert.match(controller, /professional_registration_metadata/);
  assert.match(controller, /source: 'RERA_OPERATING_PROFILE'/);
  assert.match(controller, /readiness\.execution_ready !== true/);
  assert.match(controller, /isRegistryProjectContextComplete/);
});

test('migration adds optimized metadata, canonical receipt and deed-retention invariants', async () => {
  const migration = await readFile(new URL('../src/migrations/119_rera_registry_controls.js', import.meta.url), 'utf8');

  for (const column of [
    'deed_number',
    'registration_number',
    'sub_registrar_office',
    'deed_execution_date',
    'registration_date',
    'stamp_duty_amount',
    'registration_fee_amount',
  ]) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(migration, /idx_plot_registry_execution_readiness/);
  assert.match(migration, /idx_registry_payment_canonical_lookup/);
  assert.match(migration, /idx_documents_controlled_registry_deed/);
  assert.match(migration, /enforce_rera_registry_canonical_payment/);
  assert.match(migration, /enforce_rera_registry_execution_readiness/);
  assert.match(migration, /protect_executed_rera_registry_deed/);
  assert.match(migration, /executed_rera_registry_deed_retention/);
  assert.match(migration, /v_project_structure='PHASE_WISE'/);
  assert.match(migration, /receipt\.booking_id=NEW\.booking_id/);
});

test('migration 123 protects reversal-safe receipts, derived amounts and executed legal records', async () => {
  const migration = await readFile(new URL('../src/migrations/123_rera_registry_legal_integrity.js', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.match(migration, /123_rera_registry_legal_integrity_v1/);
  assert.match(migration, /idx_plot_payment_active_reversal_lookup/);
  assert.match(migration, /idx_plot_registries_agreement_execution_guard/);
  assert.match(migration, /rera_registry_source_receipt_is_eligible/);
  assert.match(migration, /receipt\.reversal_of_payment_id IS NULL/);
  assert.match(migration, /reversal\.reversal_of_payment_id=receipt\.id/);
  assert.match(migration, /refresh_rera_registry_derived_amounts/);
  assert.match(migration, /derive_rera_registry_monetary_fields/);
  assert.match(migration, /ledger_bucket\(receipt\.payment_type\)<>'cash'/);
  assert.match(migration, /executed_rera_registry_canonical_receipt_retention/);
  assert.match(migration, /executed_rera_registry_legal_metadata_immutable/);
  assert.match(migration, /executed_rera_registry_agreement_immutable/);
  assert.match(migration, /v_project_structure='PHASE_WISE'/);
  assert.doesNotMatch(migration, /full_collection.*RAISE EXCEPTION/is);
  assert.equal(
    packageJson.scripts['migrate:rera-registry-legal-integrity'],
    'node src/migrations/123_rera_registry_legal_integrity.js',
  );
  assert.match(
    packageJson.scripts['start:with-migrations'],
    /migrate:rera-project-finance-hardening && npm run migrate:rera-registry-legal-integrity/,
  );
});

test('executed registry receipt deletion and agreement downgrade map to controlled 409s', async () => {
  const registry = await readFile(new URL('../src/controllers/registry.controller.js', import.meta.url), 'utf8');
  const lifecycle = await readFile(new URL('../src/controllers/propertyLifecycle.controller.js', import.meta.url), 'utf8');

  assert.match(registry, /RERA_EXECUTED_RECEIPT_RETENTION/);
  assert.match(registry, /executed_rera_registry_canonical_receipt_retention/);
  assert.match(registry, /RERA_EXECUTED_REGISTRY_IMMUTABLE/);
  assert.match(lifecycle, /RERA_EXECUTED_AGREEMENT_IMMUTABLE/);
  assert.match(lifecycle, /executed_rera_registry_agreement_immutable/);
});

test('migration 124 freezes an executed RERA lifecycle while allowing completion', async () => {
  const migration = await readFile(new URL('../src/migrations/124_rera_registry_lifecycle_retention.js', import.meta.url), 'utf8');
  const lifecycle = await readFile(new URL('../src/controllers/propertyLifecycle.controller.js', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.match(migration, /124_rera_registry_lifecycle_retention_v1/);
  assert.match(migration, /protect_executed_rera_registry_lifecycle/);
  assert.match(migration, /OLD\.lifecycle_status='EXECUTED' AND NEW\.lifecycle_status='COMPLETE'/);
  assert.match(migration, /executed_rera_registry_lifecycle_immutable/);
  assert.match(migration, /BEFORE UPDATE OF lifecycle_status ON plot_registries/);
  assert.match(lifecycle, /RERA_EXECUTED_REGISTRY_IMMUTABLE/);
  assert.equal(
    packageJson.scripts['migrate:rera-registry-lifecycle-retention'],
    'node src/migrations/124_rera_registry_lifecycle_retention.js',
  );
  assert.match(
    packageJson.scripts['start:with-migrations'],
    /migrate:rera-registry-legal-integrity && npm run migrate:rera-registry-lifecycle-retention/,
  );
});

test('controlled deed deletion maps only the retention invariant to a professional 409', async () => {
  const controller = await readFile(new URL('../src/controllers/registryDocument.controller.js', import.meta.url), 'utf8');
  assert.match(controller, /error\.constraint === 'executed_rera_registry_deed_retention'/);
  assert.match(controller, /RERA_EXECUTED_DEED_RETENTION/);
  assert.match(controller, /throw error/);
});
