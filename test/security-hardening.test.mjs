import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const backend = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const frontend = (path) => readFile(new URL(`../../Frontend/${path}`, import.meta.url), 'utf8');

test('platform owner bootstrap has no public password or email-based privilege promotion', async () => {
  const migration = await backend('src/migrations/079_saas_multitenancy.js');
  assert.doesNotMatch(migration, /owner@123/);
  assert.doesNotMatch(migration, /UPDATE users SET role = 'owner'/);
  assert.match(migration, /PLATFORM_OWNER_EMAIL/);
  assert.match(migration, /PLATFORM_OWNER_PASSWORD/);
  assert.match(migration, /SET is_active = false,[\s\S]*token_version/);
});

test('login remains usable with a correct password while email mutation fails closed', async () => {
  const auth = await backend('src/controllers/auth.controller.js');
  const login = auth.slice(auth.indexOf('export const login'), auth.indexOf('export const googleStatus'));
  assert.doesNotMatch(login, /return res\.status\(429\)/);
  assert.match(login, /comparePassword\(password, user\?\.password \|\| DUMMY_PASSWORD_HASH\)/);
  assert.match(auth, /EMAIL_CHANGE_REQUIRES_VERIFICATION/);
  assert.doesNotMatch(auth.slice(auth.indexOf('export const updateProfile'), auth.indexOf('export const changePassword')), /updateData\.email/);
});

test('GraphQL always intersects requested Site IDs with organization membership and has request bounds', async () => {
  const [app, schema] = await Promise.all([backend('src/app.js'), backend('src/graphql/schema.js')]);
  assert.match(app, /SELECT id AS site_id FROM sites WHERE organization_id = \$1/);
  assert.match(app, /validationRules: \[boundedGraphQLRule\]/);
  assert.match(app, /graphQLRateLimiter/);
  assert.ok(schema.indexOf('if (!ctx.siteIds?.has(siteId))') < schema.indexOf('if (PRIVILEGED_ROLES.has(ctx.user.role))'));
  assert.match(schema, /Math\.min\(100, Math\.max\(1, limit\)\)/);
});

test('file, folder, DMS, document custody and signature paths use tenant scope', async () => {
  const [legacy, excel, folders, dms, dmsMigration, custody, signatures] = await Promise.all([
    backend('src/middlewares/legacyEntitySiteAccess.middleware.js'),
    backend('src/routes/excel.routes.js'),
    backend('src/routes/folder.routes.js'),
    backend('src/controllers/dmsDocument.controller.js'),
    backend('src/migrations/111_dms_tenant_isolation.js'),
    backend('src/controllers/documentImprest.controller.js'),
    backend('src/controllers/signature.controller.js'),
  ]);
  assert.match(legacy, /excel_file:[^\n]+excel_files/);
  assert.match(legacy, /folder:[^\n]+file_folders/);
  assert.match(excel, /fileById/);
  assert.match(folders, /folderById/);
  assert.match(dms, /d\.organization_id = \$1/);
  assert.match(dmsMigration, /idx_documents_dms_org_unassigned/);
  assert.match(custody, /enforceEntitySiteAccess/);
  assert.match(signatures, /enforceEntitySiteAccess/);
});

test('admin activity and dashboard permission operations are organization scoped', async () => {
  const [activity, dashboard] = await Promise.all([
    backend('src/controllers/activity.controller.js'),
    backend('src/controllers/dashboardPermission.controller.js'),
  ]);
  assert.match(activity, /u\.organization_id = \$1/);
  assert.match(activity, /u\.organization_id = \$2/);
  assert.match(dashboard, /organization_id = \$2/);
  assert.match(dashboard, /WHERE u\.organization_id = \$1/);
});

test('approval queues and financial parent IDs require an authorized Site', async () => {
  const [expense, expenseRoutes, firmRoutes, cashRoutes, daybookRoutes] = await Promise.all([
    backend('src/controllers/expense.controller.js'),
    backend('src/routes/expense.routes.js'),
    backend('src/routes/firm.routes.js'),
    backend('src/routes/cashflow.routes.js'),
    backend('src/routes/daybook.routes.js'),
  ]);
  assert.match(expense, /A valid site_id is required/);
  assert.match(expenseRoutes, /requireRequestSiteAccess\(\{ source: 'query', module: 'expense_approval' \}\)/);
  assert.match(firmRoutes, /firmByBody/);
  assert.match(firmRoutes, /transactionFirmBulk/);
  assert.match(cashRoutes, /monthByBody/);
  assert.match(daybookRoutes, /cashflowMonthByBody/);
  for (const route of ['recent', 'profit-summary', 'profit-monthly', 'verify-data']) {
    assert.match(daybookRoutes, new RegExp(`'/${route}'[^\\n]+requirePermission\\('daybook', 'read'\\)`));
  }
});

test('posted payments are immutable and vendor edits cannot self-approve', async () => {
  const [plot, farmer, vendor] = await Promise.all([
    backend('src/controllers/plot.controller.js'),
    backend('src/controllers/farmer.controller.js'),
    backend('src/controllers/vendor.controller.js'),
  ]);
  assert.match(plot, /Posted or allocated payments are immutable/);
  assert.match(plot, /Payment amount must be greater than 0/);
  assert.match(farmer, /Acquisition payments are immutable here/);
  assert.match(vendor, /Posted vendor payments are immutable/);
  assert.match(vendor, /status = 'pending', approved_by = NULL, approved_at = NULL/);
});

test('cash and inventory reductions are serialized and idempotent', async () => {
  const [imprest, construction] = await Promise.all([
    backend('src/models/Imprest.model.js'),
    backend('src/controllers/construction.controller.js'),
  ]);
  assert.match(imprest, /current_balance\.amount \+ \$7 >= 0/);
  assert.match(imprest, /IMPREST_INSUFFICIENT_BALANCE/);
  assert.match(construction, /X-Idempotency-Key/);
  assert.match(construction, /FOR UPDATE/);
  assert.match(construction, /q > stock\.available/);
});

test('expensive upload, OCR and AI routes have dedicated rate limits', async () => {
  const [dms, plot, reports, kyc, limiter] = await Promise.all([
    backend('src/routes/dmsDocument.routes.js'),
    backend('src/routes/plotDocument.routes.js'),
    backend('src/routes/report.routes.js'),
    backend('src/routes/memberKyc.routes.js'),
    backend('src/middlewares/rateLimit.middleware.js'),
  ]);
  assert.match(dms, /dmsUploadLimiter/);
  assert.match(dms, /dmsOcrLimiter/);
  assert.match(plot, /plotDocumentUploadLimiter/);
  assert.match(reports, /aiReportLimiter/);
  assert.match(kyc, /kycProcessingLimiter/);
  assert.match(limiter, /incrementRateLimit/);
});

test('spreadsheet exports neutralize formula-prefixed cells', async () => {
  const securitySource = await frontend('src/lib/spreadsheetSecurity.js');
  assert.match(securitySource, /FORMULA_PREFIX/);
  const { neutralizeSpreadsheetCell, encodeCsvCell } = await import('../../Frontend/src/lib/spreadsheetSecurity.js');
  for (const value of ['=2+2', '+cmd', '-1+1', '@SUM(A1:A2)', '\t=2+2', '\r@cmd']) {
    assert.ok(neutralizeSpreadsheetCell(value).startsWith("'"), value);
    assert.ok(encodeCsvCell(value).includes("'"), value);
  }
  assert.equal(neutralizeSpreadsheetCell('ordinary text'), 'ordinary text');
});
