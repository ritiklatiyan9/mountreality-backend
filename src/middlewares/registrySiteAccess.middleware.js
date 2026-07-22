import pool from '../config/db.js';
import { siteInOrg } from '../utils/orgScope.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

const parsePositiveId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const getRequestValue = (req, source, key) => req[source]?.[key];

const SITE_LOOKUPS = Object.freeze({
  site: null,
  registry: 'SELECT site_id FROM plot_registries WHERE id = $1 LIMIT 1',
  payment: 'SELECT site_id FROM plot_registry_payments WHERE id = $1 LIMIT 1',
  plot: 'SELECT site_id FROM plots WHERE id = $1 LIMIT 1',
  plotPayment: 'SELECT site_id FROM plot_payments WHERE id = $1 LIMIT 1',
});

/**
 * Restrict a registry route to sites assigned through user_sites.
 *
 * Admins and super-admins intentionally bypass this check. For sub-admins,
 * the site can be supplied directly or resolved from a registry, registry
 * payment, or plot ID. Missing/invalid/not-found IDs are left to the endpoint
 * controller so its existing validation and 404 response remain unchanged.
 */
const requireRegistrySiteAccess = ({ entity, source, key }) => {
  if (!Object.prototype.hasOwnProperty.call(SITE_LOOKUPS, entity)) {
    throw new Error(`Unsupported registry site-access entity: ${entity}`);
  }

  return async (req, res, next) => {
    try {
      const entityId = parsePositiveId(getRequestValue(req, source, key));
      if (!entityId) return next();

      let siteId = entityId;
      const lookupSql = SITE_LOOKUPS[entity];
      if (lookupSql) {
        const { rows } = await pool.query(lookupSql, [entityId]);
        if (!rows[0]) return next();
        siteId = parsePositiveId(rows[0].site_id);
      }

      if (!siteId) return next();

      // Admins see every site of their own organization — never another tenant's.
      if (ADMIN_ROLES.has(req.user?.role)) {
        if (!(await siteInOrg(siteId, req.user.organization_id))) {
          return res.status(403).json({ message: 'Access denied to this site' });
        }
        req.registrySiteId = siteId;
        return next();
      }

      const { rows } = await pool.query(
        'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
        [req.user.id, siteId]
      );
      if (!rows[0]) {
        return res.status(403).json({ message: 'Access denied to this site' });
      }

      req.registrySiteId = siteId;
      return next();
    } catch (error) {
      return next(error);
    }
  };
};

export default requireRegistrySiteAccess;
