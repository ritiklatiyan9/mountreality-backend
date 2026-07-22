import pool from '../config/db.js';
import { siteInOrg } from '../utils/orgScope.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

const ENTITY_LOOKUPS = Object.freeze({
  allocation: 'SELECT site_id FROM imprest_allocations WHERE id = $1 LIMIT 1',
  expenseRequest: 'SELECT site_id FROM imprest_expense_requests WHERE id = $1 LIMIT 1',
  return: 'SELECT site_id FROM imprest_returns WHERE id = $1 LIMIT 1',
});

const parsePositiveId = (value) => {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const isAdmin = (req) => ADMIN_ROLES.has(req.user?.role);

/**
 * Return an active user only when they can participate in an imprest workflow
 * for the selected site. Admins and super-admins are global participants;
 * sub-admins must currently be assigned to the site.
 */
export const findEligibleImprestParticipant = async (userId, siteId, db = pool) => {
  const parsedUserId = parsePositiveId(userId);
  const parsedSiteId = parsePositiveId(siteId);
  if (!parsedUserId || !parsedSiteId) return null;

  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.role
       FROM users u
      WHERE u.id = $1
        AND u.is_active = true
        AND (
          u.role IN ('admin', 'super_admin')
          OR (
            u.role = 'sub_admin'
            AND EXISTS (
              SELECT 1
                FROM user_sites us
               WHERE us.user_id = u.id
                 AND us.site_id = $2
            )
          )
        )
      LIMIT 1`,
    [parsedUserId, parsedSiteId]
  );
  return rows[0] || null;
};

/**
 * Resolve the authoritative site for an imprest request and enforce user_sites
 * for sub-admins. Direct site routes may remain site-optional for global admin
 * reads, but a sub-admin must always select one assigned site.
 */
const requireImprestSiteAccess = ({
  entity = 'site',
  source = 'query',
  key = 'site_id',
  required = false,
} = {}) => {
  if (entity !== 'site' && !Object.prototype.hasOwnProperty.call(ENTITY_LOOKUPS, entity)) {
    throw new Error(`Unsupported imprest site-access entity: ${entity}`);
  }

  return async (req, res, next) => {
    try {
      const rawValue = req[source]?.[key];
      const missing = rawValue === undefined || rawValue === null || String(rawValue).trim() === '';
      const requireValue = required || !isAdmin(req) || entity !== 'site';

      if (missing) {
        if (requireValue) {
          return res.status(400).json({
            message: entity === 'site' ? 'A valid site_id is required' : `A valid ${key} is required`,
          });
        }
        return next();
      }

      const entityId = parsePositiveId(rawValue);
      if (!entityId) {
        return res.status(400).json({
          message: entity === 'site' ? 'A valid site_id is required' : `A valid ${key} is required`,
        });
      }

      let siteId = entityId;
      if (entity === 'site') {
        const { rows } = await pool.query('SELECT id FROM sites WHERE id = $1 LIMIT 1', [entityId]);
        if (!rows[0]) return res.status(404).json({ message: 'Site not found' });
      } else {
        const { rows } = await pool.query(ENTITY_LOOKUPS[entity], [entityId]);
        // Preserve the controller's entity-specific 404 response.
        if (!rows[0]) return next();
        siteId = parsePositiveId(rows[0].site_id);
        if (!siteId) {
          if (isAdmin(req)) return next();
          return res.status(409).json({ message: 'This record is not linked to a site' });
        }
      }

      req.imprestSiteId = siteId;
      if (isAdmin(req)) {
        // Admins see every site of their own organization — never another tenant's.
        if (!(await siteInOrg(siteId, req.user.organization_id))) {
          return res.status(403).json({ message: 'Access denied to this site' });
        }
        return next();
      }

      const { rows } = await pool.query(
        'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
        [req.user.id, siteId]
      );
      if (!rows[0]) return res.status(403).json({ message: 'Access denied to this site' });

      return next();
    } catch (error) {
      return next(error);
    }
  };
};

/** Validate a recipient/reviewer after requireImprestSiteAccess resolved a site. */
export const requireImprestParticipant = ({
  source = 'body',
  key,
  label = 'Recipient',
  required = true,
}) => async (req, res, next) => {
  try {
    const rawValue = req[source]?.[key];
    const missing = rawValue === undefined || rawValue === null || String(rawValue).trim() === '';
    if (missing) {
      if (required) return res.status(400).json({ message: `${label} is required` });
      return next();
    }

    const userId = parsePositiveId(rawValue);
    if (!userId) return res.status(400).json({ message: `${label} is invalid` });
    if (!req.imprestSiteId) return res.status(400).json({ message: 'A valid site_id is required' });

    const participant = await findEligibleImprestParticipant(userId, req.imprestSiteId);
    if (!participant) {
      return res.status(400).json({ message: `${label} is not available for this site` });
    }

    req.imprestParticipants = {
      ...(req.imprestParticipants || {}),
      [key]: participant,
    };
    return next();
  } catch (error) {
    return next(error);
  }
};

export default requireImprestSiteAccess;
