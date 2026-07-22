import MasterModel from './MasterModel.js';

// ── Day Book Model ──
class DayBookModel extends MasterModel {
  constructor() {
    super('day_book');
  }

  /**
   * All day book entries for a site, ordered by date DESC, id DESC
   */
  async findBySiteId(siteId, pool) {
    const query = `
      SELECT d.*, u.name as assigned_admin_name
      FROM day_book d
      LEFT JOIN users u ON d.assigned_admin_id = u.id
      WHERE d.site_id = $1
      ORDER BY d.date DESC, d.id DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * All day book entries ordered ASC for running-balance computation
   */
  async findBySiteIdAsc(siteId, pool) {
    const query = `
      SELECT d.*, u.name as assigned_admin_name
      FROM day_book d
      LEFT JOIN users u ON d.assigned_admin_id = u.id
      WHERE d.site_id = $1
      ORDER BY d.date ASC, d.id ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * Day book entries for a specific date (fast, indexed query)
   */
  async findBySiteAndDate(siteId, date, pool) {
    const query = `
      SELECT d.*, u.name as assigned_admin_name, approver.name as approved_by_name
      FROM day_book d
      LEFT JOIN users u ON d.assigned_admin_id = u.id
      LEFT JOIN users approver ON d.approved_by = approver.id
      WHERE d.site_id = $1 AND d.date = $2
      ORDER BY d.id ASC
    `;
    const result = await pool.query(query, [siteId, date]);
    return result.rows;
  }

  /**
   * Get day book entries filtered by entry type
   */
  async findByType(siteId, entryType, pool) {
    const query = `
      SELECT d.*, u.name as assigned_admin_name
      FROM day_book d
      LEFT JOIN users u ON d.assigned_admin_id = u.id
      WHERE d.site_id = $1 AND d.entry_type = $2
      ORDER BY d.date DESC, d.id DESC
    `;
    const result = await pool.query(query, [siteId, entryType]);
    return result.rows;
  }

  /**
   * Summary totals for a site
   */
  async getSummary(siteId, pool) {
    const query = `
      SELECT
        COALESCE(SUM(debit),  0)::numeric AS total_debit,
        COALESCE(SUM(credit), 0)::numeric AS total_credit,
        COUNT(*)::int AS total_count
      FROM day_book
      WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows[0];
  }

  /**
   * Breakdown by entry type
   */
  async getTypeBreakdown(siteId, pool) {
    const query = `
      SELECT
        entry_type,
        COALESCE(SUM(debit), 0)::numeric  AS total_debit,
        COALESCE(SUM(credit), 0)::numeric AS total_credit,
        COUNT(*)::int AS entries
      FROM day_book
      WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
      GROUP BY entry_type
      ORDER BY total_debit DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * Breakdown by payment mode
   */
  async getModeBreakdown(siteId, pool) {
    const query = `
      SELECT
        COALESCE(payment_mode, 'UNSPECIFIED') AS payment_mode,
        COALESCE(SUM(debit), 0)::numeric  AS total_debit,
        COALESCE(SUM(credit), 0)::numeric AS total_credit,
        COUNT(*)::int AS entries
      FROM day_book
      WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
      GROUP BY COALESCE(payment_mode, 'UNSPECIFIED')
      ORDER BY total_debit DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * Breakdown by category
   */
  async getCategoryBreakdown(siteId, pool) {
    const query = `
      SELECT
        COALESCE(category, 'UNCATEGORIZED') AS category,
        COALESCE(SUM(debit), 0)::numeric  AS total_debit,
        COALESCE(SUM(credit), 0)::numeric AS total_credit,
        COUNT(*)::int AS entries
      FROM day_book
      WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
      GROUP BY COALESCE(category, 'UNCATEGORIZED')
      ORDER BY total_debit DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * Autocomplete values
   */
  async getAutocomplete(siteId, pool) {
    const queries = {
      particulars: `SELECT DISTINCT particular   AS val FROM day_book WHERE site_id = $1 AND particular   IS NOT NULL AND particular   != '' ORDER BY val LIMIT 50`,
      fromEntities: `SELECT DISTINCT from_entity  AS val FROM day_book WHERE site_id = $1 AND from_entity  IS NOT NULL AND from_entity  != '' ORDER BY val LIMIT 50`,
      toEntities: `SELECT DISTINCT to_entity    AS val FROM day_book WHERE site_id = $1 AND to_entity    IS NOT NULL AND to_entity    != '' ORDER BY val LIMIT 50`,
      paymentModes: `SELECT DISTINCT payment_mode AS val FROM day_book WHERE site_id = $1 AND payment_mode IS NOT NULL AND payment_mode != '' ORDER BY val LIMIT 50`,
      remarks: `SELECT DISTINCT remarks      AS val FROM day_book WHERE site_id = $1 AND remarks      IS NOT NULL AND remarks      != '' ORDER BY val LIMIT 50`,
      accountNos: `SELECT DISTINCT account_no   AS val FROM day_book WHERE site_id = $1 AND account_no   IS NOT NULL AND account_no   != '' ORDER BY val LIMIT 50`,
      branches: `SELECT DISTINCT branch       AS val FROM day_book WHERE site_id = $1 AND branch       IS NOT NULL AND branch       != '' ORDER BY val LIMIT 50`,
      categories: `SELECT DISTINCT category     AS val FROM day_book WHERE site_id = $1 AND category     IS NOT NULL AND category     != '' ORDER BY val LIMIT 50`,
    };

    const keys = Object.keys(queries);
    const sqls = Object.values(queries);
    const rows = await Promise.all(sqls.map(sql => pool.query(sql, [siteId])));
    const results = {};
    keys.forEach((k, i) => { results[k] = rows[i].rows.map(r => r.val); });
    return results;
  }

  /**
   * Delete all entries for a site
   */
  async deleteBySiteId(siteId, pool) {
    const query = `DELETE FROM day_book WHERE site_id = $1`;
    await pool.query(query, [siteId]);
  }

  // ══════════════════════════════════════════════════
  //  APPROVAL WORKFLOW METHODS
  // ══════════════════════════════════════════════════

  /**
   * Find pending EXPENSE entries for approval
   */
  async findPendingExpenses(siteId, pool) {
    const query = siteId
      ? `
          SELECT d.*, s.name as site_name, c.name as created_by_name, u.name as assigned_admin_name
          FROM day_book d
          JOIN sites s ON d.site_id = s.id
          LEFT JOIN users c ON d.created_by = c.id
          LEFT JOIN users u ON d.assigned_admin_id = u.id
          WHERE d.status = 'pending' AND d.entry_type IN ('EXPENSE', 'FARMER PAYMENT', 'PLOT COMMISSION') AND d.site_id = $1
          ORDER BY d.date DESC, d.id DESC
        `
      : `
          SELECT d.*, s.name as site_name, c.name as created_by_name, u.name as assigned_admin_name
          FROM day_book d
          JOIN sites s ON d.site_id = s.id
          LEFT JOIN users c ON d.created_by = c.id
          LEFT JOIN users u ON d.assigned_admin_id = u.id
          WHERE d.status = 'pending' AND d.entry_type IN ('EXPENSE', 'FARMER PAYMENT', 'PLOT COMMISSION')
          ORDER BY d.date DESC, d.id DESC
        `;
    const result = siteId
      ? await pool.query(query, [siteId])
      : await pool.query(query);
    return result.rows;
  }

  /**
   * Find pending EXPENSE entries by date range
   */
  async findPendingByDateRange(siteId, dateFrom, dateTo, pool) {
    let query = `
      SELECT d.*, s.name as site_name, c.name as created_by_name, u.name as assigned_admin_name
      FROM day_book d
      JOIN sites s ON d.site_id = s.id
      LEFT JOIN users c ON d.created_by = c.id
      LEFT JOIN users u ON d.assigned_admin_id = u.id
      WHERE d.status = 'pending' AND d.entry_type IN ('EXPENSE', 'FARMER PAYMENT', 'PLOT COMMISSION')
    `;
    const params = [];
    let paramIndex = 1;

    if (siteId) {
      query += ` AND d.site_id = $${paramIndex++}`;
      params.push(siteId);
    }
    if (dateFrom) {
      query += ` AND d.date >= $${paramIndex++}`;
      params.push(dateFrom);
    }
    if (dateTo) {
      query += ` AND d.date <= $${paramIndex++}`;
      params.push(dateTo);
    }

    query += ` ORDER BY d.date DESC, d.id DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Approve a day_book entry
   */
  async approveEntry(id, approvedBy, pool) {
    const query = `
      UPDATE day_book
      SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const result = await pool.query(query, [id, approvedBy]);
    return result.rows[0];
  }

  /**
   * Reject a day_book entry
   */
  async rejectEntry(id, approvedBy, pool) {
    const query = `
      UPDATE day_book
      SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const result = await pool.query(query, [id, approvedBy]);
    return result.rows[0];
  }

  /**
   * Bulk approve day_book entries
   */
  async bulkApprove(ids, approvedBy, pool) {
    if (!ids.length) return [];
    const query = `
      UPDATE day_book
      SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = ANY($1::int[])
      RETURNING *
    `;
    const result = await pool.query(query, [ids, approvedBy]);
    return result.rows;
  }

  /**
   * Get counts by status for EXPENSE type
   */
  async getStatusCounts(siteId, pool) {
    const query = siteId
      ? `
          SELECT status, COUNT(*)::int as count
          FROM day_book
          WHERE site_id = $1 AND entry_type IN ('EXPENSE', 'FARMER PAYMENT', 'PLOT COMMISSION')
          GROUP BY status
        `
      : `
          SELECT status, COUNT(*)::int as count
          FROM day_book
          WHERE entry_type IN ('EXPENSE', 'FARMER PAYMENT', 'PLOT COMMISSION')
          GROUP BY status
        `;
    const result = siteId
      ? await pool.query(query, [siteId])
      : await pool.query(query);
    return result.rows;
  }

  /**
   * Find EXPENSE entries by status with optional date range
   */
  async findByStatus(status, siteId, dateFrom, dateTo, pool) {
    let query = `
      SELECT d.*, s.name as site_name, u.name as created_by_name, admin_u.name as assigned_admin_name,
             pp.booked_by
      FROM day_book d
      JOIN sites s ON d.site_id = s.id
      LEFT JOIN users u ON d.created_by = u.id
      LEFT JOIN users admin_u ON d.assigned_admin_id = admin_u.id
      LEFT JOIN plot_payments pp ON pp.id = d.plot_payment_id
      WHERE d.entry_type IN ('EXPENSE', 'FARMER PAYMENT', 'PLOT COMMISSION')
    `;
    const params = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      query += ` AND d.status = $${paramIndex++}`;
      params.push(status);
    }
    if (siteId) {
      query += ` AND d.site_id = $${paramIndex++}`;
      params.push(siteId);
    }
    if (dateFrom) {
      query += ` AND d.date >= $${paramIndex++}`;
      params.push(dateFrom);
    }
    if (dateTo) {
      query += ` AND d.date <= $${paramIndex++}`;
      params.push(dateTo);
    }

    query += ` ORDER BY d.date DESC, d.id DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }
}

export const dayBookModel = new DayBookModel();
