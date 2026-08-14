import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = async (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('all compliance API routes are behind authentication and role middleware', async () => {
  const [routes, documentRoutes] = await Promise.all([
    source('src/routes/compliance.routes.js'),
    source('src/routes/complianceDocument.routes.js'),
  ]);
  assert.match(routes, /router\.use\(authMiddleware,\s*requireRole\('admin',\s*'sub_admin'\)\)/);
  assert.match(documentRoutes, /router\.use\(authMiddleware,\s*requireRole\('admin',\s*'sub_admin'\)\)/);
  assert.match(routes, /requirePermission\('legal',\s*'read'\)/);
  assert.match(routes, /requirePermission\('compliance_settings',\s*'update'\)/);
});

test('entity access contract enforces organisation and assigned-site boundaries', async () => {
  const access = await source('src/utils/complianceAccess.js');
  assert.match(access, /organization_id\s*=\s*\$2/);
  assert.match(access, /user_sites/);
  assert.match(access, /Access denied to this site/);
});

test('private document access performs tenant lookup, entity authorization and download audit', async () => {
  const documents = await source('src/controllers/complianceDocument.controller.js');
  assert.match(documents, /organization_id=\$2 AND deleted_at IS NULL/);
  assert.match(documents, /requireEntity\(req,\s*res,\s*document\.entity_type,\s*document\.entity_id\)/);
  assert.match(documents, /DOCUMENT_DOWNLOAD/);
  assert.match(documents, /confidentiality === 'RESTRICTED'/);
});

test('migration contains tenant keys, scheduler dedupe and finance-reference uniqueness', async () => {
  const migration = await source('src/migrations/088_compliance_legal_control_centre.js');
  const tenantReferences = migration.match(/organization_id INTEGER NOT NULL REFERENCES organizations\(id\)/g) || [];
  assert.ok(tenantReferences.length >= 12);
  assert.match(migration, /UNIQUE \(organization_id, entity_type, entity_id, recipient_user_id, channel, notification_type, scheduled_for\)/);
  assert.match(migration, /UNIQUE \(organization_id, compliance_item_id, expense_id\)/);
  assert.match(migration, /process\.argv\.includes\('--down'\)/);
});

test('new sensitive modules seed fail closed for existing sub-admins', async () => {
  const [permissions, middleware] = await Promise.all([
    source('src/models/Permission.model.js'),
    source('src/middlewares/permission.middleware.js'),
  ]);
  for (const module of ['compliance', 'legal', 'compliance_templates', 'compliance_settings']) {
    assert.match(permissions, new RegExp(`['"]${module}['"]`));
  }
  assert.match(permissions, /RESTRICTED_MODULES\.has\(module\)/);
  assert.match(middleware, /permission\[fieldName\] !== true/);
});

test('major workflow and report contracts are present', async () => {
  const [routes, controller] = await Promise.all([
    source('src/routes/compliance.routes.js'),
    source('src/controllers/compliance.controller.js'),
  ]);
  for (const route of [
    '/items/:id/status', '/items/:id/reschedule', '/items/:id/checklist',
    '/templates/:id/apply', '/legal-cases/:id/timeline', '/notices/:id/status',
    '/due-date-changes/:changeId/review', '/legal-approvals/:approvalId/review',
  ]) {
    assert.ok(routes.includes(route), `missing workflow route ${route}`);
  }
  for (const reportType of [
    'COMPLIANCE_SUMMARY', 'UPCOMING_DUE', 'OVERDUE_COMPLIANCE', 'COMPLIANCE_COMPLETION',
    'APPROVAL_EXPIRY', 'LICENCE_RENEWAL', 'COMPLIANCE_BY_PROJECT',
    'COMPLIANCE_BY_AUTHORITY', 'COMPLIANCE_BY_RESPONSIBLE_USER', 'COMPLIANCE_RISK',
    'LEGAL_CASE_SUMMARY', 'HEARING_CALENDAR', 'NOTICE_REPLY', 'LEGAL_FINANCIAL_EXPOSURE',
    'DOCUMENT_EXPIRY', 'INSPECTION_CORRECTIVE_ACTION', 'COMPLIANCE_AUDIT_TRAIL', 'PENALTY_FEE',
  ]) {
    assert.ok(controller.includes(reportType), `missing report ${reportType}`);
  }
  assert.match(controller, /a\.entity_type='LEGAL_NOTICE' AND a\.action_type='LEGAL_REPLY'/);
  assert.match(controller, /a\.entity_type='COMPLIANCE' AND a\.compliance_item_id IS NOT NULL/);
});

test('scheduler uses duplicate-safe generation, locking, queue claims and bounded retries', async () => {
  const scheduler = await source('src/services/complianceScheduler.service.js');
  assert.match(scheduler, /pg_advisory_xact_lock/);
  assert.match(scheduler, /ON CONFLICT \(organization_id,generated_key\)[\s\S]*DO NOTHING/);
  assert.match(scheduler, /FOR UPDATE SKIP LOCKED/);
  assert.match(scheduler, /status='PROCESSING'/);
  assert.match(scheduler, /attempt_count < 3/);
  assert.match(scheduler, /active_recipient_id/);
});

test('combined views do not expose legal records without legal read permission', async () => {
  const [controller, documents] = await Promise.all([
    source('src/controllers/compliance.controller.js'),
    source('src/controllers/complianceDocument.controller.js'),
  ]);
  assert.match(controller, /hasModuleRead\(req, 'legal'\)/);
  assert.match(controller, /entity_type NOT IN \('LEGAL_CASE','LEGAL_NOTICE'\)/);
  assert.match(documents, /legalPermission\?\.can_read !== true/);
});

test('global compliance notifications are recipient-scoped and track unread state', async () => {
  const [routes, controller, migration] = await Promise.all([
    source('src/routes/compliance.routes.js'),
    source('src/controllers/compliance.controller.js'),
    source('src/migrations/089_compliance_notification_centre.js'),
  ]);
  assert.match(routes, /notifications\/:notificationId\/read/);
  assert.match(routes, /notifications\/read-all/);
  assert.match(routes, /legal-notifications/);
  assert.match(controller, /n\.recipient_user_id=\$2/);
  assert.match(controller, /n\.channel='DASHBOARD'/);
  assert.match(controller, /read_at IS NULL/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ/);
  assert.match(migration, /idx_compliance_notifications_recipient_unread/);
});

test('compliance categories are tenant-managed, permission-gated and seeded without state assumptions', async () => {
  const [routes, controller, migration] = await Promise.all([
    source('src/routes/compliance.routes.js'),
    source('src/controllers/compliance.controller.js'),
    source('src/migrations/115_compliance_categories.js'),
  ]);
  assert.match(routes, /router\.get\('\/categories', requirePermission\('compliance', 'read'\)/);
  assert.match(routes, /router\.post\('\/categories', requirePermission\('compliance_settings', 'write'\)/);
  assert.match(routes, /router\.patch\('\/categories\/:id', requirePermission\('compliance_settings', 'update'\)/);
  assert.match(controller, /WHERE c\.organization_id=\$1 AND c\.deleted_at IS NULL/);
  assert.match(controller, /UPDATE compliance_items SET category=\$1/);
  assert.match(controller, /UPDATE compliance_templates SET category=\$1/);
  assert.match(migration, /AFTER INSERT ON organizations/);
  assert.match(migration, /RERA_REAL_ESTATE/);
  assert.doesNotMatch(migration, /HARYANA|HRERA/i);
});
