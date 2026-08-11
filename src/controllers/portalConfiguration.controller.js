import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import {
  clientPortalActions,
  getClientPortalConfiguration,
  listClientPortalPaymentModes,
  saveClientPortalConfiguration,
  validateClientPortalConfiguration,
} from '../services/portalConfiguration.service.js';

const positiveId = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

async function requireOrganizationSite(req, res, rawSiteId, db = pool) {
  const siteId = positiveId(rawSiteId);
  if (!siteId) {
    res.status(400).json({ message: 'A valid site_id is required' });
    return null;
  }
  const { rows } = await db.query(
    'SELECT id,name FROM sites WHERE id=$1 AND organization_id=$2 LIMIT 1',
    [siteId, req.user.organization_id],
  );
  if (!rows[0]) {
    res.status(404).json({ message: 'Site was not found in this organization' });
    return null;
  }
  return rows[0];
}

export const getClientPortalAdminConfiguration = asyncHandler(async (req, res) => {
  const site = await requireOrganizationSite(req, res, req.query.site_id);
  if (!site) return;
  const [configuration, availableModes] = await Promise.all([
    getClientPortalConfiguration(site.id),
    listClientPortalPaymentModes(site.id),
  ]);
  res.set('Cache-Control', 'private, no-store');
  res.json({
    site,
    configuration,
    available_transaction_modes: availableModes,
    security: {
      tenant_isolation: true,
      membership_scoping: true,
      server_enforced_visibility: true,
      login_rate_limited: true,
      session_revocation: true,
      released_documents_only: true,
    },
  });
});

export const updateClientPortalAdminConfiguration = asyncHandler(async (req, res) => {
  let normalized;
  try {
    normalized = validateClientPortalConfiguration(req.body.configuration);
  } catch (error) {
    return res.status(error.status || 400).json({ code: error.code, message: error.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const site = await requireOrganizationSite(req, res, req.body.site_id, client);
    if (!site) {
      await client.query('ROLLBACK');
      return;
    }
    const previous = await getClientPortalConfiguration(site.id, client);
    const saved = await saveClientPortalConfiguration(site.id, normalized, req.user.id, client);
    const permissionPolicy = { actions: clientPortalActions(saved.configuration) };
    await client.query(
      `UPDATE portal_memberships
          SET permission_policy=$1::jsonb,updated_at=NOW()
        WHERE organization_id=$2 AND site_id=$3 AND portal_type='BUYER'
          AND status IN ('PENDING','ACTIVE','SUSPENDED')`,
      [JSON.stringify(permissionPolicy), req.user.organization_id, site.id],
    );
    await client.query(
      `UPDATE portal_invitations
          SET permission_policy=$1::jsonb
        WHERE organization_id=$2 AND site_id=$3 AND portal_type='BUYER' AND status='PENDING'`,
      [JSON.stringify(permissionPolicy), req.user.organization_id, site.id],
    );
    await client.query(
      `INSERT INTO compliance_audit_log
        (organization_id,site_id,user_id,action,entity_type,entity_id,previous_value,new_value,reason,ip_address)
       VALUES ($1,$2,$3,'CLIENT_PORTAL_CONFIGURATION_UPDATED','APPLICATION_SETTING',$4,$5,$6,$7,$8)`,
      [req.user.organization_id, site.id, req.user.id, site.id, previous, saved.configuration,
        'Client portal visibility policy updated', req.ip],
    );
    await client.query('COMMIT');
    res.set('Cache-Control', 'private, no-store');
    res.json({ site, ...saved, message: 'Client portal configuration saved and enforced' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});
