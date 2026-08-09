import pool from '../config/db.js';
import { enforceEntitySiteAccess, parseSiteId } from '../utils/siteAccessPolicy.js';

const ENTITY_LOOKUPS = Object.freeze({
  farmer: `SELECT f.site_id
             FROM farmers f
            WHERE f.id = $1
            LIMIT 1`,
  payment: `SELECT f.site_id
              FROM farmer_payments fp
              JOIN farmers f ON f.id = fp.farmer_id
             WHERE fp.id = $1
             LIMIT 1`,
});

const invalidIdMessage = (entity, key) => (
  entity === 'site' ? 'A valid site_id is required' : `A valid ${key} is required`
);

/**
 * Resolve a Farmer-domain record to its authoritative Site before controllers
 * read or mutate it. Bulk routes resolve every existing ID and reject requests
 * spanning Sites; unknown IDs remain for the controller's existing 404/empty
 * semantics.
 */
const requireFarmerSiteAccess = ({
  entity = 'site',
  source = 'query',
  key = 'site_id',
  required = true,
} = {}) => {
  const supported = entity === 'site'
    || entity === 'farmers'
    || entity === 'payments'
    || Object.prototype.hasOwnProperty.call(ENTITY_LOOKUPS, entity);
  if (!supported) throw new Error(`Unsupported farmer site-access entity: ${entity}`);

  return async (req, res, next) => {
    try {
      const rawValue = req[source]?.[key];
      const missing = rawValue === undefined || rawValue === null || String(rawValue).trim() === '';
      if (missing && entity !== 'farmers' && entity !== 'payments') {
        if (required) return res.status(400).json({ message: invalidIdMessage(entity, key) });
        return next();
      }

      let siteIds = [];
      if (entity === 'farmers' || entity === 'payments') {
        const rawIds = Array.isArray(rawValue) ? rawValue : [];
        const ids = [...new Set(rawIds.map(parseSiteId).filter(Boolean))];
        if (!ids.length) return next();

        const query = entity === 'farmers'
          ? 'SELECT DISTINCT site_id FROM farmers WHERE id = ANY($1::int[])'
          : `SELECT DISTINCT f.site_id
               FROM farmer_payments fp
               JOIN farmers f ON f.id = fp.farmer_id
              WHERE fp.id = ANY($1::int[])`;
        const { rows } = await pool.query(query, [ids]);
        siteIds = rows.map((row) => parseSiteId(row.site_id)).filter(Boolean);
      } else {
        const entityId = parseSiteId(rawValue);
        if (!entityId) return res.status(400).json({ message: invalidIdMessage(entity, key) });

        if (entity === 'site') {
          siteIds = [entityId];
        } else {
          const { rows } = await pool.query(ENTITY_LOOKUPS[entity], [entityId]);
          if (!rows[0]) return next();
          const siteId = parseSiteId(rows[0].site_id);
          if (!siteId) return res.status(409).json({ message: 'This record is not linked to a site' });
          siteIds = [siteId];
        }
      }

      const distinctSiteIds = [...new Set(siteIds)];
      if (!distinctSiteIds.length) return next();
      if (distinctSiteIds.length !== 1) {
        return res.status(409).json({
          code: 'MULTIPLE_SITE_CONTEXTS',
          message: 'Selected records belong to different Sites',
        });
      }

      const allowed = await enforceEntitySiteAccess({
        req,
        res,
        siteId: distinctSiteIds[0],
        module: 'farmers',
        contextProperty: 'farmerSiteId',
      });
      if (!allowed) return;
      return next();
    } catch (error) {
      return next(error);
    }
  };
};

export default requireFarmerSiteAccess;

