import pool from '../config/db.js';
import { enforceEntitySiteAccess, parseSiteId } from '../utils/siteAccessPolicy.js';

/** Resolve the authoritative Site before RBAC/Site-policy evaluation. */
export default function requireLandAcquisitionSiteAccess({
  source = 'params', key = 'id', entity = 'acquisition', required = true,
} = {}) {
  return async (req, res, next) => {
    try {
      const raw = req[source]?.[key];
      if ((raw === undefined || raw === null || raw === '') && !required) return next();
      const id = parseSiteId(raw);
      if (!id) {
        return res.status(400).json({
          message: entity === 'site' ? 'A valid site_id is required' : 'A valid acquisition id is required',
        });
      }

      let siteId = id;
      if (entity === 'acquisition') {
        const { rows } = await pool.query(
          `SELECT f.id,f.site_id,f.member_id,f.acquisition_reference
             FROM farmers f
            WHERE f.id=$1
            LIMIT 1`,
          [id],
        );
        const acquisition = rows[0];
        if (!acquisition) return next();
        siteId = parseSiteId(acquisition.site_id);
        if (!siteId) return res.status(409).json({ message: 'This acquisition is not linked to a Site' });
        req.landAcquisitionId = Number(acquisition.id);
        req.landAcquisitionMemberId = acquisition.member_id ? Number(acquisition.member_id) : null;
        req.landAcquisitionReference = acquisition.acquisition_reference || null;
      }

      const allowed = await enforceEntitySiteAccess({
        req,
        res,
        siteId,
        module: 'farmers',
        contextProperty: 'landAcquisitionSiteId',
      });
      if (!allowed) return;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
