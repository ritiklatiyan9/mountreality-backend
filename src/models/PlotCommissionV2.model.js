import MasterModel from './MasterModel.js';

class PlotCommissionV2Model extends MasterModel {
  constructor() {
    super('plot_commissions_v2');
  }

  /**
   * Get listing of commissions for a specific site, showing plot and agent details,
   * along with aggregated payment information.
   */
  async findBySiteIdWithDetails(siteId, pool) {
    const query = `
      SELECT
        pc.id, pc.site_id, pc.plot_id, pc.agent_id, pc.total_commission, p.commission_rate, pc.remarks, pc.status, pc.created_at,
        p.plot_no, p.plot_size, p.plot_rate, p.buyer_name, p.plot_tag,
        m.full_name AS agent_name, m.phone AS agent_phone,
        COALESCE(SUM(pcp.amount), 0) AS total_paid,
        (pc.total_commission - COALESCE(SUM(pcp.amount), 0)) AS balance
      FROM plot_commissions_v2 pc
      JOIN plots p ON pc.plot_id = p.id
      JOIN members m ON pc.agent_id = m.id
      LEFT JOIN plot_commission_payments pcp
        ON pc.id = pcp.plot_commission_id
        AND LOWER(COALESCE(pcp.status, 'approved')) = 'approved'
        AND UPPER(COALESCE(pcp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      WHERE pc.site_id = $1
      GROUP BY pc.id, p.id, m.id
      ORDER BY pc.created_at DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * Get details for a single commission entry.
   */
  async findByIdWithDetails(id, pool) {
    const query = `
      SELECT
        pc.*,
        p.plot_no, p.plot_size, p.plot_rate, p.buyer_name, p.commission_rate,
        m.full_name AS agent_name, m.phone AS agent_phone,
        COALESCE(SUM(pcp.amount) FILTER (WHERE LOWER(COALESCE(pcp.status, 'approved')) = 'approved'), 0) AS total_paid,
        COALESCE(SUM(pcp.amount) FILTER (WHERE LOWER(COALESCE(pcp.status, 'approved')) IN ('approved', 'pending')), 0) AS total_paid_all,
        (pc.total_commission - COALESCE(SUM(pcp.amount) FILTER (WHERE LOWER(COALESCE(pcp.status, 'approved')) = 'approved'), 0)) AS balance
      FROM plot_commissions_v2 pc
      JOIN plots p ON pc.plot_id = p.id
      JOIN members m ON pc.agent_id = m.id
      LEFT JOIN plot_commission_payments pcp
        ON pc.id = pcp.plot_commission_id
        AND UPPER(COALESCE(pcp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      WHERE pc.id = $1
      GROUP BY pc.id, p.id, m.id
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }

  /**
   * Check if a commission entry already exists for a specific plot and agent
   */
  async findByPlotAndAgent(plotId, agentId, pool) {
      const query = `SELECT * FROM plot_commissions_v2 WHERE plot_id = $1 AND agent_id = $2`;
      const result = await pool.query(query, [plotId, agentId]);
      return result.rows[0];
  }

  /**
   * Get one row per plot with latest agent info, all agent names, and aggregated financials.
   * Used for the list page (no OLD/NEW logic — one entry per plot).
   */
  async findBySiteIdGroupedByPlot(siteId, pool) {
    const query = `
      WITH commission_agg AS (
        SELECT
          pc.id,
          pc.site_id,
          pc.plot_id,
          pc.agent_id,
          pc.total_commission,
          pc.remarks,
          pc.status,
          pc.created_at,
          p.plot_no,
          p.plot_size,
          p.plot_rate,
          p.buyer_name,
          p.commission_rate,
          p.plot_tag,
          p.status AS plot_status,
          COALESCE(p.plot_commission, 0) AS plot_commission,
          m.full_name AS agent_name,
          m.phone AS agent_phone,
          COALESCE(SUM(pcp.amount), 0) AS total_paid,
          -- Cash vs bank split using the same classifier the Day Book / Farmers
          -- page apply: CASH-mode → cash_paid; everything else → bank_paid.
          COALESCE(SUM(CASE WHEN ledger_bucket(pcp.payment_mode) = 'cash' THEN pcp.amount ELSE 0 END), 0) AS cash_paid,
          COALESCE(SUM(CASE WHEN ledger_bucket(pcp.payment_mode) <> 'cash' THEN pcp.amount ELSE 0 END), 0) AS bank_paid,
          (pc.total_commission - COALESCE(SUM(pcp.amount), 0)) AS balance,
          ROW_NUMBER() OVER (PARTITION BY pc.plot_id ORDER BY pc.created_at DESC) AS rn
        FROM plot_commissions_v2 pc
        JOIN plots p ON pc.plot_id = p.id
        JOIN members m ON pc.agent_id = m.id
        LEFT JOIN plot_commission_payments pcp
          ON pc.id = pcp.plot_commission_id
          AND LOWER(COALESCE(pcp.status, 'approved')) = 'approved'
          AND UPPER(COALESCE(pcp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
        WHERE pc.site_id = $1
        GROUP BY pc.id, p.id, m.id
      ),
      plot_summary AS (
        SELECT
          ca.plot_id,
          ca.plot_no,
          ca.plot_size,
          ca.plot_rate,
          ca.buyer_name,
          ca.commission_rate,
          ca.plot_tag,
          ca.plot_status,
          ca.site_id,
          -- latest agent info (rn=1)
          MAX(CASE WHEN ca.rn = 1 THEN ca.id END) AS latest_commission_id,
          MAX(CASE WHEN ca.rn = 1 THEN ca.agent_name END) AS latest_agent_name,
          MAX(CASE WHEN ca.rn = 1 THEN ca.agent_phone END) AS latest_agent_phone,
          MAX(CASE WHEN ca.rn = 1 THEN ca.status END) AS latest_status,
          MAX(CASE WHEN ca.rn = 1 THEN ca.created_at END) AS latest_created_at,
          -- aggregate all agents for search
          STRING_AGG(DISTINCT ca.agent_name, ', ' ORDER BY ca.agent_name) AS all_agent_names,
          COUNT(DISTINCT ca.id) AS commission_count,
          -- Use fixed plot commission instead of summing per-agent commissions
          COALESCE(NULLIF(MAX(ca.plot_commission), 0), MAX(ca.total_commission)) AS total_commission,
          SUM(ca.total_paid) AS total_paid,
          SUM(ca.cash_paid) AS cash_paid,
          SUM(ca.bank_paid) AS bank_paid,
          COALESCE(NULLIF(MAX(ca.plot_commission), 0), MAX(ca.total_commission)) - SUM(ca.total_paid) AS balance
        FROM commission_agg ca
        GROUP BY ca.plot_id, ca.plot_no, ca.plot_size, ca.plot_rate, ca.buyer_name, ca.commission_rate, ca.plot_tag, ca.plot_status, ca.site_id
      )
      SELECT * FROM plot_summary
      ORDER BY plot_no ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * Get all commission entries for a specific plot with payment aggregates.
   * Used by the detail page to show agent history.
   */
  async findAllCommissionsByPlotId(plotId, siteId, pool) {
    const query = `
      SELECT
        pc.id, pc.site_id, pc.plot_id, pc.agent_id, pc.total_commission, pc.remarks, pc.status, pc.created_at,
        p.plot_no, p.plot_size, p.plot_rate, p.buyer_name, p.commission_rate, p.plot_tag,
        COALESCE(p.plot_commission, 0) AS plot_commission,
        s.name AS site_name,
        m.full_name AS agent_name, m.phone AS agent_phone,
        COALESCE(SUM(pcp.amount) FILTER (WHERE LOWER(COALESCE(pcp.status, 'approved')) = 'approved' AND UPPER(COALESCE(pcp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')), 0) AS total_paid,
        COALESCE(SUM(pcp.amount) FILTER (WHERE LOWER(COALESCE(pcp.status, 'approved')) IN ('approved', 'pending') AND UPPER(COALESCE(pcp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')), 0) AS total_paid_all,
        (pc.total_commission - COALESCE(SUM(pcp.amount) FILTER (WHERE LOWER(COALESCE(pcp.status, 'approved')) = 'approved' AND UPPER(COALESCE(pcp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')), 0)) AS balance
      FROM plot_commissions_v2 pc
      JOIN plots p ON pc.plot_id = p.id
      JOIN members m ON pc.agent_id = m.id
      JOIN sites s ON pc.site_id = s.id
      LEFT JOIN plot_commission_payments pcp ON pc.id = pcp.plot_commission_id
      WHERE pc.plot_id = $1 AND pc.site_id = $2
      GROUP BY pc.id, p.id, m.id, s.id
      ORDER BY pc.created_at ASC
    `;
    const result = await pool.query(query, [plotId, siteId]);
    return result.rows;
  }
}

class PlotCommissionPaymentModel extends MasterModel {
  constructor() {
    super('plot_commission_payments');
  }

  /**
   * Get all payments for a specific commission master record.
   */
  async findByCommissionId(commissionId, pool) {
    const query = `
      SELECT pcp.*, u.name AS created_by_name, a.name AS approved_by_name
      FROM plot_commission_payments pcp
      LEFT JOIN users u ON pcp.created_by = u.id
      LEFT JOIN users a ON pcp.approved_by = a.id
      WHERE pcp.plot_commission_id = $1
      ORDER BY pcp.date DESC, pcp.created_at DESC
    `;
    const result = await pool.query(query, [commissionId]);
    return result.rows;
  }
}

export const plotCommissionV2Model = new PlotCommissionV2Model();
export const plotCommissionPaymentModel = new PlotCommissionPaymentModel();
export default plotCommissionV2Model;
