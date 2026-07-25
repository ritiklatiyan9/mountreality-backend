import pool from '../config/db.js';

export const parsePositiveId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export const isOrgAdmin = (user) => ['admin', 'super_admin'].includes(user?.role);

/** Verify organisation ownership and, for sub-admins, explicit site assignment. */
export async function assertComplianceSiteAccess(req, res, rawSiteId, { required = false, db = pool } = {}) {
  if (rawSiteId === null || rawSiteId === undefined || rawSiteId === '') {
    if (required) res.status(400).json({ message: 'A valid site_id is required' });
    return required ? false : null;
  }
  const siteId = parsePositiveId(rawSiteId);
  if (!siteId) {
    res.status(400).json({ message: 'A valid site_id is required' });
    return false;
  }
  const { rows } = await db.query(
    `SELECT s.id
       FROM sites s
      WHERE s.id = $1
        AND s.organization_id = $2
        AND (
          $3::boolean = TRUE
          OR EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = $4 AND us.site_id = s.id)
        )
      LIMIT 1`,
    [siteId, req.user.organization_id, isOrgAdmin(req.user), req.user.id]
  );
  if (!rows[0]) {
    res.status(403).json({ message: 'Access denied to this site' });
    return false;
  }
  return siteId;
}

/**
 * SQL fragment for a table already constrained by organization_id. Org admins
 * see organisation-level and site rows; sub-admins see only assigned sites.
 */
export function addComplianceSiteScope(req, alias, params) {
  if (isOrgAdmin(req.user)) return '';
  params.push(req.user.id);
  return ` AND ${alias}.site_id IN (SELECT site_id FROM user_sites WHERE user_id = $${params.length})`;
}

export async function getScopedComplianceEntity(req, table, id, {
  alias = 'e', siteColumn = 'site_id', includeDeleted = false, db = pool,
} = {}) {
  const params = [id, req.user.organization_id];
  const siteScope = isOrgAdmin(req.user)
    ? ''
    : ` AND ${alias}.${siteColumn} IN (SELECT site_id FROM user_sites WHERE user_id = $3)`;
  if (!isOrgAdmin(req.user)) params.push(req.user.id);
  const deletedScope = includeDeleted ? '' : ` AND ${alias}.deleted_at IS NULL`;
  const { rows } = await db.query(
    `SELECT ${alias}.*
       FROM ${table} ${alias}
      WHERE ${alias}.id = $1
        AND ${alias}.organization_id = $2
        ${deletedScope}
        ${siteScope}
      LIMIT 1`,
    params
  );
  return rows[0] || null;
}

export async function writeComplianceAudit(db, req, {
  action, entityType, entityId = null, siteId = null,
  previousValue = null, newValue = null, reason = null,
}) {
  await db.query(
    `INSERT INTO compliance_audit_log
       (organization_id, site_id, user_id, action, entity_type, entity_id,
        previous_value, new_value, reason, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      req.user.organization_id, siteId || null, req.user.id, action, entityType,
      entityId, previousValue, newValue, reason || null, req.ip || null,
    ]
  );
}

