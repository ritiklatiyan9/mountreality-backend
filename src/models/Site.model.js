import MasterModel from './MasterModel.js';

class SiteModel extends MasterModel {
  constructor() {
    super('sites');
  }

  /** All sites (admin view) */
  async findAll(pool) {
    const query = `SELECT * FROM ${this.tableName} ORDER BY created_at DESC`;
    const result = await pool.query(query);
    return result.rows;
  }

  /** All sites belonging to one organization (tenant admin view) */
  async findAllByOrg(orgId, pool) {
    const query = `SELECT * FROM ${this.tableName} WHERE organization_id = $1 ORDER BY created_at DESC`;
    const result = await pool.query(query, [orgId]);
    return result.rows;
  }

  /** Number of sites an organization has (plan limit enforcement) */
  async countByOrg(orgId, pool) {
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM ${this.tableName} WHERE organization_id = $1`, [orgId]);
    return result.rows[0].count;
  }

  /** Sites accessible by a specific user (sub_admin) */
  async findByUserId(userId, pool) {
    const query = `
      SELECT s.* FROM sites s
      INNER JOIN user_sites us ON us.site_id = s.id
      WHERE us.user_id = $1
      ORDER BY s.created_at DESC
    `;
    const result = await pool.query(query, [userId]);
    return result.rows;
  }

  /** Find by code within one organization (codes are unique per org, not globally) */
  async findByCode(code, orgId, pool) {
    const query = `SELECT * FROM ${this.tableName} WHERE code = $1 AND organization_id = $2`;
    const result = await pool.query(query, [code, orgId]);
    return result.rows[0];
  }

  /** Assign a site to a sub-admin */
  async assignUser(siteId, userId, pool) {
    const query = `INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *`;
    const result = await pool.query(query, [userId, siteId]);
    return result.rows[0];
  }

  /** Remove a sub-admin from a site */
  async unassignUser(siteId, userId, pool) {
    const query = `DELETE FROM user_sites WHERE user_id = $1 AND site_id = $2 RETURNING *`;
    const result = await pool.query(query, [userId, siteId]);
    return result.rows[0];
  }

  /** Get all users assigned to a site */
  async getAssignedUsers(siteId, pool) {
    const query = `
      SELECT u.id, u.name, u.email, u.phone, u.photo, u.role, u.is_active, us.assigned_at
      FROM users u
      INNER JOIN user_sites us ON us.user_id = u.id
      WHERE us.site_id = $1
      ORDER BY us.assigned_at DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }
}

export default new SiteModel();
