import MasterModel from './MasterModel.js';

// ── Firm Model ──
class FirmModel extends MasterModel {
  constructor() {
    super('firms');
  }

  /** All firms for a site with transaction stats (includes cashflow entries referencing the firm).
   *  Previously this ran SIX scalar subqueries PER ROW — three on
   *  firm_transactions and three on cash_flow_entries. With 5 firms that's
   *  30+ subqueries on every page load.
   *
   *  Now: two LATERAL aggregations (one per source table) that scan once
   *  per firm and use FILTER clauses for the cheque/status conditions. */
  async findBySiteId(siteId, pool) {
    const query = `
      SELECT f.*,
        COALESCE(ft_agg.ft_debit,  0) + COALESCE(cf_agg.cf_debit,  0) AS total_debit,
        COALESCE(ft_agg.ft_credit, 0) + COALESCE(cf_agg.cf_credit, 0) AS total_credit,
        COALESCE(ft_agg.ft_count,  0) + COALESCE(cf_agg.cf_count,  0) AS txn_count
      FROM firms f
      LEFT JOIN LATERAL (
        SELECT
          SUM(ft.debit) FILTER (WHERE LOWER(COALESCE(ft.status, 'approved')) = 'approved' AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')) AS ft_debit,
          SUM(ft.credit) FILTER (WHERE LOWER(COALESCE(ft.status, 'approved')) = 'approved' AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')) AS ft_credit,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(ft.status, 'approved')) = 'approved' AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))::int AS ft_count
        FROM firm_transactions ft
        WHERE ft.firm_id = f.id
      ) ft_agg ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          SUM(COALESCE(cfe.debit, 0) + COALESCE(cfe.credit, 0)) FILTER (
            WHERE cfe.from_firm_id = f.id
              AND cfe.is_firm_transaction = TRUE
              AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
              AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
          ) AS cf_debit,
          SUM(COALESCE(cfe.debit, 0) + COALESCE(cfe.credit, 0)) FILTER (
            WHERE cfe.to_firm_id = f.id
              AND cfe.is_firm_transaction = TRUE
              AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
              AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
          ) AS cf_credit,
          COUNT(*) FILTER (
            WHERE (cfe.from_firm_id = f.id OR cfe.to_firm_id = f.id)
              AND cfe.is_firm_transaction = TRUE
              AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
              AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          )::int AS cf_count
        FROM cash_flow_entries cfe
        WHERE (cfe.from_firm_id = f.id OR cfe.to_firm_id = f.id)
          AND cfe.is_firm_transaction = TRUE
      ) cf_agg ON TRUE
      WHERE f.site_id = $1
      ORDER BY f.name ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /** Find firm by name within a site (for duplicate check) */
  async findByName(siteId, name, pool) {
    const query = `SELECT * FROM firms WHERE site_id = $1 AND UPPER(name) = UPPER($2)`;
    const result = await pool.query(query, [siteId, name]);
    return result.rows[0];
  }

  /** Get firm with totals (single firm — same LATERAL pattern as findBySiteId) */
  async findByIdWithTotals(id, pool) {
    const query = `
      SELECT f.*,
        COALESCE(ft_agg.ft_debit,  0) + COALESCE(cf_agg.cf_debit,  0) AS total_debit,
        COALESCE(ft_agg.ft_credit, 0) + COALESCE(cf_agg.cf_credit, 0) AS total_credit,
        COALESCE(ft_agg.ft_count,  0) + COALESCE(cf_agg.cf_count,  0) AS txn_count
      FROM firms f
      LEFT JOIN LATERAL (
        SELECT
          SUM(ft.debit) FILTER (WHERE LOWER(COALESCE(ft.status, 'approved')) = 'approved' AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')) AS ft_debit,
          SUM(ft.credit) FILTER (WHERE LOWER(COALESCE(ft.status, 'approved')) = 'approved' AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')) AS ft_credit,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(ft.status, 'approved')) = 'approved' AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED'))::int AS ft_count
        FROM firm_transactions ft
        WHERE ft.firm_id = f.id
      ) ft_agg ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          SUM(COALESCE(cfe.debit, 0) + COALESCE(cfe.credit, 0)) FILTER (
            WHERE cfe.from_firm_id = f.id
              AND cfe.is_firm_transaction = TRUE
              AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
              AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
          ) AS cf_debit,
          SUM(COALESCE(cfe.debit, 0) + COALESCE(cfe.credit, 0)) FILTER (
            WHERE cfe.to_firm_id = f.id
              AND cfe.is_firm_transaction = TRUE
              AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
              AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
          ) AS cf_credit,
          COUNT(*) FILTER (
            WHERE (cfe.from_firm_id = f.id OR cfe.to_firm_id = f.id)
              AND cfe.is_firm_transaction = TRUE
              AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
              AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          )::int AS cf_count
        FROM cash_flow_entries cfe
        WHERE (cfe.from_firm_id = f.id OR cfe.to_firm_id = f.id)
          AND cfe.is_firm_transaction = TRUE
      ) cf_agg ON TRUE
      WHERE f.id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }
}

// ── Firm Transaction Model ──
class FirmTransactionModel extends MasterModel {
  constructor() {
    super('firm_transactions');
  }

  /** All transactions for a firm, ordered by date ASC */
  async findByFirmId(firmId, pool) {
    const query = `
      SELECT * FROM firm_transactions
      WHERE firm_id = $1
      ORDER BY date ASC, created_at ASC
    `;
    const result = await pool.query(query, [firmId]);
    return result.rows;
  }

  /** Summary for a firm (includes cashflow entries referencing the firm).
   *  Single round-trip combining both source tables — was 2 serial queries. */
  async getFirmSummary(firmId, pool) {
    const result = await pool.query(
      `
      WITH ft_agg AS (
        SELECT
          COUNT(*)::int AS ft_count,
          COALESCE(SUM(debit), 0)  AS ft_debit,
          COALESCE(SUM(credit), 0) AS ft_credit
        FROM firm_transactions
        WHERE firm_id = $1
          AND LOWER(COALESCE(status, 'approved')) = 'approved'
          AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      ),
      cf_agg AS (
        SELECT
          COUNT(*)::int AS cf_count,
          COALESCE(SUM(CASE WHEN from_firm_id = $1 THEN COALESCE(debit, 0) + COALESCE(credit, 0) ELSE 0 END), 0) AS cf_debit,
          COALESCE(SUM(CASE WHEN to_firm_id   = $1 THEN COALESCE(debit, 0) + COALESCE(credit, 0) ELSE 0 END), 0) AS cf_credit
        FROM cash_flow_entries
        WHERE (from_firm_id = $1 OR to_firm_id = $1)
          AND is_firm_transaction = TRUE
          AND LOWER(COALESCE(status, 'approved')) = 'approved'
          AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      )
      SELECT
        (ft_agg.ft_count + cf_agg.cf_count)::int AS total_entries,
        (ft_agg.ft_debit  + cf_agg.cf_debit)     AS total_debit,
        (ft_agg.ft_credit + cf_agg.cf_credit)    AS total_credit
      FROM ft_agg, cf_agg
      `,
      [firmId]
    );
    const row = result.rows[0] || {};
    return {
      total_entries: row.total_entries || 0,
      total_debit:   parseFloat(row.total_debit)  || 0,
      total_credit:  parseFloat(row.total_credit) || 0,
      count: row.total_entries || 0, // legacy alias
    };
  }

  /** Category/remark-wise breakdown for a firm */
  async getRemarkBreakdown(firmId, pool) {
    const query = `
      SELECT
        COALESCE(NULLIF(remark, ''), 'UNCATEGORIZED') AS remark,
        COUNT(*)::int AS entries,
        COALESCE(SUM(debit), 0) AS total_debit,
        COALESCE(SUM(credit), 0) AS total_credit
      FROM firm_transactions
      WHERE firm_id = $1
        AND LOWER(COALESCE(status, 'approved')) = 'approved'
        AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      GROUP BY COALESCE(NULLIF(remark, ''), 'UNCATEGORIZED')
      ORDER BY total_debit DESC
    `;
    const result = await pool.query(query, [firmId]);
    return result.rows;
  }

  /** Name-wise breakdown for a firm */
  async getNameBreakdown(firmId, pool) {
    const query = `
      SELECT
        COALESCE(NULLIF(name, ''), 'UNKNOWN') AS name,
        COUNT(*)::int AS entries,
        COALESCE(SUM(debit), 0) AS total_debit,
        COALESCE(SUM(credit), 0) AS total_credit
      FROM firm_transactions
      WHERE firm_id = $1
        AND LOWER(COALESCE(status, 'approved')) = 'approved'
        AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      GROUP BY COALESCE(NULLIF(name, ''), 'UNKNOWN')
      ORDER BY total_debit DESC
    `;
    const result = await pool.query(query, [firmId]);
    return result.rows;
  }

  /** Unique autocomplete values for site-wide names, purposes, remarks */
  async getAutocomplete(siteId, pool) {
    const [names, purposes, remarks] = await Promise.all([
      pool.query(`SELECT DISTINCT name FROM firm_transactions WHERE site_id = $1 AND name IS NOT NULL AND name != '' ORDER BY name ASC`, [siteId]),
      pool.query(`SELECT DISTINCT purpose FROM firm_transactions WHERE site_id = $1 AND purpose IS NOT NULL AND purpose != '' ORDER BY purpose ASC`, [siteId]),
      pool.query(`SELECT DISTINCT remark FROM firm_transactions WHERE site_id = $1 AND remark IS NOT NULL AND remark != '' ORDER BY remark ASC`, [siteId]),
    ]);
    return {
      names: names.rows.map(r => r.name),
      purposes: purposes.rows.map(r => r.purpose),
      remarks: remarks.rows.map(r => r.remark),
    };
  }

  /** Monthly summary for a firm */
  async getMonthlySummary(firmId, pool) {
    const query = `
      SELECT
        EXTRACT(YEAR FROM date)::int AS year,
        EXTRACT(MONTH FROM date)::int AS month,
        COUNT(*)::int AS entries,
        COALESCE(SUM(debit), 0) AS total_debit,
        COALESCE(SUM(credit), 0) AS total_credit
      FROM firm_transactions
      WHERE firm_id = $1
        AND LOWER(COALESCE(status, 'approved')) = 'approved'
        AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      GROUP BY EXTRACT(YEAR FROM date), EXTRACT(MONTH FROM date)
      ORDER BY year DESC, month DESC
    `;
    const result = await pool.query(query, [firmId]);
    return result.rows;
  }

  /** Transactions for a site + date (for Day Book enrichment) */
  async findBySiteAndDate(siteId, date, pool) {
    const query = `
      SELECT ft.*, f.name AS firm_name, u.name as assigned_admin_name
      FROM firm_transactions ft
      JOIN firms f ON f.id = ft.firm_id
      LEFT JOIN users u ON ft.assigned_admin_id = u.id
      WHERE ft.site_id = $1 AND ft.date = $2
      ORDER BY ft.id ASC
    `;
    const result = await pool.query(query, [siteId, date]);
    return result.rows;
  }
}

export const firmModel = new FirmModel();
export const firmTransactionModel = new FirmTransactionModel();
