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
