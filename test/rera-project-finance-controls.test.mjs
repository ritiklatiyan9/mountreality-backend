import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../src/migrations/120_rera_project_finance_controls.js', import.meta.url), 'utf8');
const accountHardening = await readFile(new URL('../src/migrations/121_rera_designated_account_hardening.js', import.meta.url), 'utf8');
const financeHardening = await readFile(new URL('../src/migrations/122_rera_project_finance_hardening.js', import.meta.url), 'utf8');
const controller = await readFile(new URL('../src/controllers/reraProjectFinance.controller.js', import.meta.url), 'utf8');
const lifecycleController = await readFile(new URL('../src/controllers/propertyLifecycle.controller.js', import.meta.url), 'utf8');
const routes = await readFile(new URL('../src/routes/propertyLifecycle.routes.js', import.meta.url), 'utf8');
const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8');

test('RERA finance controls extend, rather than duplicate, the canonical ledgers', () => {
  assert.match(migration, /plot_payments and\s+\/?\/?\s*firm_transactions remain the canonical/i);
  assert.match(migration, /REFERENCES plot_payments\(id\)/);
  assert.match(migration, /REFERENCES firm_transactions\(id\)/);
  assert.doesNotMatch(migration, /CREATE TABLE(?: IF NOT EXISTS)?\s+rera_(?:payments|bank_transactions|ledger_entries)/i);
});

test('deposit evidence is tenant-scoped, idempotent and indexed for project dashboards', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS rera_collection_deposit_allocations/);
  assert.match(migration, /fk_rera_deposit_site FOREIGN KEY \(organization_id,site_id\)/);
  assert.match(migration, /uq_rera_deposit_idempotency/);
  assert.match(migration, /idx_rera_deposit_project_status/);
  assert.match(migration, /rera_deposit_review_state_chk/);
  assert.match(controller, /DEPOSIT_EXCEEDS_COLLECTION/);
  assert.match(controller, /DEPOSIT_EXCEEDS_BANK_CREDIT/);
  assert.match(controller, /RERA_COLLECTION_DEPOSIT_AUTO_VERIFIED/);
  assert.match(controller, /evidence_documents: evidenceResult\.rows/);
  assert.match(controller, /organization_id=\$1 AND site_id=\$2 AND uploaded_source='DMS'/);
  assert.match(lifecycleController, /evidence_documents: evidenceDocuments\.rows/);
});

test('withdrawals require the three RERA certificate roles and a reviewed account', () => {
  assert.match(migration, /engineer_document_id INTEGER NOT NULL/);
  assert.match(migration, /architect_document_id INTEGER NOT NULL/);
  assert.match(migration, /ca_document_id INTEGER NOT NULL/);
  assert.match(migration, /rera_withdrawal_distinct_certificates_chk/);
  assert.match(migration, /mapped_status<>'REVIEWED'/);
  assert.match(controller, /WITHDRAWAL_EXCEEDS_CERTIFICATION/);
  assert.match(controller, /WITHDRAWAL_EXCEEDS_VERIFIED_RESERVE/);
  assert.match(controller, /Approve the certified withdrawal before posting it/);
  assert.match(
    controller,
    /verified - posted - approvedNotPosted - pendingWithdrawals/,
    'the dashboard must not advertise funds already reserved by pending requests',
  );
});

test('RERA applicability and the central 70 percent baseline come from the published operating profile', () => {
  assert.match(controller, /RERA_PROJECT_PROMOTER/);
  assert.match(controller, /RERA_ONGOING_PROJECT_REGULARISATION/);
  assert.match(controller, /lifecycle_status='PUBLISHED'/);
  assert.match(controller, /configured >= 70 && configured <= 100/);
  assert.match(controller, /percentage: 70, source: 'CENTRAL_RERA_BASELINE'/);
  assert.match(controller, /RERA_FINANCE_NOT_APPLICABLE/);
});

test('RERA finance APIs are permissioned through the existing project lifecycle router', () => {
  assert.match(routes, /project-finance\/rera-compliance/);
  assert.match(routes, /project-finance\/rera\/deposits/);
  assert.match(routes, /project-finance\/rera\/withdrawals/);
  assert.match(routes, /requirePermission\('plot_payments', 'read'\)/);
  assert.match(routes, /requirePermission\('plot_payments', 'update'\)/);
});

test('canonical bank evidence is approved, non-cash and unbounced in the API and database', () => {
  assert.match(controller, /LOWER\(COALESCE\(ft\.status,''\)\)='approved'/);
  assert.match(controller, /ledger_bucket\(ft\.payment_mode\)<>'cash'/);
  assert.match(controller, /UPPER\(COALESCE\(ft\.cheque_status,''\)\) NOT IN \('BOUNCED','RETURNED'\)/);
  assert.match(financeHardening, /CREATE OR REPLACE FUNCTION rera_bank_entry_is_eligible/);
  assert.match(financeHardening, /Reject linked RERA finance controls before changing this bank-entry evidence/);
  assert.match(financeHardening, /trg_protect_rera_firm_transaction_update/);
  assert.match(financeHardening, /trg_protect_rera_plot_payment_update/);
  assert.match(financeHardening, /trg_protect_rera_plot_payment_insert/);
});

test('phased projects reject project-wide controls and overlapping legacy reserve is counted', () => {
  assert.match(controller, /EXISTS \([\s\S]*FROM rera_project_phases project_phase[\s\S]*\) AS has_phases/);
  assert.equal((controller.match(/projectPhaseRequired\(project, (?:requestedPhaseId|phaseId)\)/g) || []).length, 2);
  assert.match(controller, /RERA_PROJECT_PHASE_REQUIRED/);
  assert.match(controller, /rera_project_phase_id IS NULL OR rera_project_phase_id=\$4/);
  assert.match(financeHardening, /project_has_phases AND NEW\.rera_project_phase_id IS NULL/);
  assert.match(financeHardening, /OR rera_project_phase_id IS NULL\s+OR rera_project_phase_id=NEW\.rera_project_phase_id/);
});

test('mapping validity follows the control effective date and reviewed evidence stays immutable', () => {
  assert.match(controller, /pam\.effective_from<=\$6::date/);
  assert.match(controller, /pam\.effective_to>=\$6::date/);
  assert.match(financeHardening, /control_date<mapped_effective_from/);
  assert.match(financeHardening, /control_date>mapped_effective_to/);
  assert.match(financeHardening, /trg_protect_reviewed_rera_mapping_identity/);
  assert.match(financeHardening, /trg_protect_rera_evidence_document_delete/);
  assert.match(financeHardening, /NEW\.bank_name IS NOT DISTINCT FROM OLD\.bank_name/);
  assert.match(accountHardening, /validate_reviewed_rera_designated_account/);
});

test('idempotent creates fingerprint the request and safely resolve concurrent inserts', () => {
  assert.match(financeHardening, /ADD COLUMN IF NOT EXISTS request_fingerprint CHAR\(64\)/);
  assert.match(controller, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(controller, /reraFinanceRequestFingerprint\('RERA_DEPOSIT'/);
  assert.match(controller, /reraFinanceRequestFingerprint\('RERA_WITHDRAWAL'/);
  assert.equal((controller.match(/ON CONFLICT \(organization_id,site_id,idempotency_key\)/g) || []).length, 2);
  assert.equal((controller.match(/findIdempotentReplay\(db/g) || []).length, 5);
  assert.match(financeHardening, /trg_protect_rera_deposit_lifecycle/);
  assert.match(financeHardening, /trg_protect_rera_withdrawal_lifecycle/);
});

test('compliance GET supplies complete readable choices rather than deriving from truncated history', () => {
  assert.match(controller, /eligible_collections: eligibleCollectionResult\.rows/);
  assert.match(controller, /remaining_for_deposit/);
  assert.match(controller, /eligible_bank_credits: eligibleCreditResult\.rows/);
  assert.match(controller, /eligible_bank_debits: eligibleDebitResult\.rows/);
  assert.match(controller, /remaining_credit/);
  assert.match(controller, /remaining_debit/);
  assert.match(controller, /ORDER BY ft\.date DESC,ft\.id DESC LIMIT 200/);
  assert.match(financeHardening, /idx_firm_transactions_rera_choices/);
});

test('migration 122 is ordered after the finance-control and account-evidence migrations', () => {
  const controls = packageJson.indexOf('npm run migrate:rera-project-finance-controls');
  const evidence = packageJson.indexOf('npm run migrate:rera-designated-account-hardening');
  const hardening = packageJson.indexOf('npm run migrate:rera-project-finance-hardening');
  assert.ok(controls >= 0 && controls < evidence && evidence < hardening);
  assert.match(packageJson, /"migrate:rera-project-finance-hardening":\s*"node src\/migrations\/122_rera_project_finance_hardening\.js"/);
});
