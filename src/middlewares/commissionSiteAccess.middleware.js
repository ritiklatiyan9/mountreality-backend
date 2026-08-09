import pool from '../config/db.js';
import { enforceEntitySiteAccess, parseSiteId } from '../utils/siteAccessPolicy.js';

const ENTITY_LOOKUPS = Object.freeze({
  commission: 'SELECT site_id FROM plot_commissions WHERE id = $1 LIMIT 1',
  master: 'SELECT site_id FROM plot_commissions_v2 WHERE id = $1 LIMIT 1',
  plot: 'SELECT site_id FROM plots WHERE id = $1 LIMIT 1',
  payment: `SELECT pc.site_id
              FROM plot_commission_payments pcp
              JOIN plot_commissions_v2 pc ON pc.id = pcp.plot_commission_id
             WHERE pcp.id = $1
             LIMIT 1`,
});

const requireCommissionSiteAccess = ({ entity = 'site', source = 'query', key = 'site_id' } = {}) => {
  const supported = entity === 'site'
    || entity === 'payments'
    || Object.prototype.hasOwnProperty.call(ENTITY_LOOKUPS, entity);
  if (!supported) throw new Error(`Unsupported commission access entity: ${entity}`);

  return async (req, res, next) => {
    try {
      const rawValue = req[source]?.[key];
      let siteIds = [];

      if (entity === 'payments') {
        const ids = [...new Set((Array.isArray(rawValue) ? rawValue : [])
          .map(parseSiteId)
          .filter(Boolean))];
        if (!ids.length) return next();
        const { rows } = await pool.query(
          `SELECT DISTINCT pc.site_id
             FROM plot_commission_payments pcp
             JOIN plot_commissions_v2 pc ON pc.id = pcp.plot_commission_id
            WHERE pcp.id = ANY($1::int[])`,
          [ids],
        );
        siteIds = rows.map((row) => parseSiteId(row.site_id)).filter(Boolean);
      } else {
        const entityId = parseSiteId(rawValue);
        if (!entityId) return res.status(400).json({ message: `A valid ${key} is required` });
        if (entity === 'site') {
          siteIds = [entityId];
        } else {
          const { rows } = await pool.query(ENTITY_LOOKUPS[entity], [entityId]);
          // Preserve controller-specific 404s without authorizing any record.
          if (!rows[0]) return next();
          const siteId = parseSiteId(rows[0].site_id);
          if (!siteId) return res.status(409).json({ message: 'This record is not linked to a Site' });
          siteIds = [siteId];
        }
      }

      const distinctSiteIds = [...new Set(siteIds)];
      if (!distinctSiteIds.length) return next();
      if (distinctSiteIds.length !== 1) {
        return res.status(409).json({
          code: 'MULTIPLE_SITE_CONTEXTS',
          message: 'Selected commission records belong to different Sites',
        });
      }

      const allowed = await enforceEntitySiteAccess({
        req,
        res,
        siteId: distinctSiteIds[0],
        module: 'commissions',
        contextProperty: 'commissionSiteId',
      });
      if (!allowed) return;
      return next();
    } catch (error) {
      return next(error);
    }
  };
};

export default requireCommissionSiteAccess;

