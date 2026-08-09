import pool from '../config/db.js';
import { enforceEntitySiteAccess } from '../utils/siteAccessPolicy.js';

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
      if (!siteId) {
        return res.status(409).json({ message: 'This record is not linked to a site' });
      }

      const allowed = await enforceEntitySiteAccess({
        req,
        res,
        siteId,
        module: 'plot_payments',
        contextProperty: 'plotSiteId',
      });
      if (!allowed) return;
      return next();
    } catch (error) {
      return next(error);
    }
  };
};

export default requirePlotSiteAccess;
