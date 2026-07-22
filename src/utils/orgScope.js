import pool from '../config/db.js';

/** Tenant boundary check shared by the site-access middlewares. */
export const siteInOrg = async (siteId, orgId) => {
  const { rows } = await pool.query(
    'SELECT 1 FROM sites WHERE id = $1 AND organization_id = $2 LIMIT 1',
    [siteId, orgId]
  );
  return !!rows[0];
};
