import MasterModel from './MasterModel.js';

// ── Plot Model ──
class PlotModel extends MasterModel {
  constructor() {
    super('plots');
  }

  /** All plots for a site with payment aggregates.
   *  Previously: SIX scalar subqueries PER ROW (3 SUM filters + COUNT +
   *  2 string_aggs). With 50 plots that's 300+ subqueries per page load.
   *  Now: a single LATERAL aggregation that scans plot_payments once per
   *  plot and computes everything via FILTER. */
  async findBySiteId(siteId, pool) {
    const query = `
      SELECT p.*,
        COALESCE(agg.total_received,    0) AS total_received,
        COALESCE(agg.received_bank,     0) AS received_bank,
        COALESCE(agg.received_cash,     0) AS received_cash,
        COALESCE(agg.payment_count,     0) AS payment_count,
        COALESCE(agg.payment_buyer_names, '') AS payment_buyer_names,
        COALESCE(agg.payment_booked_bys,  '') AS payment_booked_bys
      FROM plots p
      LEFT JOIN LATERAL (
        SELECT
          SUM(pp.amount) FILTER (
            WHERE LOWER(COALESCE(pp.status, 'approved')) = 'approved'
              AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          ) AS total_received,
          SUM(pp.amount) FILTER (
            WHERE ledger_bucket(pp.payment_type) <> 'cash'
              AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
              AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          ) AS received_bank,
          SUM(pp.amount) FILTER (
            WHERE ledger_bucket(pp.payment_type) = 'cash'
              AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
              AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          ) AS received_cash,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(pp.status, 'approved')) = 'approved'
              AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          )::int AS payment_count,
          STRING_AGG(DISTINCT pp.buyer_name, ', ') FILTER (
            WHERE pp.buyer_name IS NOT NULL AND pp.buyer_name != ''
          ) AS payment_buyer_names,
          STRING_AGG(DISTINCT pp.booked_by, ', ') FILTER (
            WHERE pp.booked_by IS NOT NULL AND pp.booked_by != ''
          ) AS payment_booked_bys
        FROM (
          SELECT amount, payment_type, status, cheque_status, buyer_name, booked_by
          FROM plot_payments
          WHERE plot_id = p.id
          UNION ALL
          SELECT amount, payment_mode AS payment_type, 'approved'::varchar AS status,
                 cheque_status, NULL::varchar AS buyer_name, NULL::varchar AS booked_by
          FROM plot_installment_payments
          WHERE plot_id = p.id
        ) pp
      ) agg ON TRUE
      WHERE p.site_id = $1
      ORDER BY p.plot_no ASC
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows;
  }

  /** Check for duplicate plot_no within a site — returns ALL matches */
  async findAllByPlotNo(siteId, plotNo, pool) {
    const query = `SELECT * FROM plots WHERE site_id = $1 AND UPPER(plot_no) = UPPER($2) ORDER BY id`;
    const result = await pool.query(query, [siteId, plotNo]);
    return result.rows;
  }

  /** Lightweight plot-number search for the dashboard quick-search.
   *  Matches plot_no (case-insensitive, contains) and returns only the
   *  fields needed to render a result row + navigate to the detail page.
   *  Ordering: exact match → prefix match → current (non-RESALE) booking →
   *  natural plot_no → newest row. So a resale plot's CURRENT owner row
   *  surfaces before the older RESALE-tagged rows that share its number. */
  async searchByPlotNo(siteId, q, pool, limit = 12) {
    const term = String(q || '').trim();
    if (!term) return [];
    // Escape LIKE wildcards so a stray % / _ in the query can't broaden the match.
    const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
    const query = `
      SELECT id, plot_no, block, buyer_name, booking_by, status
      FROM plots
      WHERE site_id = $1 AND plot_no ILIKE $2 ESCAPE '\\'
      ORDER BY
        (UPPER(plot_no) = UPPER($3)) DESC,
        (UPPER(plot_no) LIKE UPPER($3) || '%') DESC,
        (status = 'RESALE') ASC,
        plot_no ASC,
        id DESC
      LIMIT $4
    `;
    const result = await pool.query(query, [siteId, `%${escaped}%`, term, limit]);
    return result.rows;
  }

  /** Get single plot with aggregates (single LATERAL — was 4 subqueries). */
  async findByIdWithTotals(id, pool) {
    const query = `
      SELECT p.*,
        COALESCE(agg.total_received, 0) AS total_received,
        COALESCE(agg.received_bank,  0) AS received_bank,
        COALESCE(agg.received_cash,  0) AS received_cash,
        COALESCE(agg.payment_count,  0) AS payment_count
      FROM plots p
      LEFT JOIN LATERAL (
        SELECT
          SUM(pp.amount) FILTER (
            WHERE LOWER(COALESCE(pp.status, 'approved')) = 'approved'
              AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          ) AS total_received,
          SUM(pp.amount) FILTER (
            WHERE ledger_bucket(pp.payment_type) <> 'cash'
              AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
              AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          ) AS received_bank,
          SUM(pp.amount) FILTER (
            WHERE ledger_bucket(pp.payment_type) = 'cash'
              AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
              AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          ) AS received_cash,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(pp.status, 'approved')) = 'approved'
              AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
          )::int AS payment_count
        FROM (
          SELECT amount, payment_type, status, cheque_status
          FROM plot_payments
          WHERE plot_id = p.id
          UNION ALL
          SELECT amount, payment_mode AS payment_type, 'approved'::varchar AS status, cheque_status
          FROM plot_installment_payments
          WHERE plot_id = p.id
        ) pp
      ) agg ON TRUE
      WHERE p.id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }
}

// ── Plot Payment Model ──
class PlotPaymentModel extends MasterModel {
  constructor() {
    super('plot_payments');
  }

  /** All payments for a plot, ordered by date ASC */
  async findByPlotId(plotId, pool) {
    const query = `
      SELECT pp.*, 'payment' AS source, u.name AS created_by_name
      FROM plot_payments pp
      LEFT JOIN users u ON u.id = pp.created_by
      WHERE pp.plot_id = $1
      ORDER BY pp.date ASC, pp.created_at ASC
    `;
    const result = await pool.query(query, [plotId]);
    return result.rows;
  }

  /**
   * Payment-from/mode breakdown for a plot.
   *
   * The plot aggregate includes both direct plot payments and payments applied
   * through the installment workflow, so this breakdown must use the same two
   * sources. Installment payments have no approval column: creating one is the
   * posting event, and a later bounced/returned cheque removes it from totals.
   */
  async getFromBreakdown(plotId, pool) {
    const query = `
      SELECT
        receipt.payment_from,
        COUNT(*)::int AS entries,
        COALESCE(SUM(receipt.amount), 0) AS total_amount,
        CASE
          WHEN COUNT(DISTINCT receipt.source) = 1 THEN MIN(receipt.source)
          ELSE 'MIXED'
        END AS source
      FROM (
        SELECT
          COALESCE(
            NULLIF(UPPER(TRIM(pp.payment_from)), ''),
            NULLIF(UPPER(TRIM(pp.payment_type)), ''),
            'OTHER'
          ) AS payment_from,
          pp.amount,
          'DIRECT'::varchar AS source
        FROM plot_payments pp
        WHERE pp.plot_id = $1
          AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
          AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')

        UNION ALL

        SELECT
          UPPER(COALESCE(NULLIF(TRIM(pip.payment_mode), ''), 'BANK')) AS payment_from,
          pip.amount,
          'INSTALLMENT'::varchar AS source
        FROM plot_installment_payments pip
        WHERE pip.plot_id = $1
          AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      ) receipt
      GROUP BY receipt.payment_from
      ORDER BY total_amount DESC
    `;
    const result = await pool.query(query, [plotId]);
    return result.rows;
  }

  /**
   * Received-by breakdown using the same posted receipt population. The
   * installment table does not store a receiving person, so those rows use an
   * explicit workflow label instead of being misleadingly attributed to a
   * person or silently omitted from the combined total.
   */
  async getReceivedByBreakdown(plotId, pool) {
    const query = `
      SELECT
        receipt.received_by,
        COUNT(*)::int AS entries,
        COALESCE(SUM(receipt.amount), 0) AS total_amount,
        CASE
          WHEN COUNT(DISTINCT receipt.source) = 1 THEN MIN(receipt.source)
          ELSE 'MIXED'
        END AS source
      FROM (
        SELECT
          COALESCE(NULLIF(UPPER(TRIM(pp.received_by)), ''), 'UNKNOWN') AS received_by,
          pp.amount,
          'DIRECT'::varchar AS source
        FROM plot_payments pp
        WHERE pp.plot_id = $1
          AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
          AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')

        UNION ALL

        SELECT
          'INSTALLMENT AUTO-POST'::varchar AS received_by,
          pip.amount,
          'INSTALLMENT'::varchar AS source
        FROM plot_installment_payments pip
        WHERE pip.plot_id = $1
          AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
      ) receipt
      GROUP BY receipt.received_by
      ORDER BY total_amount DESC
    `;
    const result = await pool.query(query, [plotId]);
    return result.rows;
  }

  /** All plot payments for a site+date (for Day Book enrichment) */
  async findBySiteAndDate(siteId, date, pool) {
    const query = `
      SELECT pp.*, p.plot_no, p.block, p.buyer_name, p.sale_price, u.name as assigned_admin_name
      FROM plot_payments pp
      JOIN plots p ON p.id = pp.plot_id
      LEFT JOIN users u ON pp.assigned_admin_id = u.id
      WHERE pp.site_id = $1 AND pp.date = $2
      ORDER BY pp.id ASC
    `;
    const result = await pool.query(query, [siteId, date]);
    return result.rows;
  }

  /** Unique autocomplete values from the site's plot payments */
  async getAutocomplete(siteId, pool) {
    const [names, paymentFroms, bankDetails, narrations, receivedBys, bookedBys] = await Promise.all([
      pool.query(`SELECT DISTINCT p.buyer_name AS val FROM plots p WHERE p.site_id = $1 AND p.buyer_name IS NOT NULL AND p.buyer_name != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT payment_from AS val FROM plot_payments WHERE site_id = $1 AND payment_from IS NOT NULL AND payment_from != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT bank_details AS val FROM plot_payments WHERE site_id = $1 AND bank_details IS NOT NULL AND bank_details != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT narration AS val FROM plot_payments WHERE site_id = $1 AND narration IS NOT NULL AND narration != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT received_by AS val FROM plot_payments WHERE site_id = $1 AND received_by IS NOT NULL AND received_by != '' ORDER BY val ASC`, [siteId]),
      pool.query(`SELECT DISTINCT booked_by AS val FROM plot_payments WHERE site_id = $1 AND booked_by IS NOT NULL AND booked_by != '' ORDER BY val ASC`, [siteId]),
    ]);
    return {
      buyerNames: names.rows.map(r => r.val),
      paymentFroms: paymentFroms.rows.map(r => r.val),
      bankDetails: bankDetails.rows.map(r => r.val),
      narrations: narrations.rows.map(r => r.val),
      receivedBys: receivedBys.rows.map(r => r.val),
      bookedBys: bookedBys.rows.map(r => r.val),
    };
  }
}

export const plotModel = new PlotModel();
export const plotPaymentModel = new PlotPaymentModel();
