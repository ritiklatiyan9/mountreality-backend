import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { ALL_MODULES } from '../src/models/Permission.model.js';
import {
  invalidateSitePolicy,
  resolveSitePolicy,
} from '../src/services/sitePolicy.service.js';

const backendSource = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const frontendSource = (file) => readFile(new URL(`../../Frontend/${file}`, import.meta.url), 'utf8');

const CANONICAL_RERA_MODULES = [
  'operating_profile',
  'rera_projects',
  'rera_approvals',
  'rera_evidence',
  'rera_rulesets',
];

test('effective-policy SQL scopes every read by organization, Site and published revision', async () => {
  const service = await backendSource('src/services/sitePolicy.service.js');

  assert.match(service, /spr\.organization_id=\$1/);
  assert.match(service, /spr\.site_id=s\.id/);
  assert.match(service, /spr\.lifecycle_status='PUBLISHED'/);
  assert.match(service, /spr\.effective_to IS NULL/);
  assert.match(service, /spr\.deleted_at IS NULL/);
  assert.match(service, /s\.id=\$2 AND s\.organization_id=\$1/);
  assert.match(service, /p\.id=\$3[\s\S]*p\.organization_id=\$1[\s\S]*p\.site_id=\$2/);
  assert.match(service, /ruleset\.organization_id IS NULL OR ruleset\.organization_id=\$1/);
  assert.match(service, /ruleset\.organization_id IS NULL OR ruleset\.organization_id=p\.organization_id/);
  assert.doesNotMatch(service, /rv\.organization_id/);
  assert.match(service, /spr\.revision_number/);
});

test('mocked policy resolution validates ownership before cache use and isolates tenants', async () => {
  const organizationId = 812;
  const siteId = 9412;
  let headerQueries = 0;
  let profileQueries = 0;

  const db = {
    query: async (sql, params) => {
      if (sql.includes('FROM sites s')) {
        headerQueries += 1;
        if (params[0] !== organizationId || params[1] !== siteId) return { rows: [] };
        return {
          rows: [{
            site_id: siteId,
            profile_revision_id: 63,
            profile_revision: 5,
            ruleset_version_id: null,
            ruleset_version: null,
          }],
        };
      }
      if (sql.includes('FROM site_operating_profile_revisions p')) {
        profileQueries += 1;
        assert.deepEqual(params, [organizationId, siteId, 63]);
        return {
          rows: [{
            id: 63,
            organization_id: organizationId,
            site_id: siteId,
            revision_number: 5,
            lifecycle_status: 'PUBLISHED',
            effective_to: null,
            deleted_at: null,
            operating_model: 'RERA_PROJECT_PROMOTER',
            project_shape: 'COMMERCIAL',
            development_basis: 'OTHER',
            ruleset_version_id: null,
            resolved_ruleset_version_id: null,
          }],
        };
      }
      throw new Error(`Unexpected SQL in policy test: ${sql.slice(0, 80)}`);
    },
  };

  invalidateSitePolicy(siteId);
  const first = await resolveSitePolicy({ organizationId, siteId, db });
  const cached = await resolveSitePolicy({ organizationId, siteId, db });
  assert.equal(first.site_id, siteId);
  assert.equal(first.policy_revision, 5);
  assert.equal(cached.mode, 'PROFILE');
  assert.equal(headerQueries, 2, 'ownership/revision header must run before each cache lookup');
  assert.equal(profileQueries, 1, 'unchanged effective profile should use the bounded cache');

  await assert.rejects(
    resolveSitePolicy({ organizationId: organizationId + 1, siteId, db }),
    (error) => error?.statusCode === 404,
  );
  assert.equal(headerQueries, 3);
  assert.equal(profileQueries, 1);
  assert.equal(invalidateSitePolicy(siteId), 1);
});

test('RERA schema uses composite tenant relationships and immutable revision history', async () => {
  const migration = await backendSource('src/migrations/094_rera_phase1_foundation.js');

  assert.match(migration, /revision_number INTEGER NOT NULL CHECK \(revision_number > 0\)/);
  assert.match(migration, /UNIQUE \(organization_id, site_id, revision_number\)/);
  assert.match(migration, /FOREIGN KEY \(organization_id, site_id\)[\s\S]*REFERENCES sites \(organization_id, id\) ON DELETE RESTRICT/);
  assert.match(migration, /UNIQUE \(organization_id, site_id, id\)/);
  assert.match(migration, /REFERENCES rera_projects \(organization_id, site_id, id\) ON DELETE RESTRICT/);
  assert.match(migration, /REFERENCES rera_project_phases \(organization_id, site_id, rera_project_id, id\)/);
  assert.match(migration, /enforce_rera_project_profile_ruleset/);
  assert.match(migration, /profile_ruleset_version_id IS DISTINCT FROM NEW\.ruleset_version_id/);
  assert.match(migration, /WHERE lifecycle_status = 'PUBLISHED' AND deleted_at IS NULL/);
  assert.match(migration, /Existing sites are intentionally not backfilled/);
  assert.doesNotMatch(migration, /INSERT INTO site_operating_profile_revisions[\s\S]{0,800}FROM sites/i);
  assert.match(migration, /forward-only; --down made no database changes/i);
  for (const table of [
    'compliance_approvals', 'compliance_documents',
    'compliance_notification_log', 'compliance_audit_log',
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ALTER COLUMN entity_id TYPE BIGINT`));
  }
});

test('RERA permissions are canonical and seed fail closed for existing sub-admins', async () => {
  const [permissionModel, permissionMiddleware] = await Promise.all([
    backendSource('src/models/Permission.model.js'),
    backendSource('src/middlewares/permission.middleware.js'),
  ]);

  for (const module of CANONICAL_RERA_MODULES) {
    assert.ok(ALL_MODULES.includes(module), `missing permission identity ${module}`);
    assert.match(permissionModel, new RegExp(`['"]${module}['"]`));
  }
  for (const nonCanonical of ['rera_control_centre', 'rera_stakeholders', 'rera_land']) {
    assert.equal(ALL_MODULES.includes(nonCanonical), false, nonCanonical);
  }
  assert.match(permissionModel, /RESTRICTED_MODULES\.has\(module\)/);
  assert.match(permissionMiddleware, /permission\[fieldName\] !== true/);
});

test('visible navigation is the intersection of user permission and selected-Site policy', async () => {
  const [auth, navigation, launcher, protectedRoute] = await Promise.all([
    frontendSource('src/context/AuthContext.jsx'),
    frontendSource('src/components/sidebar/navConfig.js'),
    frontendSource('src/lib/launcherModules.js'),
    frontendSource('src/components/ProtectedRoute.jsx'),
  ]);

  assert.match(auth, /Permission helper: user grant AND selected Site policy must both allow it/);
  assert.match(auth, /siteAuthorization\.mode === SITE_POLICY_MODES\.PROFILE/);
  assert.match(auth, /siteAuthorization\.modules\[module\] === true/);
  assert.match(auth, /if \(!siteAllows\) return false/);
  assert.match(auth, /perm\[`can_\$\{action\}`\] === true/);
  assert.match(navigation, /const can = \(module\) => hasPermission\(module, 'read'\)/);
  assert.match(navigation, /visible: can\('rera_projects'\)/);
  assert.match(launcher, /app\.perm && !hasPermission\(app\.perm, 'read'\)/);
  assert.match(protectedRoute, /requiredModule && !hasPermission\(requiredModule, 'read'\)/);
});

test('RERA forms omit hidden and read-only values at the request boundary', async () => {
  const [utils, projects, stakeholders, approvals] = await Promise.all([
    frontendSource('src/components/rera/reraUtils.js'),
    frontendSource('src/components/rera/ReraProjectsPhases.jsx'),
    frontendSource('src/components/rera/ReraStakeholders.jsx'),
    frontendSource('src/components/rera/ReraApprovalsEvidence.jsx'),
  ]);
  assert.match(utils, /policy\.visible !== false && policy\.readOnly !== true/);
  assert.match(projects, /writablePolicyPayload\(projectForm, 'rera_projects'/);
  assert.match(projects, /writablePolicyPayload\(phaseForm, 'rera_phases'/);
  assert.match(stakeholders, /'rera_stakeholders', getFieldPolicy/);
  assert.match(stakeholders, /'rera_participants', getFieldPolicy/);
  assert.match(approvals, /writablePolicyPayload\(approvalForm, 'rera_approvals'/);
  assert.match(approvals, /'rera_evidence'/);
});

test('profile route remains authenticated while mutations require canonical permission grants', async () => {
  const [routes, controller] = await Promise.all([
    backendSource('src/routes/operatingProfile.routes.js'),
    backendSource('src/controllers/operatingProfile.controller.js'),
  ]);

  assert.match(routes, /router\.use\(authMiddleware,\s*requireRole\('admin',\s*'sub_admin'\)\)/);
  assert.match(routes, /router\.get\('\/site-policy',\s*getEffectiveSitePolicy\)/);
  assert.match(routes, /requirePermission\('operating_profile',\s*'read'\)/);
  assert.match(routes, /requirePermission\('operating_profile',\s*'write'\)/);
  assert.match(routes, /requirePermission\('operating_profile',\s*'update'\)/);
  assert.match(routes, /requireRole\('admin'\)[\s\S]*publishOperatingProfile/);
  assert.match(controller, /SITE_CONTEXT_REQUIRED/);
  assert.match(controller, /Selected site does not match the operating profile revision/);
});

test('Phase 1 extends canonical documents and audit instead of creating shadows', async () => {
  const [migration, profileController, access] = await Promise.all([
    backendSource('src/migrations/094_rera_phase1_foundation.js'),
    backendSource('src/controllers/operatingProfile.controller.js'),
    backendSource('src/utils/reraAccess.js'),
  ]);

  assert.match(migration, /ALTER TABLE compliance_documents/);
  assert.match(migration, /REFERENCES compliance_documents \(organization_id, id\) ON DELETE RESTRICT/);
  assert.match(migration, /ALTER TABLE compliance_licences/);
  assert.doesNotMatch(migration, /CREATE TABLE(?: IF NOT EXISTS)?\s+rera_(?:documents?|audit(?:_log)?)/i);
  assert.doesNotMatch(migration, /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:site_operating_profile_)?audit/i);
  assert.match(profileController, /import \{ writeComplianceAudit,/);
  assert.match(profileController, /await writeComplianceAudit\(/);
  assert.doesNotMatch(profileController, /INSERT INTO\s+rera_(?:audit|documents?)/i);
  assert.match(access, /Approval records reuse compliance_licences/);
  assert.match(access, /FROM compliance_licences a/);
  assert.match(access, /a\.rera_record_kind IS NOT NULL/);
});

test('RERA evidence is exact-Site scoped, field-policy enforced and privately streamed', async () => {
  const [controller, storage, routes] = await Promise.all([
    backendSource('src/controllers/complianceDocument.controller.js'),
    backendSource('src/utils/plotDocStorage.js'),
    backendSource('src/routes/complianceDocument.routes.js'),
  ]);

  assert.match(controller, /Stakeholder is not linked to the selected Site/);
  assert.match(controller, /siteScope = `AND d\.site_id=\$\$\{params\.length\}`/);
  assert.match(controller, /Document not found for the selected Site/);
  assert.match(controller, /section: 'rera_evidence'/);
  assert.match(controller, /FIELD_POLICY_VALIDATION_FAILED/);
  assert.match(controller, /export const streamComplianceDocument/);
  assert.match(controller, /getPermission\(req\.user\.id, 'rera_evidence'\)/);
  assert.match(controller, /candidate\.entity_type IN \([\s\S]*'RERA_PROJECT'[\s\S]*'RERA_FILING_PERIOD'[\s\S]*\)/);
  assert.match(controller, /module: 'rera_evidence'/);
  assert.match(controller, /d\.site_id = ANY\(\$\$\{params\.length\}::bigint\[\]\)/);
  assert.match(storage, /local-private::/);
  assert.match(storage, /PRIVATE_LOCAL_DIR/);
  assert.match(routes, /\/file\/:documentId\/content/);
  assert.match(controller, /documentSeriesKey/);
  assert.match(controller, /pg_advisory_xact_lock/);
  assert.match(controller, /site_id IS NOT DISTINCT FROM \$5 AND deleted_at IS NULL/);
  assert.match(controller, /evidenceSiteId, context\.entityType, context\.entityId/);
  assert.match(controller, /supersededUpdateRows/);
  assert.match(controller, /await writeComplianceAudit\(client, req,[\s\S]*action: 'DOCUMENT_DELETE'/);
  const migration = await backendSource('src/migrations/094_rera_phase1_foundation.js');
  assert.match(migration, /document_series_key VARCHAR\(160\)/);
  assert.match(migration, /uq_compliance_documents_series_version/);
});

test('Operating Profile UI uses one admin-only immediate save while preserving revision controls', async () => {
  const [component, routes, controller] = await Promise.all([
    frontendSource('src/components/settings/OperatingProfileSettings.jsx'),
    backendSource('src/routes/operatingProfile.routes.js'),
    backendSource('src/controllers/operatingProfile.controller.js'),
  ]);
  assert.match(component, /const canCreate = isAdmin \|\| hasPermission\('operating_profile', 'write'\)/);
  assert.match(component, /const canEdit = isAdmin \|\| hasPermission\('operating_profile', 'update'\)/);
  assert.match(component, /const canSave = isAdmin &&/);
  assert.match(component, /api\.put\('\/settings\/operating-profile'/);
  assert.match(component, /Changes are active now/);
  assert.doesNotMatch(component, /Save draft|Submit for review|Approve review|Publish profile/);
  assert.match(routes, /router\.put\('\/operating-profile', requireRole\('admin'\), requirePermission\('operating_profile', 'update'\), saveOperatingProfile\)/);
  assert.match(controller, /export const saveOperatingProfile/);
  assert.match(controller, /validateOperatingProfile\(input/);
  assert.match(controller, /lifecycle_status='SUPERSEDED'/);
  assert.match(controller, /lifecycle_status='PUBLISHED',review_decision='APPROVED'/);
  assert.match(controller, /OPERATING_PROFILE_SAVED/);
});

test('reviewed or rejected project source claims require an auditable reviewer', async () => {
  const [migration, controller] = await Promise.all([
    backendSource('src/migrations/094_rera_phase1_foundation.js'),
    backendSource('src/controllers/reraFoundation.controller.js'),
  ]);
  assert.match(migration, /source_reviewed_by INTEGER REFERENCES users\(id\) ON DELETE SET NULL/);
  assert.match(migration, /source_reviewed_at TIMESTAMPTZ/);
  assert.match(migration, /rera_project_source_review_audit_chk/);
  assert.match(migration, /source_review_status NOT IN \('REVIEWED', 'REJECTED'\)/);
  assert.match(migration, /rera_project_source_rejected_notes_chk/);
  assert.match(controller, /function reviewedProjectSourcePayload/);
  assert.match(controller, /Only an administrator can record or change a project source-review decision/);
  assert.match(controller, /input\.source_reviewed_by = raw\.source_reviewed_by/);
  assert.match(controller, /'source_reviewed_by', 'source_reviewed_at', 'source_review_notes'/);
});

test('RERA HTTP routes are mounted and canonical field policy covers every write surface', async () => {
  const [index, controller, routes] = await Promise.all([
    backendSource('src/routes/index.js'),
    backendSource('src/controllers/reraFoundation.controller.js'),
    backendSource('src/routes/reraFoundation.routes.js'),
  ]);
  assert.match(index, /import reraFoundationRoutes from '.\/reraFoundation\.routes\.js'/);
  assert.match(index, /router\.use\('\/rera', reraFoundationRoutes\)/);
  assert.match(controller, /buildReraFieldPolicyPayload\(section, raw, normalized\)/);
  assert.match(controller, /RERA_FIELD_POLICY_INPUTS\[section\]/);
  assert.match(controller, /'rera_participants', req\.body, input/);
  assert.doesNotMatch(controller, /const POLICY_ALIASES/);
  assert.match(routes, /\/participants\/:participantId'[\s\S]*requirePermission\('rera_projects', 'delete'\)/);
});

test('workspace stakeholder catalog binds only the placeholders present for the caller role', async () => {
  const controller = await backendSource('src/controllers/reraFoundation.controller.js');

  assert.match(controller, /const catalogParams = \[organizationId\];/);
  assert.match(controller, /if \(!isOrgAdmin\(req\.user\)\) \{\s*catalogParams\.push\(siteId, req\.user\.id\);/);
  assert.match(controller, /st\.created_by=\$3[\s\S]*linked_project\.site_id=\$2/);
});

test('project activity and approval review values remain project-scoped and lossless', async () => {
  const [controller, component] = await Promise.all([
    backendSource('src/controllers/reraFoundation.controller.js'),
    frontendSource('src/components/rera/ReraApprovalsEvidence.jsx'),
  ]);
  assert.match(controller, /activity_phase\.rera_project_id=\$4/);
  assert.match(controller, /activity_link\.rera_project_id=\$4/);
  assert.match(controller, /activity_approval\.rera_project_id=\$4/);
  assert.match(controller, /\$6::boolean=TRUE OR d\.confidentiality <> 'RESTRICTED'/);
  assert.match(controller, /NOT_REQUIRED: 'NOT_REQUIRED'/);
  assert.match(component, /value="NOT_REQUIRED">Review not required/);
});

test('review actors are server-owned and decided-state notes are admin-gated', async () => {
  const [controller, stakeholders, approvals] = await Promise.all([
    backendSource('src/controllers/reraFoundation.controller.js'),
    frontendSource('src/components/rera/ReraStakeholders.jsx'),
    frontendSource('src/components/rera/ReraApprovalsEvidence.jsx'),
  ]);
  assert.match(controller, /payload\.reviewed_by = fallback\.reviewed_by \?\? null/);
  assert.match(controller, /payload\.reviewed_at = fallback\.reviewed_at \?\? null/);
  assert.match(controller, /payload\.rera_reviewed_by = fallback\.rera_reviewed_by \?\? null/);
  assert.match(controller, /payload\.rera_reviewed_at = fallback\.rera_reviewed_at \?\? null/);
  assert.match(controller, /Only an administrator can change stakeholder review notes/);
  assert.match(controller, /Only an administrator can change approval review notes/);
  assert.match(stakeholders, /delete writableStakeholder\.record_review_status/);
  assert.match(approvals, /if \(!canReviewApprovals\) delete writableApproval\.review_status/);
});

test('Settings permits either general settings or Operating Profile read access', async () => {
  const [app, guard] = await Promise.all([
    frontendSource('src/App.jsx'),
    frontendSource('src/components/ProtectedRoute.jsx'),
  ]);
  assert.match(app, /requiredAnyModule=\{\['settings', 'operating_profile'\]\}/);
  assert.match(guard, /anyModules\.some\(\(module\) => hasPermission\(module, 'read'\)\)/);
});

test('new profile revisions preserve validated policy overrides', async () => {
  const controller = await backendSource('src/controllers/operatingProfile.controller.js');
  assert.match(controller, /const input = parseInput\(req, res, publishedRows\[0\] \|\| \{\}\)/);
  assert.match(controller, /silently erasing[\s\S]*module, terminology, capability or field policy/);
  assert.match(controller, /PREVIEW_IMPACT_QUERIES/);
  assert.match(controller, /records_requiring_mapping = impactRows\.filter\(Boolean\)/);
  assert.match(controller, /rules_activated = \[\.\.\.proposed\]/);
  assert.match(controller, /rules_deactivated = \[\.\.\.current\]/);
});

test('diagnostic scripts require environment credentials and contain no database URL', async () => {
  const scripts = await Promise.all([
    backendSource('check_schema.mjs'),
    backendSource('check_schema2.mjs'),
    backendSource('analyze_balaji.mjs'),
  ]);
  for (const source of scripts) {
    assert.match(source, /process\.env\.DATABASE_URL/);
    assert.doesNotMatch(source, /postgres(?:ql)?:\/\//i);
  }
});
