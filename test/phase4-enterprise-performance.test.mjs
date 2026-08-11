import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const frontend = (file) => readFile(new URL(`../../Frontend/${file}`, import.meta.url), 'utf8');

test('Phase 4 schema is additive, tenant-scoped and fail-closed at the database boundary', async () => {
  const migration = await source('src/migrations/099_phase4_portals_enterprise.js');
  for (const table of [
    'product_features', 'plan_entitlements', 'organization_entitlement_overrides',
    'portal_invitations', 'portal_memberships', 'portal_document_grants',
    'portal_inventory_releases', 'portal_project_updates', 'portal_comments',
    'portal_notifications', 'rera_ruleset_release_workflows', 'integration_connections',
    'integration_events', 'developer_groups', 'legal_entities', 'site_legal_entity_assignments',
  ]) assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(migration, /validate_portal_identity_scope/);
  assert.match(migration, /Portal identity belongs to another organization/);
  assert.match(migration, /Portal project is outside the membership scope/);
  assert.match(migration, /CHECK \(\(audience_scope='MEMBERSHIP'\)=\(membership_id IS NOT NULL\)\)/);
  assert.match(migration, /CHECK \(status<>'RELEASED' OR \(released_by IS NOT NULL AND released_at IS NOT NULL\)\)/);
});

test('audience releases reference canonical sources and notifications publish set-wise', async () => {
  const controller = await source('src/controllers/phase4Release.controller.js');
  assert.match(controller, /document_store,document_id,portal_type,membership_id/);
  assert.match(controller, /plot_id,portal_type,membership_id,audience_scope,released_fields/);
  assert.match(controller, /organization_id,site_id,rera_project_id,rera_project_phase_id,source_type,source_id/);
  assert.match(controller, /WITH recipients AS MATERIALIZED/);
  assert.match(controller, /INSERT INTO portal_notifications[\s\S]*SELECT \$1,r\.id/);
  assert.doesNotMatch(controller, /for \(const membership of rows\)/);
  assert.match(controller, /const allowed = new Set\(\['plot_no'/);
});

test('ruleset releases require reviewed sources, legal review and impact snapshots without retroactive rewrites', async () => {
  const controller = await source('src/controllers/rulesetRelease.controller.js');
  assert.match(controller, /SOURCE_REVIEW_REQUIRED/);
  assert.match(controller, /LEGAL_SOURCE_GAPS/);
  assert.match(controller, /computeImpact/);
  assert.match(controller, /retroactive_rewrite: false/);
  assert.match(controller, /Existing projects\/profiles retain their pinned version/);
  assert.doesNotMatch(controller, /UPDATE rera_projects SET ruleset_version_id/);
  assert.doesNotMatch(controller, /UPDATE site_operating_profile_revisions SET ruleset_version_id/);
});

test('integration framework accepts only signed generic events and stores secret references only', async () => {
  const [controller, app] = await Promise.all([
    source('src/controllers/integrationFramework.controller.js'),
    source('src/app.js'),
  ]);
  assert.match(controller, /Secret references must be environment-variable names, not credentials/);
  assert.match(controller, /INLINE_SECRET_REJECTED/);
  assert.match(controller, /crypto\.createHmac\('sha256'/);
  assert.match(controller, /crypto\.timingSafeEqual/);
  assert.match(controller, /5 \* 60 \* 1000/);
  assert.match(controller, /Idempotency-Key/);
  assert.match(controller, /domain_mutation: false/);
  assert.match(controller, /Only generic inbound webhook validation can be activated/);
  assert.match(app, /req\.rawBody = Buffer\.from\(buffer\)/);
});

test('enterprise rollups expose source lineage and never sum distinct monetary values', async () => {
  const controller = await source('src/controllers/enterprisePortfolio.controller.js');
  assert.match(controller, /developer_group_organizations/);
  assert.match(controller, /relationship_status='ACTIVE'/);
  assert.match(controller, /site_legal_entity_assignments/);
  assert.match(controller, /lineage:/);
  assert.match(controller, /bookings\.final_consideration/);
  assert.match(controller, /approved non-bounced receipts/);
  assert.match(controller, /health_reasons/);
  assert.match(controller, /registry_backlog/);
  assert.match(controller, /possession_backlog/);
  assert.doesNotMatch(controller, /SUM\(DISTINCT\s+(?:b\.)?final_consideration/i);
  assert.doesNotMatch(controller, /SUM\(DISTINCT\s+(?:pp\.)?amount/i);
});

test('portal collaboration lifecycle retains safe attachments and resolution state', async () => {
  const migration = await source('src/migrations/101_phase4_portal_collaboration.js');
  assert.match(migration, /attachment_document_grant_id BIGINT REFERENCES portal_document_grants/);
  assert.match(migration, /resolved_at TIMESTAMPTZ/);
  assert.match(migration, /resolved_by INTEGER REFERENCES users/);
  assert.match(migration, /portal_comments_resolution_state_chk/);
  assert.match(migration, /idx_portal_comments_unresolved/);
});

test('enterprise UI exposes governed structure, risk, portfolio table and reporting export', async () => {
  const panel = await frontend('src/components/phase4/EnterprisePortfolioPanel.jsx');
  assert.match(panel, /GROUP_INVITE/);
  assert.match(panel, /GROUP_ACCEPT/);
  assert.match(panel, /SITE_ASSIGNMENT/);
  assert.match(panel, /Portfolio command centre/);
  assert.match(panel, /portfolio\.risks/);
  assert.match(panel, /Export CSV/);
});

test('performance migration follows every portal and construction hot predicate', async () => {
  const migration = await source('src/migrations/100_phase4_performance_hardening.js');
  for (const index of [
    'idx_bookings_portal_member_scope', 'idx_booking_allottees_portal_member',
    'idx_plot_payments_portal_booking', 'idx_plot_commissions_portal_broker',
    'idx_commission_payments_portal', 'idx_certifications_portal_professional',
    'idx_portal_memberships_context', 'idx_portal_document_released_feed',
    'idx_portal_inventory_released_feed', 'idx_portal_updates_released_feed',
    'idx_portal_updates_audiences_gin', 'idx_portal_notifications_feed',
    'idx_construction_forecast_approved_latest',
  ]) assert.match(migration, new RegExp(index));
  assert.match(migration, /ANALYZE/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test('enterprise portfolio rollups have dedicated growth indexes', async () => {
  const migration = await source('src/migrations/102_phase4_enterprise_rollup_performance.js');
  for (const index of [
    'idx_bookings_enterprise_project_rollup', 'idx_certifications_enterprise_latest',
    'idx_registries_enterprise_project_rollup', 'idx_licences_enterprise_expiry',
    'idx_filings_enterprise_project_rollup',
  ]) assert.match(migration, new RegExp(index));
  assert.match(migration, /ANALYZE/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test('API errors retain safe business status and hide unexpected internals', async () => {
  const middleware = await source('src/middlewares/error.middleware.js');
  assert.match(middleware, /status < 500/);
  assert.match(middleware, /err\?\.code/);
  assert.match(middleware, /err\?\.details/);
  assert.match(middleware, /An unexpected server error occurred/);
  assert.doesNotMatch(middleware, /res\.status\(500\).*err\?\.message/s);
});
