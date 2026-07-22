/**
 * Chart Service — Pre-aggregated data for dashboard charts.
 * All computation in PostgreSQL; frontend receives ready-to-render arrays.
 */
import pool from '../../config/db.js';

/**
 * Revenue vs Expense trend — grouped by resolution.
 * Used for both area chart and bar chart.
 */
export async function getRevenueVsExpense(siteId, start, end, resolution = 'MONTH', excludeOldPlots = false) {
  const truncFn = resolution === 'DAY' ? 'day'
    : resolution === 'WEEK' ? 'week'
    : resolution === 'QUARTER' ? 'quarter'
    : resolution === 'YEAR' ? 'year'
    : 'month';

  const oldFilter = excludeOldPlots
    ? `AND UPPER(TRIM(COALESCE(plt.plot_tag, ''))) <> 'OLD'`
    : '';
  const oldFilterP = oldFilter.replace(/plt\./g, 'p.');

  const { rows } = await pool.query(
    `WITH ledger_rows AS (
       SELECT pp.date::date AS entry_date,
              pp.amount::numeric AS revenue,
              0::numeric AS expense
       FROM plot_payments pp
       JOIN plots plt ON plt.id = pp.plot_id
       WHERE plt.site_id = $1 AND pp.date >= $2 AND pp.date < $3
         AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
         ${oldFilter}

       UNION ALL

       SELECT pip.payment_date::date, pip.amount::numeric, 0::numeric
       FROM plot_installment_payments pip
       JOIN plots p ON p.id = pip.plot_id
       WHERE p.site_id = $1 AND pip.payment_date >= $2 AND pip.payment_date < $3
         AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
         ${oldFilterP}

       UNION ALL

       SELECT fp.date::date, 0::numeric, fp.amount::numeric
       FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
       WHERE f.site_id = $1 AND fp.date >= $2 AND fp.date < $3
         AND LOWER(COALESCE(fp.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(fp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

       UNION ALL

       SELECT date::date, 0::numeric,
              (COALESCE(debit, 0) - COALESCE(credit, 0))::numeric
       FROM expenses
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

       UNION ALL

       SELECT date::date, 0::numeric, amount::numeric
       FROM plot_commissions
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

       UNION ALL

       SELECT date::date, 0::numeric, amount::numeric
       FROM plot_commission_payments
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

       UNION ALL

       SELECT payment_date::date, 0::numeric, amount::numeric
       FROM vendor_payments
       WHERE site_id = $1 AND payment_date >= $2 AND payment_date < $3
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

       UNION ALL

       SELECT date::date, 0::numeric,
              (COALESCE(debit, 0) - COALESCE(credit, 0))::numeric
       FROM day_book
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND UPPER(COALESCE(entry_type, '')) = 'EXPENSE'
         AND farmer_payment_id IS NULL
         AND commission_id IS NULL
         AND vendor_payment_id IS NULL
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
     ),
     bounds AS (
       SELECT MIN(entry_date) AS min_date, MAX(entry_date) AS max_date
       FROM ledger_rows
     ),
     range_series AS (
       SELECT generate_series(
         date_trunc($4::text, min_date),
         date_trunc($4::text, max_date),
         ('1 ' || $4::text)::interval
       )::date AS bucket
       FROM bounds
       WHERE min_date IS NOT NULL
     ),
     totals AS (
       SELECT date_trunc($4::text, entry_date)::date AS bucket,
              COALESCE(SUM(revenue), 0)::numeric AS revenue,
              COALESCE(SUM(expense), 0)::numeric AS expense
       FROM ledger_rows
       GROUP BY 1
     )
     SELECT rs.bucket AS date,
            to_char(rs.bucket, CASE
              WHEN $4 = 'day' THEN 'DD Mon'
              WHEN $4 = 'week' THEN 'DD Mon'
              WHEN $4 = 'month' THEN 'Mon YY'
              WHEN $4 = 'quarter' THEN '"Q"Q YY'
              ELSE 'YYYY'
            END) AS label,
            COALESCE(t.revenue, 0) AS revenue,
            COALESCE(t.expense, 0) AS expense
     FROM range_series rs
     LEFT JOIN totals t ON t.bucket = rs.bucket
     ORDER BY rs.bucket`,
    [siteId, start, end, truncFn]
  );

  return rows.map(r => ({
    date: r.date,
    label: r.label,
    revenue: parseFloat(r.revenue) || 0,
    expense: parseFloat(r.expense) || 0,
  }));
}

/**
 * Net profit trend — simple revenue minus expense per bucket.
 */
export async function getProfitTrend(siteId, start, end, resolution = 'MONTH', excludeOldPlots = false) {
  const data = await getRevenueVsExpense(siteId, start, end, resolution, excludeOldPlots);
  return data.map(d => ({
    date: d.date,
    label: d.label,
    value: d.revenue - d.expense,
  }));
}

/**
 * Expense category breakdown — top N categories.
 */
export async function getExpenseByCategory(siteId, start, end, top = 8) {
  const { rows } = await pool.query(
    `SELECT category,
            COALESCE(SUM(COALESCE(debit, 0) - COALESCE(credit, 0)), 0)::numeric AS total
     FROM expenses
     WHERE site_id = $1 AND date >= $2 AND date < $3
       AND LOWER(COALESCE(status, 'approved')) = 'approved'
       AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       AND (COALESCE(debit, 0) <> 0 OR COALESCE(credit, 0) <> 0)
     GROUP BY category
     ORDER BY total DESC
     LIMIT $4`,
    [siteId, start, end, top]
  );
  return rows.map(r => ({ category: r.category || 'Uncategorized', amount: parseFloat(r.total) || 0 }));
}
