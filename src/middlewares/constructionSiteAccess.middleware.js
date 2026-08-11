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
  workPackage: 'SELECT site_id FROM construction_work_packages WHERE id=$1 AND deleted_at IS NULL LIMIT 1',
  dailyUpdate: 'SELECT site_id FROM construction_daily_updates WHERE id=$1 LIMIT 1',
  certification: 'SELECT site_id FROM construction_certifications WHERE id=$1 LIMIT 1',
  filing: 'SELECT site_id FROM rera_filing_periods WHERE id=$1 LIMIT 1',
  change: 'SELECT site_id FROM rera_project_change_requests WHERE id=$1 LIMIT 1',
  extension: 'SELECT site_id FROM rera_project_extensions WHERE id=$1 LIMIT 1',
  risk: 'SELECT site_id FROM construction_risks WHERE id=$1 LIMIT 1',
});

const requireConstructionSiteAccess = ({ entity = 'site', source = 'query', key = 'site_id', module = 'construction' } = {}) => {
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
        module,
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
