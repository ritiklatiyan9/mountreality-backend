import pool from '../config/db.js';
import { siteInOrg } from '../utils/orgScope.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

const SITE_LOOKUPS = Object.freeze({
  site: null,
  plot: 'SELECT site_id FROM plots WHERE id = $1 LIMIT 1',
  payment: `SELECT COALESCE(pp.site_id, p.site_id) AS site_id
              FROM plot_payments pp
              LEFT JOIN plots p ON p.id = pp.plot_id
             WHERE pp.id = $1
             LIMIT 1`,
  installment: `SELECT p.site_id
                  FROM plot_installments pi
                  JOIN plots p ON p.id = pi.plot_id
                 WHERE pi.id = $1
                 LIMIT 1`,
});

const parsePositiveId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** Enforce the owning plot/site boundary before Plot Payments data is read or
 * mutated. Invalid or missing IDs continue to the controller for its normal
 * 400/404 response; valid foreign-site IDs are denied to sub-admins. */
const requirePlotSiteAccess = ({ entity, source, key }) => {
  if (!Object.prototype.hasOwnProperty.call(SITE_LOOKUPS, entity)) {
    throw new Error(`Unsupported plot site-access entity: ${entity}`);
  }

  return async (req, res, next) => {
    try {
      const entityId = parsePositiveId(req[source]?.[key]);
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
        req.plotSiteId = siteId;
        return next();
      }

      const { rows } = await pool.query(
        'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
        [req.user.id, siteId]
      );
      if (!rows[0]) return res.status(403).json({ message: 'Access denied to this site' });

      req.plotSiteId = siteId;
      return next();
    } catch (error) {
      return next(error);
    }
  };
};

export default requirePlotSiteAccess;
