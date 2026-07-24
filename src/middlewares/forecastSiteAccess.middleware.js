import pool from '../config/db.js';
import { siteInOrg } from '../utils/orgScope.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

const parsePositiveId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** Enforce the site boundary for the Forecast Assistant before any DB read
 * or upstream AI call — mirrors plotSiteAccess.middleware.js. Uses site_id
 * (snake_case) in the body so authMiddleware's own ad hoc org check (which
 * only looks at req.body.site_id) also engages as a first layer. */
const forecastSiteAccess = async (req, res, next) => {
  try {
    const siteId = parsePositiveId(req.body?.site_id);
    if (!siteId) return res.status(400).json({ message: 'site_id is required' });

    if (ADMIN_ROLES.has(req.user?.role)) {
      if (!(await siteInOrg(siteId, req.user.organization_id))) {
        return res.status(403).json({ message: 'Access denied to this site' });
      }
      req.forecastSiteId = siteId;
      return next();
    }

    const { rows } = await pool.query(
      'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
      [req.user.id, siteId]
    );
    if (!rows[0]) return res.status(403).json({ message: 'Access denied to this site' });

    req.forecastSiteId = siteId;
    return next();
  } catch (error) {
    return next(error);
  }
};

export default forecastSiteAccess;
