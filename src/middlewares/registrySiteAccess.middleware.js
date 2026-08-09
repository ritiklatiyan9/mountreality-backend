import pool from '../config/db.js';
import { enforceEntitySiteAccess } from '../utils/siteAccessPolicy.js';

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
  document: `SELECT COALESCE(d.site_id, p.site_id, k.site_id, b.site_id) AS site_id
               FROM documents d
               LEFT JOIN plots p ON p.id = d.plot_id
               LEFT JOIN kyc_cases k ON k.id = d.kyc_case_id
               LEFT JOIN bookings b ON b.id = k.booking_id
              WHERE d.id = $1
                AND d.uploaded_source = 'PLOT_REGISTRY'
              LIMIT 1`,
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

      if (!siteId) {
        return res.status(409).json({ message: 'This record is not linked to a site' });
      }

      const allowed = await enforceEntitySiteAccess({
        req,
        res,
        siteId,
        module: 'plot_registry',
        contextProperty: 'registrySiteId',
      });
      if (!allowed) return;
      return next();
    } catch (error) {
      return next(error);
    }
  };
};

export default requireRegistrySiteAccess;
