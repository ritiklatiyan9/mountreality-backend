import pool from '../config/db.js';
import { enforceEntitySiteAccess, parseSiteId } from '../utils/siteAccessPolicy.js';

const LOOKUPS = Object.freeze({
  project: 'SELECT site_id FROM construction_projects WHERE id = $1 LIMIT 1',
  task: `SELECT p.site_id
           FROM construction_tasks t
           JOIN construction_projects p ON p.id = t.project_id
          WHERE t.id = $1
          LIMIT 1`,
  request: 'SELECT site_id FROM construction_material_requests WHERE id = $1 LIMIT 1',
});

const requireConstructionSiteAccess = ({ entity = 'site', source = 'query', key = 'site_id' } = {}) => {
  if (entity !== 'site' && !Object.prototype.hasOwnProperty.call(LOOKUPS, entity)) {
    throw new Error(`Unsupported construction access entity: ${entity}`);
  }

  return async (req, res, next) => {
    try {
      const entityId = parseSiteId(req[source]?.[key]);
      if (!entityId) return res.status(400).json({ message: `A valid ${key} is required` });

      let siteId = entityId;
      if (entity !== 'site') {
        const { rows } = await pool.query(LOOKUPS[entity], [entityId]);
        // Preserve controller-specific 404 responses for unknown IDs.
        if (!rows[0]) return next();
        siteId = parseSiteId(rows[0].site_id);
        if (!siteId) return res.status(409).json({ message: 'This record is not linked to a Site' });
      }

      const allowed = await enforceEntitySiteAccess({
        req,
        res,
        siteId,
        module: 'construction',
        contextProperty: 'constructionSiteId',
      });
      if (!allowed) return;
      return next();
    } catch (error) {
      return next(error);
    }
  };
};

export default requireConstructionSiteAccess;

