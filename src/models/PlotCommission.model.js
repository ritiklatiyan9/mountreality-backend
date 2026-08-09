import MasterModel from './MasterModel.js';

class PlotCommissionModel extends MasterModel {
  constructor() {
    super('plot_commissions');
  }

  /** All commissions for a site, ordered by date ASC */
  async findBySiteId(siteId, pool) {
    const query = `
      SELECT pc.*,
             COALESCE(pc.father_name, m.father_name) AS father_name_resolved,
             COALESCE(NULLIF(TRIM(cu.name), ''), cu.email) AS created_by_name
      FROM plot_commissions pc
      LEFT JOIN LATERAL (
        SELECT father_name FROM members
        WHERE site_id = pc.site_id AND UPPER(full_name) = UPPER(pc.particular)
        LIMIT 1
      ) m ON true
      LEFT JOIN users cu ON cu.id = pc.created_by
      WHERE pc.site_id = $1
      ORDER BY pc.date ASC, pc.created_at ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  async findBySiteIdScoped(siteId, organizationId, pool) {
    const result = await pool.query(
      `SELECT pc.*,
              COALESCE(pc.father_name, m.father_name) AS father_name_resolved,
              COALESCE(NULLIF(TRIM(cu.name), ''), cu.email) AS created_by_name
         FROM plot_commissions pc
         JOIN sites s ON s.id = pc.site_id AND s.organization_id = $2
         LEFT JOIN LATERAL (
           SELECT father_name FROM members
            WHERE site_id = pc.site_id AND UPPER(full_name) = UPPER(pc.particular)
            LIMIT 1
         ) m ON true
         LEFT JOIN users cu ON cu.id = pc.created_by AND cu.organization_id = $2
        WHERE pc.site_id = $1
        ORDER BY pc.date ASC, pc.created_at ASC`,
      [siteId, organizationId],
    );
    return result.rows;
  }

  async findByIdScoped(id, siteId, organizationId, pool) {
    const result = await pool.query(
      `SELECT pc.*
         FROM plot_commissions pc
         JOIN sites s ON s.id = pc.site_id AND s.organization_id = $3
        WHERE pc.id = $1 AND pc.site_id = $2
        LIMIT 1`,
      [id, siteId, organizationId],
    );
    return result.rows[0];
  }

  async updateScoped(id, data, siteId, organizationId, pool) {
    const keys = Object.keys(data);
    const values = [...Object.values(data), id, siteId, organizationId];
    const setClause = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
    const idIndex = keys.length + 1;
    const siteIndex = keys.length + 2;
    const orgIndex = keys.length + 3;
    const result = await pool.query(
      `UPDATE plot_commissions pc
          SET ${setClause}
         FROM sites s
        WHERE pc.id = $${idIndex}
          AND pc.site_id = $${siteIndex}
          AND s.id = pc.site_id
          AND s.organization_id = $${orgIndex}
        RETURNING pc.*`,
      values,
    );
    return result.rows[0];
  }

  async deleteScoped(id, siteId, organizationId, pool) {
    const result = await pool.query(
      `DELETE FROM plot_commissions pc
        USING sites s
        WHERE pc.id = $1
          AND pc.site_id = $2
          AND s.id = pc.site_id
          AND s.organization_id = $3
        RETURNING pc.*`,
      [id, siteId, organizationId],
    );
    return result.rows[0];
  }

  async getSummaryScoped(siteId, organizationId, pool) {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total_entries,
              COALESCE(SUM(pc.amount), 0) AS total_amount,
              COUNT(DISTINCT pc.particular) AS unique_persons,
              COUNT(DISTINCT pc.plot_no) AS unique_plots
         FROM plot_commissions pc
         JOIN sites s ON s.id = pc.site_id AND s.organization_id = $2
        WHERE pc.site_id = $1
          AND LOWER(COALESCE(pc.status, '')) = 'approved'
          AND UPPER(COALESCE(pc.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')`,
      [siteId, organizationId],
    );
    return result.rows[0];
  }

  async getPersonSummaryScoped(siteId, organizationId, pool) {
    const result = await pool.query(
      `SELECT pc.particular, COUNT(*)::int AS entries,
              COALESCE(SUM(pc.amount), 0) AS total_amount
         FROM plot_commissions pc
         JOIN sites s ON s.id = pc.site_id AND s.organization_id = $2
        WHERE pc.site_id = $1
          AND LOWER(COALESCE(pc.status, '')) = 'approved'
          AND UPPER(COALESCE(pc.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
        GROUP BY pc.particular
        ORDER BY total_amount DESC`,
      [siteId, organizationId],
    );
    return result.rows;
  }

  async getUniqueParticularsScoped(siteId, organizationId, pool) {
    const result = await pool.query(
      `SELECT DISTINCT pc.particular
         FROM plot_commissions pc
         JOIN sites s ON s.id = pc.site_id AND s.organization_id = $2
        WHERE pc.site_id = $1
        ORDER BY pc.particular ASC`,
      [siteId, organizationId],
    );
    return result.rows.map((row) => row.particular);
  }

  async getUniquePlotsScoped(siteId, organizationId, pool) {
    const result = await pool.query(
      `SELECT DISTINCT pc.plot_no
         FROM plot_commissions pc
         JOIN sites s ON s.id = pc.site_id AND s.organization_id = $2
        WHERE pc.site_id = $1 AND pc.plot_no IS NOT NULL AND pc.plot_no <> ''
        ORDER BY pc.plot_no ASC`,
      [siteId, organizationId],
    );
    return result.rows.map((row) => row.plot_no);
  }

  /** Summary stats for a site */
  async getSummary(siteId, pool) {
    const query = `
      SELECT
        COUNT(*)::int AS total_entries,
        COALESCE(SUM(amount), 0) AS total_amount,
        COUNT(DISTINCT particular) AS unique_persons,
        COUNT(DISTINCT plot_no) AS unique_plots
      FROM plot_commissions
      WHERE site_id = $1
        AND LOWER(COALESCE(status, '')) = 'approved'
        AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows[0];
  }

  /** Get unique person names for a site (for autocomplete) */
  async getUniqueParticulars(siteId, pool) {
    const query = `
      SELECT DISTINCT particular FROM plot_commissions
      WHERE site_id = $1
      ORDER BY particular ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows.map((r) => r.particular);
  }

  /** Get unique plot numbers for a site (for autocomplete) */
  async getUniquePlots(siteId, pool) {
    const query = `
      SELECT DISTINCT plot_no FROM plot_commissions
      WHERE site_id = $1 AND plot_no IS NOT NULL AND plot_no != ''
      ORDER BY plot_no ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows.map((r) => r.plot_no);
  }

  /** Per-person breakdown */
  async getPersonSummary(siteId, pool) {
    const query = `
      SELECT
        particular,
        COUNT(*)::int AS entries,
        COALESCE(SUM(amount), 0) AS total_amount
      FROM plot_commissions
      WHERE site_id = $1
        AND LOWER(COALESCE(status, '')) = 'approved'
        AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      GROUP BY particular
      ORDER BY total_amount DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /** All commissions for a site on a specific date (for DayBook merge) */
  async findBySiteAndDate(siteId, date, pool) {
    const query = `
      SELECT pc.*,
             COALESCE(pc.father_name, m.father_name) AS father_name_resolved, u.name as assigned_admin_name
      FROM plot_commissions pc
      LEFT JOIN LATERAL (
        SELECT father_name FROM members
        WHERE site_id = pc.site_id AND UPPER(full_name) = UPPER(pc.particular)
        LIMIT 1
      ) m ON true
      LEFT JOIN users u ON pc.assigned_admin_id = u.id
      WHERE pc.site_id = $1 AND pc.date = $2
      ORDER BY pc.id ASC
    `;
    const result = await pool.query(query, [siteId, date]);
    return result.rows;
  }
}

export const plotCommissionModel = new PlotCommissionModel();
export default plotCommissionModel;
