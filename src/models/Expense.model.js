import MasterModel from './MasterModel.js';

// ── Expense Model ──
class ExpenseModel extends MasterModel {
  constructor() {
    super('expenses');
  }

  /**
   * All expenses for a site, ordered by date DESC, id DESC
   */
  async findBySiteId(siteId, pool) {
    const query = `
      SELECT e.*, u.name as approved_by_name, admin_u.name as assigned_admin_name
      FROM expenses e
      LEFT JOIN users u ON e.approved_by = u.id
      LEFT JOIN users admin_u ON e.assigned_admin_id = admin_u.id
      WHERE e.site_id = $1
      ORDER BY e.date DESC, e.id DESC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * All expenses ordered ASC for running-balance computation
   */
  async findBySiteIdAsc(siteId, pool) {
    const query = `
      SELECT e.*, u.name as approved_by_name, admin_u.name as assigned_admin_name
      FROM expenses e
      LEFT JOIN users u ON e.approved_by = u.id
      LEFT JOIN users admin_u ON e.assigned_admin_id = admin_u.id
      WHERE e.site_id = $1
      ORDER BY e.date ASC, e.id ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /**
   * All pending expenses for approval (admin-only, across all sites or specific site)
   */
  async findPendingExpenses(siteId, pool) {
    const query = siteId
      ? `
          SELECT e.*, s.name as site_name, c.name as created_by_name, admin_u.name as assigned_admin_name
          FROM expenses e
          JOIN sites s ON e.site_id = s.id
          LEFT JOIN users c ON e.created_by = c.id
          LEFT JOIN users admin_u ON e.assigned_admin_id = admin_u.id
          WHERE e.status = 'pending' AND e.site_id = $1
          ORDER BY e.date DESC, e.id DESC
        `
      : `
          SELECT e.*, s.name as site_name, c.name as created_by_name, admin_u.name as assigned_admin_name
          FROM expenses e
          JOIN sites s ON e.site_id = s.id
          LEFT JOIN users c ON e.created_by = c.id
          LEFT JOIN users admin_u ON e.assigned_admin_id = admin_u.id
          WHERE e.status = 'pending'
          ORDER BY e.date DESC, e.id DESC
        `;
    const result = siteId
      ? await pool.query(query, [siteId])
      : await pool.query(query);
    return result.rows;
  }

  /**
   * Find pending expenses by date range
   */
  async findPendingByDateRange(siteId, dateFrom, dateTo, pool) {
    let query = `
      SELECT e.*, s.name as site_name, c.name as created_by_name, admin_u.name as assigned_admin_name
      FROM expenses e
      JOIN sites s ON e.site_id = s.id
      LEFT JOIN users c ON e.created_by = c.id
      LEFT JOIN users admin_u ON e.assigned_admin_id = admin_u.id
      WHERE e.status = 'pending'
    `;
    const params = [];
    let paramIndex = 1;

    if (siteId) {
      query += ` AND e.site_id = $${paramIndex++}`;
      params.push(siteId);
    }
    if (dateFrom) {
      query += ` AND e.date >= $${paramIndex++}`;
      params.push(dateFrom);
    }
    if (dateTo) {
      query += ` AND e.date <= $${paramIndex++}`;
      params.push(dateTo);
    }

    query += ` ORDER BY e.date DESC, e.id DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Approve an expense
   */
  async approveExpense(expenseId, approvedBy, pool) {
    const query = `
      UPDATE expenses
      SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const result = await pool.query(query, [expenseId, approvedBy]);
    return result.rows[0];
  }

  /**
   * Reject an expense
   */
  async rejectExpense(expenseId, approvedBy, pool) {
    const query = `
      UPDATE expenses
      SET status = 'rejected', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const result = await pool.query(query, [expenseId, approvedBy]);
    return result.rows[0];
  }

  /**
   * Bulk approve expenses
   */
  async bulkApprove(expenseIds, approvedBy, pool) {
    if (!expenseIds.length) return [];
    const query = `
      UPDATE expenses
      SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = ANY($1::int[])
      RETURNING *
    `;
    const result = await pool.query(query, [expenseIds, approvedBy]);
    return result.rows;
  }

  /**
   * Get counts by status for a site
   */
  async getStatusCounts(siteId, pool) {
    const query = siteId
      ? `
          SELECT status, COUNT(*)::int as count
          FROM expenses
          WHERE site_id = $1
          GROUP BY status
        `
      : `
          SELECT status, COUNT(*)::int as count
          FROM expenses
          GROUP BY status
        `;
    const result = siteId
      ? await pool.query(query, [siteId])
      : await pool.query(query);
    return result.rows;
  }

  /**
   * Find expenses by status with optional date range
   */
  async findByStatus(status, siteId, dateFrom, dateTo, pool) {
    let query = `
      SELECT e.*, s.name as site_name, u.name as created_by_name, admin_u.name as assigned_admin_name
      FROM expenses e
      JOIN sites s ON e.site_id = s.id
      LEFT JOIN users u ON e.created_by = u.id
      LEFT JOIN users admin_u ON e.assigned_admin_id = admin_u.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      query += ` AND e.status = $${paramIndex++}`;
      params.push(status);
    }
    if (siteId) {
      query += ` AND e.site_id = $${paramIndex++}`;
      params.push(siteId);
    }
    if (dateFrom) {
      query += ` AND e.date >= $${paramIndex++}`;
      params.push(dateFrom);
    }
    if (dateTo) {
      query += ` AND e.date <= $${paramIndex++}`;
      params.push(dateTo);
    }

    query += ` ORDER BY e.date DESC, e.id DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Expenses for a specific date (fast, indexed query)
   */
  async findBySiteAndDate(siteId, date, pool) {
    const query = `
      SELECT e.*, u.name as approved_by_name, admin_u.name as assigned_admin_name
      FROM expenses e
      LEFT JOIN users u ON e.approved_by = u.id
      LEFT JOIN users admin_u ON e.assigned_admin_id = admin_u.id
      WHERE e.site_id = $1 AND e.date = $2
      ORDER BY e.id ASC
    `;
    const result = await pool.query(query, [siteId, date]);
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
      FROM expenses
      WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows[0];
  }

  /**
   * Breakdown by payment_mode
   */
  async getModeBreakdown(siteId, pool) {
    const query = `
      SELECT
        COALESCE(payment_mode, 'UNSPECIFIED') AS payment_mode,
        COALESCE(SUM(debit), 0)::numeric  AS total_debit,
        COALESCE(SUM(credit), 0)::numeric AS total_credit,
        COUNT(*)::int AS entries
      FROM expenses
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
      FROM expenses
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
      fromEntities: `SELECT DISTINCT from_entity  AS val FROM expenses WHERE site_id = $1 AND from_entity  IS NOT NULL AND from_entity  != '' ORDER BY val`,
      toEntities: `SELECT DISTINCT to_entity    AS val FROM expenses WHERE site_id = $1 AND to_entity    IS NOT NULL AND to_entity    != '' ORDER BY val`,
      paymentModes: `SELECT DISTINCT payment_mode AS val FROM expenses WHERE site_id = $1 AND payment_mode IS NOT NULL AND payment_mode != '' ORDER BY val`,
      remarks: `SELECT DISTINCT remark       AS val FROM expenses WHERE site_id = $1 AND remark       IS NOT NULL AND remark       != '' ORDER BY val`,
      accountNos: `SELECT DISTINCT account_no   AS val FROM expenses WHERE site_id = $1 AND account_no   IS NOT NULL AND account_no   != '' ORDER BY val`,
      branches: `SELECT DISTINCT branch       AS val FROM expenses WHERE site_id = $1 AND branch       IS NOT NULL AND branch       != '' ORDER BY val`,
      categories: `SELECT DISTINCT category     AS val FROM expenses WHERE site_id = $1 AND category     IS NOT NULL AND category     != '' ORDER BY val`,
    };

    const keys = Object.keys(queries);
    const sqls = Object.values(queries);
    const rows = await Promise.all(sqls.map(sql => pool.query(sql, [siteId])));
    const results = {};
    keys.forEach((k, i) => { results[k] = rows[i].rows.map(r => r.val); });
    return results;
  }

  // ══════════════════════════════════════════════════
  //  UNIFIED QUERIES (Expenses + Day Book)
  // ══════════════════════════════════════════════════

  /**
   * Complex Paginated Unified query for fetching merged expenses & day_book
   * Calculates running balance dynamically across both tables.
   */
  async findPaginatedUnified(siteId, filters, page = 1, limit = 20, pool) {
    const { search, mode, category, categories, to_entity, dateFrom, dateTo, missing_bill, order = 'desc', only_site } = filters;
    const offset = (Math.max(1, page) - 1) * limit;
    const sortDir = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // ── Build WHERE clause once, reuse across queries ──
    const params = [siteId];
    let pIdx = 2;
    let whereClause = '';

    if (only_site === 'true') { whereClause += ` AND u.source = 'expenses'`; }
    if (mode) {
      if (mode === 'UNSPECIFIED') {
        whereClause += ` AND (u.payment_mode IS NULL OR u.payment_mode = '')`;
      } else {
        whereClause += ` AND u.payment_mode = $${pIdx++}`; params.push(mode);
      }
    }
    // Multi-category filter (AND-combined ILIKE). When set, overrides legacy single `category`.
    if (Array.isArray(categories) && categories.length > 0) {
      for (const token of categories) {
        const trimmed = String(token).trim();
        if (!trimmed) continue;
        if (trimmed.toUpperCase() === 'UNCATEGORIZED') {
          whereClause += ` AND (u.category IS NULL OR u.category = '')`;
        } else {
          whereClause += ` AND u.category ILIKE $${pIdx}`;
          params.push(`%${trimmed}%`);
          pIdx++;
        }
      }
    } else if (category) {
      if (category === 'UNCATEGORIZED') {
        whereClause += ` AND (u.category IS NULL OR u.category = '')`;
      } else {
        whereClause += ` AND u.category = $${pIdx++}`; params.push(category);
      }
    }
    if (to_entity) { whereClause += ` AND u.to_entity = $${pIdx++}`; params.push(to_entity); }
    if (dateFrom) { whereClause += ` AND u.date >= $${pIdx++}`; params.push(dateFrom); }
    if (dateTo) { whereClause += ` AND u.date <= $${pIdx++}`; params.push(dateTo); }
    if (search) {
      whereClause += ` AND (u.from_entity ILIKE $${pIdx} OR u.to_entity ILIKE $${pIdx} OR u.remark ILIKE $${pIdx} OR u.account_no ILIKE $${pIdx} OR u.branch ILIKE $${pIdx} OR u.category ILIKE $${pIdx})`;
      params.push(`%${search}%`);
      pIdx++;
    }
    if (missing_bill === 'true') {
      whereClause += ` AND ledger_bucket(u.payment_mode) <> 'cash' AND (u.bill_url IS NULL OR u.bill_url = '')`;
    }

    const filterParams = [...params]; // snapshot before LIMIT/OFFSET

    // ── Unified CTE fragment (reused) ──
    // Queries operational expense source tables directly (farmer payments,
    // commissions and vendors) to stay consistent with dashboard KPI totals.
    // NOTE: plot_registry_payments EXCLUDED — they are just mapped plot payments, not new expenses.
    const unifiedCTE = `
      WITH unified AS (
        SELECT 
          id::text as virtual_id, id as original_id, site_id, date, from_entity, to_entity, 
          payment_mode, debit, credit, remark, account_no, branch, category, 
          status, approved_by, approved_at, created_by, created_at, updated_at, 
          assigned_user_id, assigned_admin_id, voucher_url, bill_url, customer_signature_url, authority_signature_url,
          'expenses' as source
        FROM expenses
        WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
        
        UNION ALL

        SELECT 
          'fp_' || fp.id as virtual_id, fp.id as original_id, f.site_id, fp.date,
          NULL as from_entity, UPPER(f.name) as to_entity,
          fp.payment_mode, fp.amount as debit, 0::numeric as credit,
          UPPER(f.name) || ' - FARMER PAYMENT' || CASE WHEN fp.remarks IS NOT NULL AND fp.remarks != '' THEN ' - ' || fp.remarks ELSE '' END as remark,
          fp.bank_account_no as account_no, fp.bank_ifsc as branch, 'FARMER PAYMENT' as category,
          fp.status, fp.approved_by, fp.approved_at, fp.created_by, fp.created_at, fp.updated_at,
          NULL::int as assigned_user_id, fp.assigned_admin_id, fp.voucher_url, NULL as bill_url, NULL as customer_signature_url, NULL as authority_signature_url,
          'farmer_payment' as source
        FROM farmer_payments fp
        JOIN farmers f ON f.id = fp.farmer_id
        WHERE f.site_id = $1 AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))

        UNION ALL

        SELECT 
          'pcp_' || pcp.id as virtual_id, pcp.id as original_id, pcp.site_id, pcp.date,
          NULL as from_entity, UPPER(ag.full_name) as to_entity,
          pcp.payment_mode, pcp.amount as debit, 0::numeric as credit,
          UPPER(ag.full_name) || COALESCE(' (Plot: ' || p.plot_no || ')', '') || ' - COMMISSION' || CASE WHEN pcp.remarks IS NOT NULL AND pcp.remarks != '' THEN ' - ' || pcp.remarks ELSE '' END as remark,
          NULL as account_no, NULL as branch, 'COMMISSION' as category,
          pcp.status, pcp.approved_by, pcp.approved_at, pcp.created_by, pcp.created_at, pcp.updated_at,
          NULL::int as assigned_user_id, pcp.assigned_admin_id, pcp.voucher_url, NULL as bill_url, NULL as customer_signature_url, NULL as authority_signature_url,
          'commission' as source
        FROM plot_commission_payments pcp
        JOIN plot_commissions_v2 pcm ON pcp.plot_commission_id = pcm.id
        JOIN plots p ON pcm.plot_id = p.id
        JOIN members ag ON pcm.agent_id = ag.id
        WHERE pcp.site_id = $1 AND (pcp.cheque_status IS NULL OR pcp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))

        UNION ALL

        SELECT 
          'vp_' || vp.id as virtual_id, vp.id as original_id, vp.site_id, vp.payment_date as date,
          NULL as from_entity, UPPER(vc.vendor_name) as to_entity,
          UPPER(vp.payment_mode) as payment_mode, vp.amount as debit, 0::numeric as credit,
          UPPER(vc.vendor_name) || ' - VENDOR PAYMENT' || CASE WHEN vp.note IS NOT NULL AND vp.note != '' THEN ' - ' || vp.note ELSE '' END as remark,
          NULL as account_no, NULL as branch, 'VENDOR PAYMENT' as category,
          vp.status, vp.approved_by, vp.approved_at, vp.created_by, vp.created_at, vp.created_at as updated_at,
          NULL::int as assigned_user_id, vp.assigned_admin_id, vp.voucher_url, NULL as bill_url, NULL as customer_signature_url, NULL as authority_signature_url,
          'vendor_payment' as source
        FROM vendor_payments vp
        JOIN vendor_commitments vc ON vp.commitment_id = vc.id
        WHERE vp.site_id = $1 AND (vp.cheque_status IS NULL OR vp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))

        UNION ALL

        SELECT 
          'db_' || d.id as virtual_id, d.id as original_id, d.site_id, d.date,
          d.from_entity, d.to_entity,
          d.payment_mode, d.debit, d.credit,
          d.particular || CASE WHEN d.remarks IS NOT NULL AND d.remarks != '' THEN ' - ' || d.remarks ELSE '' END as remark,
          d.account_no, d.branch, d.category,
          d.status, d.approved_by, d.approved_at, d.created_by, d.created_at, d.updated_at,
          d.assigned_user_id, d.assigned_admin_id, d.voucher_url, NULL as bill_url, NULL as customer_signature_url, NULL as authority_signature_url,
          'daybook' as source
        FROM day_book d
        WHERE d.site_id = $1 AND d.entry_type = 'EXPENSE'
          AND d.farmer_payment_id IS NULL AND d.commission_id IS NULL AND d.vendor_payment_id IS NULL
          AND (d.cheque_status IS NULL OR d.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
      )
    `;

    // ── Q1: Data ──
    let dataQuery = `
      ${unifiedCTE}
      SELECT u.*,
             us.name as approved_by_name,
             m.full_name as assigned_user_name,
             admin_u.name as assigned_admin_name,
             COALESCE(NULLIF(TRIM(cu.name), ''), cu.email) AS created_by_name
      FROM unified u
      LEFT JOIN users us ON u.approved_by = us.id
      LEFT JOIN members m ON u.assigned_user_id = m.id
      LEFT JOIN users admin_u ON u.assigned_admin_id = admin_u.id
      LEFT JOIN users cu ON cu.id = u.created_by
      WHERE 1=1 ${whereClause}
      ORDER BY u.date ${sortDir}, u.created_at ${sortDir},
               CASE WHEN u.source = 'daybook' THEN 1 ELSE 0 END ${sortDir}, 
               u.original_id ${sortDir}
    `;
    const dataParams = [...params];
    if (limit > 0) {
      dataQuery += ` LIMIT $${pIdx++} OFFSET $${pIdx++}`;
      dataParams.push(limit, offset);
    }

    // ── Q2: Count (lightweight) ──
    const countQuery = `
      ${unifiedCTE}
      SELECT COUNT(*)::int as total
      FROM unified u
      WHERE 1=1 ${whereClause}
    `;

    // ── Q3: Posted summary aggregates ──
    // cash_debit / bank_debit etc. split totals by payment mode so the page
    // can render Cash-vs-Bank flow cards with the same classifier the Day
    // Book uses (explicit CASH → cash; everything else → bank).
    const summaryQuery = `
      ${unifiedCTE}
      SELECT
        COALESCE(SUM(debit), 0)::numeric as total_debit,
        COALESCE(SUM(credit), 0)::numeric as total_credit,
        COALESCE(SUM(CASE WHEN ledger_bucket(payment_mode) = 'cash' THEN debit ELSE 0 END), 0)::numeric as cash_debit,
        COALESCE(SUM(CASE WHEN ledger_bucket(payment_mode) = 'cash' THEN credit ELSE 0 END), 0)::numeric as cash_credit,
        COALESCE(SUM(CASE WHEN ledger_bucket(payment_mode) <> 'cash' THEN debit ELSE 0 END), 0)::numeric as bank_debit,
        COALESCE(SUM(CASE WHEN ledger_bucket(payment_mode) <> 'cash' THEN credit ELSE 0 END), 0)::numeric as bank_credit,
        COUNT(*)::int as total_count
      FROM unified u
      WHERE 1=1 ${whereClause}
        AND LOWER(COALESCE(u.status, 'approved')) = 'approved'
    `;

    // ── Run all 3 in parallel ──
    const [dataResult, countResult, summaryResult] = await Promise.all([
      pool.query(dataQuery, dataParams),
      pool.query(countQuery, filterParams),
      pool.query(summaryQuery, filterParams),
    ]);

    return {
      items: dataResult.rows.map(row => {
        const { virtual_id, ...rest } = row;
        return { ...rest, id: virtual_id };
      }),
      summary: summaryResult.rows[0],
      totalItems: countResult.rows[0]?.total || 0
    };
  }

  /**
   * Unified Breakdown stats based on the active filters
   */
  async getUnifiedBreakdowns(siteId, filters, pool) {
    const { search, mode, category, categories, to_entity, dateFrom, dateTo, only_site } = filters;
    const params = [siteId];
    let pIdx = 2;
    let whereClause = '';

    if (mode) {
      if (mode === 'UNSPECIFIED') {
        whereClause += ` AND (u.payment_mode IS NULL OR u.payment_mode = '')`;
      } else {
        whereClause += ` AND u.payment_mode = $${pIdx++}`; params.push(mode);
      }
    }
    if (Array.isArray(categories) && categories.length > 0) {
      for (const token of categories) {
        const trimmed = String(token).trim();
        if (!trimmed) continue;
        if (trimmed.toUpperCase() === 'UNCATEGORIZED') {
          whereClause += ` AND (u.category IS NULL OR u.category = '')`;
        } else {
          whereClause += ` AND u.category ILIKE $${pIdx}`;
          params.push(`%${trimmed}%`);
          pIdx++;
        }
      }
    } else if (category) {
      if (category === 'UNCATEGORIZED') {
        whereClause += ` AND (u.category IS NULL OR u.category = '')`;
      } else {
        whereClause += ` AND u.category = $${pIdx++}`; params.push(category);
      }
    }
    if (to_entity) { whereClause += ` AND u.to_entity = $${pIdx++}`; params.push(to_entity); }
    if (dateFrom) { whereClause += ` AND u.date >= $${pIdx++}`; params.push(dateFrom); }
    if (dateTo) { whereClause += ` AND u.date <= $${pIdx++}`; params.push(dateTo); }
    if (search) {
      whereClause += ` AND (u.from_entity ILIKE $${pIdx} OR u.to_entity ILIKE $${pIdx} OR u.remark ILIKE $${pIdx} OR u.account_no ILIKE $${pIdx} OR u.branch ILIKE $${pIdx} OR u.category ILIKE $${pIdx})`;
      params.push(`%${search}%`);
      pIdx++;
    }

    // When only_site=true, use simplified queries against expenses table only
    if (only_site === 'true') {
      const modeQ = `
        SELECT COALESCE(payment_mode, 'UNSPECIFIED') as payment_mode,
          COALESCE(SUM(debit), 0)::numeric as total_debit,
          COALESCE(SUM(credit), 0)::numeric as total_credit,
          COUNT(*)::int as entries
        FROM (
          SELECT payment_mode, debit, credit, date, from_entity, to_entity, remark, account_no, branch, category
          FROM expenses WHERE site_id = $1
            AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
            AND LOWER(COALESCE(status, 'approved')) = 'approved'
        ) u WHERE 1=1 ${whereClause}
        GROUP BY COALESCE(payment_mode, 'UNSPECIFIED') ORDER BY total_debit DESC`;
      const catQ = `
        SELECT COALESCE(category, 'UNCATEGORIZED') as category,
          COALESCE(SUM(debit), 0)::numeric as total_debit,
          COALESCE(SUM(credit), 0)::numeric as total_credit,
          COUNT(*)::int as entries
        FROM (
          SELECT payment_mode, debit, credit, date, from_entity, to_entity, remark, account_no, branch, category
          FROM expenses WHERE site_id = $1
            AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
            AND LOWER(COALESCE(status, 'approved')) = 'approved'
        ) u WHERE 1=1 ${whereClause}
        GROUP BY COALESCE(category, 'UNCATEGORIZED') ORDER BY category ASC`;
      const [modeRes, catRes] = await Promise.all([
        pool.query(modeQ, params),
        pool.query(catQ, params)
      ]);
      return { modeBreakdown: modeRes.rows, categoryBreakdown: catRes.rows };
    }

    // Combine BOTH breakdowns into a SINGLE query using GROUPING SETS.
    // Previously: same heavy 6-table UNION executed TWICE in parallel.
    // Now: ONE execution scans the unified data once, and PostgreSQL
    // computes both groupings using GROUPING SETS.
    const combinedQuery = `
      WITH unified AS (
        SELECT date, payment_mode, category, to_entity, from_entity, remark, account_no, branch, debit, credit
        FROM expenses WHERE site_id = $1
          AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          AND LOWER(COALESCE(status, 'approved')) = 'approved'
        UNION ALL
        SELECT fp.date, fp.payment_mode, 'FARMER PAYMENT' as category, UPPER(f.name) as to_entity, NULL as from_entity,
          UPPER(f.name) || ' - FARMER PAYMENT' as remark, fp.bank_account_no as account_no, fp.bank_ifsc as branch, fp.amount as debit, 0::numeric as credit
        FROM farmer_payments fp JOIN farmers f ON f.id = fp.farmer_id
        WHERE f.site_id = $1
          AND UPPER(COALESCE(fp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          AND LOWER(COALESCE(fp.status, 'approved')) = 'approved'
        UNION ALL
        SELECT pcp.date, pcp.payment_mode, 'COMMISSION' as category, UPPER(ag.full_name) as to_entity, NULL as from_entity,
          UPPER(ag.full_name) || ' - COMMISSION' as remark, NULL as account_no, NULL as branch, pcp.amount as debit, 0::numeric as credit
        FROM plot_commission_payments pcp
        JOIN plot_commissions_v2 pcm ON pcp.plot_commission_id = pcm.id
        JOIN members ag ON pcm.agent_id = ag.id
        WHERE pcp.site_id = $1
          AND UPPER(COALESCE(pcp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          AND LOWER(COALESCE(pcp.status, 'approved')) = 'approved'
        UNION ALL
        SELECT vp.payment_date as date, UPPER(vp.payment_mode) as payment_mode, 'VENDOR PAYMENT' as category, UPPER(vc.vendor_name) as to_entity, NULL as from_entity,
          UPPER(vc.vendor_name) || ' - VENDOR PAYMENT' as remark, NULL as account_no, NULL as branch, vp.amount as debit, 0::numeric as credit
        FROM vendor_payments vp JOIN vendor_commitments vc ON vp.commitment_id = vc.id
        WHERE vp.site_id = $1
          AND UPPER(COALESCE(vp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          AND LOWER(COALESCE(vp.status, 'approved')) = 'approved'
        UNION ALL
        SELECT d.date, d.payment_mode, d.category, d.to_entity, d.from_entity, d.particular as remark, d.account_no, d.branch, d.debit, d.credit
        FROM day_book d WHERE d.site_id = $1 AND d.entry_type = 'EXPENSE'
          AND d.farmer_payment_id IS NULL AND d.commission_id IS NULL AND d.vendor_payment_id IS NULL
          AND UPPER(COALESCE(d.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          AND LOWER(COALESCE(d.status, 'approved')) = 'approved'
      ),
      filtered AS (
        SELECT
          COALESCE(payment_mode, 'UNSPECIFIED') AS pm,
          COALESCE(category, 'UNCATEGORIZED') AS cat,
          debit, credit
        FROM unified u WHERE 1=1 ${whereClause}
      )
      -- GROUPING SETS lets PostgreSQL compute mode-totals AND category-totals
      -- in a single pass over the unified data. The CASE on GROUPING() tags
      -- each row as 'mode' or 'category' so the JS layer can split them.
      SELECT
        CASE WHEN GROUPING(cat) = 1 THEN 'mode' ELSE 'category' END AS bucket,
        pm AS payment_mode,
        cat AS category,
        COALESCE(SUM(debit), 0)::numeric AS total_debit,
        COALESCE(SUM(credit), 0)::numeric AS total_credit,
        COUNT(*)::int AS entries
      FROM filtered
      GROUP BY GROUPING SETS ((pm), (cat))
    `;

    const combinedRes = await pool.query(combinedQuery, params);
    const modeBreakdown = [];
    const categoryBreakdown = [];
    for (const row of combinedRes.rows) {
      if (row.bucket === 'mode') {
        modeBreakdown.push({
          payment_mode: row.payment_mode,
          total_debit: row.total_debit,
          total_credit: row.total_credit,
          entries: row.entries,
        });
      } else {
        categoryBreakdown.push({
          category: row.category,
          total_debit: row.total_debit,
          total_credit: row.total_credit,
          entries: row.entries,
        });
      }
    }
    // Match the previous sort order (mode by total_debit DESC, category by name ASC).
    modeBreakdown.sort((a, b) => parseFloat(b.total_debit) - parseFloat(a.total_debit));
    categoryBreakdown.sort((a, b) => a.category.localeCompare(b.category));

    return { modeBreakdown, categoryBreakdown };
  }
}

export const expenseModel = new ExpenseModel();
