import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertPortalAction,
  permissionAllows,
  serializeBuyerBooking,
  serializeProfessionalCertification,
  serializeReleasedInventory,
} from '../src/services/portalAccess.service.js';
import {
  assertClientPortalAvailable,
  assertClientPortalModule,
  normalizeClientPortalConfiguration,
  validateClientPortalConfiguration,
} from '../src/services/portalConfiguration.service.js';

const source = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const frontend = (file) => readFile(new URL(`../../Frontend/${file}`, import.meta.url), 'utf8');

test('portal permissions fail closed and never grant an unlisted action', () => {
  assert.equal(permissionAllows(null, 'view_booking'), false);
  assert.equal(permissionAllows({ permission_policy: { actions: ['view_booking'] } }, 'view_booking'), true);
  assert.equal(permissionAllows({ permission_policy: { actions: ['view_booking'] } }, 'view_finance'), false);
  assert.equal(permissionAllows({ permission_policy: { actions: ['*'] } }, 'view_finance'), true);
  assert.throws(
    () => assertPortalAction({ permission_policy: { actions: [] } }, 'view_documents'),
    (error) => error.status === 403 && error.code === 'PORTAL_ACTION_DENIED',
  );
});

test('client portal configuration is allowlisted and fails closed for disabled surfaces', () => {
  const normalized = normalizeClientPortalConfiguration({
    portal_enabled: true,
    modules: { overview: false, transactions: true, internal_admin: true },
    transaction_visibility: { scope: 'SELECTED', selected_modes: ['upi', 'NEFT', '<script>', 'upi'] },
    privileged: true,
  });
  assert.equal(normalized.modules.overview, false);
  assert.equal(normalized.modules.transactions, true);
  assert.equal('internal_admin' in normalized.modules, false);
  assert.equal('privileged' in normalized, false);
  assert.deepEqual(normalized.transaction_visibility.selected_modes, ['UPI', 'NEFT']);
  assert.throws(
    () => validateClientPortalConfiguration({ transaction_visibility: { scope: 'SELECTED', selected_modes: [] } }),
    (error) => error.status === 400 && error.code === 'PORTAL_TRANSACTION_MODE_REQUIRED',
  );
  assert.throws(
    () => assertClientPortalAvailable({ portal_type: 'BUYER' }, { portal_enabled: false }),
    (error) => error.status === 403 && error.code === 'CLIENT_PORTAL_DISABLED',
  );
  assert.throws(
    () => assertClientPortalModule({ portal_type: 'BUYER' }, { portal_enabled: true, modules: { documents: false } }, 'documents'),
    (error) => error.status === 403 && error.code === 'PORTAL_MODULE_DISABLED',
  );
});

test('portal serializers expose explicit safe projections only', () => {
  const sourceRow = {
    booking_id: 9, booking_reference: 'B-9', booking_status: 'ACTIVE', booked_at: '2026-01-01',
    plot_id: 7, plot_no: 'P-7', plot_size: 1200, plot_rate: 1500, plot_status: 'BOOKED',
    rera_project_id: 3, project_name: 'Project', registration_number: 'REG', rera_project_phase_id: 4,
    phase_name: 'Phase', agreed_value: 10, amount_received: 7, amount_due: 3,
    agreement_status: 'EXECUTED', registry_status: 'PENDING', possession_status: 'NOT_READY',
    internal_notes: 'must not leak', organization_id: 77, client_member_id: 100,
  };
  const booking = serializeBuyerBooking(sourceRow);
  assert.deepEqual(Object.keys(booking), ['booking_id', 'booking_reference', 'booking_status', 'booked_at', 'property', 'project', 'commercial', 'lifecycle']);
  assert.equal('internal_notes' in booking, false);
  assert.equal('client_member_id' in booking, false);

  const inventory = serializeReleasedInventory({
    release_id: 1, plot_id: 2, released_fields: ['plot_no', 'plot_rate', 'bank_account', 'internal_notes'],
    plot_no: 'A-1', plot_rate: 5000, bank_account: 'hidden', internal_notes: 'hidden', released_at: '2026-01-01',
  });
  assert.deepEqual(inventory, { release_id: 1, plot_id: 2, plot_no: 'A-1', plot_rate: 5000, released_at: '2026-01-01' });

  const certification = { id: 1, rera_project_id: 2, cost_snapshot: { actual: 99 }, review_notes: 'review' };
  assert.equal('cost_snapshot' in serializeProfessionalCertification(certification, { permission_policy: { actions: [] } }), false);
  assert.deepEqual(
    serializeProfessionalCertification(certification, { permission_policy: { actions: ['view_finance'] } }).cost_snapshot,
    { actual: 99 },
  );
});

test('invites store token hashes, enforce canonical identities and invalidate revoked sessions', async () => {
  const controller = await source('src/controllers/portalInvitation.controller.js');
  assert.match(controller, /crypto\.randomBytes\(32\)/);
  assert.match(controller, /token_hash[\s\S]*hashToken\(rawToken\)/);
  assert.doesNotMatch(controller, /INSERT INTO portal_invitations[\s\S]{0,600}\brawToken\b/);
  assert.match(controller, /b\.client_member_id=\$3 OR EXISTS[\s\S]*booking_allottees/);
  assert.doesNotMatch(controller, /buyer_name\s*=|LOWER\(b\.buyer_name/);
  assert.match(controller, /rera_project_participants/);
  assert.match(controller, /UPDATE users SET token_version=token_version\+1/);
  assert.match(controller, /SELECT \* FROM portal_invitations WHERE token_hash=\$1 FOR UPDATE/);
  assert.match(controller, /rawToken\.length < 32 \|\| rawToken\.length > 128/);
});

test('portal reads are exact relationship joins and professional finalization is impossible', async () => {
  const controller = await source('src/controllers/portal.controller.js');
  assert.match(controller, /\$\{alias\}\.client_member_id=\$\{memberParam\} OR EXISTS[\s\S]*booking_allottees/);
  assert.match(controller, /pc\.site_id=\$1 AND pc\.agent_id=\$2/);
  assert.match(controller, /c\.professional_stakeholder_id=\$3/);
  assert.match(controller, /\['INTERNAL_REVIEW', 'REVISION_REQUIRED'\]\.includes\(nextStatus\)/);
  assert.match(controller, /Professional review may submit for internal review or request a revision/);
  assert.match(controller, /portal_document_grants/);
  assert.match(controller, /pdg\.status='RELEASED'/);
  assert.match(controller, /Cache-Control', 'private, no-store'/);
  assert.match(controller, /attachment_document_grant_id/);
  assert.match(controller, /PORTAL_COMMENT_RESOLVED/);
  assert.match(controller, /resolution_notes/);
  assert.match(controller, /site_id IS NULL OR site_id=\$5/);
  assert.match(controller, /parent_comment_id[\s\S]*visibility='ALL_PORTAL'/);
  assert.match(controller, /pc\.site_id=\$6/);
  assert.match(controller, /organization_id=\$2 AND site_id=\$5 AND deleted_at IS NULL/);
  assert.match(controller, /portal_notification_preferences/);
});

test('portal-only users are blocked from internal APIs and public entry points are rate limited', async () => {
  const [auth, routes, authRoutes, authController, portalAccess] = await Promise.all([
    source('src/middlewares/auth.middleware.js'),
    source('src/routes/phase4.routes.js'),
    source('src/routes/auth.routes.js'),
    source('src/controllers/auth.controller.js'),
    source('src/services/portalAccess.service.js'),
  ]);
  assert.match(auth, /dbUser\.role === 'portal_user'/);
  assert.match(auth, /PORTAL_ONLY_IDENTITY/);
  assert.match(routes, /webhooks\/:connectionId\/:connectionKey[\s\S]*router\.use\(authMiddleware\)/);
  assert.match(routes, /requirePortalMembership\('BUYER'\)/);
  assert.match(routes, /requirePortalMembership\('BROKER'\)/);
  assert.match(routes, /requirePortalMembership\('PROFESSIONAL'\)/);
  assert.match(routes, /portalTrafficLimiter/);
  assert.match(routes, /portal-invitations', requireAdmin, portalAdminMutationLimiter/);
  assert.match(routes, /Cache-Control', 'private, no-store/);
  assert.match(routes, /portal\/buyer\/installments/);
  assert.match(routes, /admin\/client-portal-configuration/);
  assert.match(authRoutes, /loginIpLimiter, publicAuthLimiter, login/);
  assert.match(authRoutes, /inviteAcceptanceLimiter, acceptPortalInvitation/);
  assert.match(authController, /DUMMY_PASSWORD_HASH/);
  assert.match(authController, /user\?\.password \|\| DUMMY_PASSWORD_HASH/);
  assert.match(portalAccess, /PORTAL_SITE_CONTEXT_MISMATCH/);
});

test('frontend has distinct invite, portal, ecosystem and construction-governance route surfaces', async () => {
  const [app, navigation, portal, discussion, ecosystem, governance] = await Promise.all([
    frontend('src/App.jsx'), frontend('src/components/sidebar/navConfig.js'),
    frontend('src/pages/PortalWorkspace.jsx'), frontend('src/components/phase4/PortalDiscussionDialog.jsx'),
    frontend('src/pages/EcosystemControlCentre.jsx'),
    frontend('src/pages/ConstructionGovernance.jsx'),
  ]);
  assert.match(app, /path="\/portal\/accept"/);
  assert.match(app, /path="\/portal"/);
  assert.match(app, /path="\/ecosystem"/);
  assert.match(app, /path="\/construction\/governance"/);
  assert.match(navigation, /Construction governance/);
  assert.match(navigation, /Client Portal/);
  assert.match(portal, /membership\.portal_type === 'BUYER'/);
  assert.match(portal, /portal\/buyer\/payments\?limit=100/);
  assert.match(portal, /portal\/buyer\/installments\?limit=100/);
  assert.match(portal, /membership\.portal_type === 'BROKER'/);
  assert.match(portal, /PROFESSIONAL: \{ label: 'Professional review'/);
  assert.match(portal, /professional\/certifications/);
  assert.match(portal, /notification-preferences/);
  assert.match(discussion, /portal\/comments/);
  assert.match(discussion, /attachment_document_grant_id/);
  assert.match(discussion, /\/resolve/);
  assert.match(ecosystem, /Client portal control center/);
  assert.match(ecosystem, /Transaction visibility/);
  assert.match(ecosystem, /Upcoming installments/);
  assert.match(ecosystem, /Server-side visibility/);
  assert.doesNotMatch(ecosystem, /Ruleset releases|Enterprise structure|Integrations/);
  assert.match(governance, /Professional certification register/);
});
