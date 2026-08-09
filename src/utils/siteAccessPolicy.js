import pool from '../config/db.js';
import { isSiteModuleAllowed } from '../services/sitePolicy.service.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

export const parseSiteId = (value) => {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/**
 * Bind an entity-derived Site to the request and enforce all three boundaries:
 * selected-Site consistency, tenant ownership, and sub-admin assignment. The
 * effective operating policy is evaluated only after the authoritative Site is
 * known, preventing an X-Site-ID for Site B from authorizing an entity in A.
 */
export async function enforceEntitySiteAccess({
  req,
  res,
  siteId,
  module,
  contextProperty,
  db = pool,
}) {
  const resolvedSiteId = parseSiteId(siteId);
  if (!resolvedSiteId) {
    res.status(400).json({ message: 'A valid site_id is required' });
    return false;
  }

  const selectedSiteId = parseSiteId(req.siteContextId);
  if (selectedSiteId && selectedSiteId !== resolvedSiteId) {
    res.status(409).json({
      code: 'SITE_CONTEXT_MISMATCH',
      message: 'Selected site does not match the requested record',
    });
    return false;
  }

  const organizationId = parseSiteId(req.user?.organization_id);
  if (!organizationId) {
    res.status(403).json({ message: 'Access denied to this site' });
    return false;
  }

  const { rows: siteRows } = await db.query(
    'SELECT 1 FROM sites WHERE id = $1 AND organization_id = $2 LIMIT 1',
    [resolvedSiteId, organizationId],
  );
  if (!siteRows[0]) {
    res.status(403).json({ message: 'Access denied to this site' });
    return false;
  }

  if (!ADMIN_ROLES.has(req.user?.role)) {
    const { rows: assignmentRows } = await db.query(
      'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
      [req.user?.id, resolvedSiteId],
    );
    if (!assignmentRows[0]) {
      res.status(403).json({ message: 'Access denied to this site' });
      return false;
    }
  }

  // Set the canonical context before policy resolution and downstream code.
  req.siteContextId = resolvedSiteId;
  if (contextProperty) req[contextProperty] = resolvedSiteId;

  const allowed = await isSiteModuleAllowed({
    organizationId,
    siteId: resolvedSiteId,
    module,
    db,
  });
  if (!allowed) {
    res.status(403).json({
      code: 'SITE_POLICY_DENIED',
      message: 'This module is not available for the selected Site operating profile',
    });
    return false;
  }

  return true;
}
