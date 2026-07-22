import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';

/**
 * Predictive Cash-Flow Forecast.
 *
 * PREDICTIVE model — each future month = a run-rate baseline, raised in any month with a larger KNOWN
 * scheduled due (max, never sum, so the recurring run-rate isn't double-counted):
 *   RUN-RATE  = average monthly ACTUAL cash movement over the last `lookback` months, computed from the
 *               exact same revenue/expense unions the Day Book uses (plot_payments+installment receipts
 *               for inflow; farmer/vendor/commission payments + expenses + day_book EXPENSE for outflow),
 *               so the projection matches the app's own historical numbers.
 *   SCHEDULED = known forward-dated dues that raise a specific month above the baseline:
 *               INFLOW  → pending plot installments (plot_installments.due_date), pending recomputed via
 *                         the app's earmark-aware waterfall (status/paid_amount are stale). Active plots only.
 *               OUTFLOW → open vendor_commitments remaining balance (contract − paid) by due_date.
 *
 * Context figures that have NO reliable due date are reported separately (never fake-bucketed):
 * overdue receivables, overdue / undated vendor commitment balances, and the farmer/land-owner
 * outstanding liability. See migrations 010 (installments), 018 (vendor commitments), 046 (farmers).
 */

// ── Pure, testable month helpers ─────────────────────────────────────────────
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const keyToIdx = (key) => { const [y, m] = String(key).split('-').map(Number); return y * 12 + (m - 1); };
export const idxToKey = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Horizon of `n` months. `start` may be a 'YYYY-MM' key (pass the DB clock so buckets align — the
 * SQL uses date_trunc('month', CURRENT_DATE) and a JS clock can be in a different month at boundaries),
 * a Date, or omitted (falls back to the app clock). [{ key:'YYYY-MM', label:'Jul 26' }].
 */
export function buildHorizon(n, start) {
  let startIdx;
  if (typeof start === 'string') startIdx = keyToIdx(start);
  else { const d = start instanceof Date ? start : new Date(); startIdx = d.getFullYear() * 12 + d.getMonth(); }
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = startIdx + i;
    out.push({ key: idxToKey(idx), label: `${MONTHS_ABBR[idx % 12]} ${String(Math.floor(idx / 12) % 100).padStart(2, '0')}` });
  }
  return out;
}

// ── SQL ──────────────────────────────────────────────────────────────────────
// Pending installment inflow (waterfall), bucketed by month; overdue collapsed to one 'OVERDUE' row.
const INFLOW_SQL = `
  WITH direct AS (        -- earmarked installment payments (plot_installment_payments) claim their own installment first
    SELECT pip.installment_id, SUM(pip.amount) AS direct_paid
    FROM plot_installment_payments pip
    JOIN plots p ON p.id = pip.plot_id
    WHERE p.site_id = $1
      AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
    GROUP BY pip.installment_id
  ),
  generic AS (            -- non-earmarked money waterfalls across the residual need, earliest-first:
                          -- all plot_payments + any installment payment NOT tied to a specific installment.
    SELECT plot_id, SUM(amount) AS generic_pool FROM (
      SELECT pp.plot_id, pp.amount FROM plot_payments pp
        JOIN plots p ON p.id = pp.plot_id
        WHERE p.site_id = $1
          AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
          AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
      UNION ALL
      SELECT pip.plot_id, pip.amount FROM plot_installment_payments pip
        JOIN plots p ON p.id = pip.plot_id
        WHERE p.site_id = $1 AND pip.installment_id IS NULL
          AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
    ) g GROUP BY plot_id
  ),
  sched AS (
    SELECT pi.plot_id, pi.due_date,
           GREATEST(0, pi.amount - COALESCE(d.direct_paid, 0)) AS need,
           SUM(GREATEST(0, pi.amount - COALESCE(d.direct_paid, 0))) OVER (
             PARTITION BY pi.plot_id ORDER BY pi.sort_order, pi.due_date, pi.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_need
    FROM plot_installments pi
    JOIN plots p ON p.id = pi.plot_id
    LEFT JOIN direct d ON d.installment_id = pi.id
    WHERE p.site_id = $1 AND p.status NOT IN ('CANCELLED','AVAILABLE','RESALE','TRANSFERRED')
  ),
  pending AS (
    SELECT s.due_date, GREATEST(0, LEAST(s.need, s.cum_need - COALESCE(g.generic_pool, 0))) AS remaining
    FROM sched s LEFT JOIN generic g ON g.plot_id = s.plot_id
  )
  -- OVERDUE mirrors the app tracker (due < today), so the forecast's overdue figure reconciles with it.
  SELECT CASE WHEN due_date < CURRENT_DATE THEN 'OVERDUE'
              ELSE to_char(date_trunc('month', due_date), 'YYYY-MM') END AS bucket,
         SUM(remaining)::float8 AS amount
  FROM pending
  WHERE remaining > 0
    AND due_date < date_trunc('month', CURRENT_DATE) + make_interval(months => $2::int)
  GROUP BY 1`;

// Scheduled vendor commitment payables (remaining balance) by due month.
const VENDOR_SQL = `
  WITH paid AS (
    SELECT commitment_id, SUM(amount) AS paid_amount FROM vendor_payments
     WHERE site_id = $1
       AND LOWER(COALESCE(status, 'approved')) = 'approved'
       AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
     GROUP BY commitment_id
  )
  SELECT to_char(date_trunc('month', vc.due_date), 'YYYY-MM') AS month,
         SUM(vc.contract_amount - COALESCE(p.paid_amount, 0))::float8 AS amount
  FROM vendor_commitments vc LEFT JOIN paid p ON p.commitment_id = vc.id
  WHERE vc.site_id = $1 AND vc.status = 'open' AND vc.due_date IS NOT NULL
    AND vc.due_date >= date_trunc('month', CURRENT_DATE)
    AND vc.due_date <  date_trunc('month', CURRENT_DATE) + make_interval(months => $2::int)
    AND (vc.contract_amount - COALESCE(p.paid_amount, 0)) > 0
  GROUP BY 1`;

// Undated (no due_date) open vendor commitment balances — reported as context, not month-bucketed.
const VENDOR_UNSCHEDULED_SQL = `
  WITH paid AS (
    SELECT commitment_id, SUM(amount) AS paid_amount FROM vendor_payments
     WHERE site_id = $1
       AND LOWER(COALESCE(status, 'approved')) = 'approved'
       AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
     GROUP BY commitment_id
  )
  SELECT COALESCE(SUM(GREATEST(0, vc.contract_amount - COALESCE(p.paid_amount, 0))), 0)::float8 AS amount
  FROM vendor_commitments vc LEFT JOIN paid p ON p.commitment_id = vc.id
  WHERE vc.site_id = $1 AND vc.status = 'open' AND vc.due_date IS NULL`;

// Overdue (past due_date) open vendor commitment balances — reported as context so the payable
// never silently vanishes (it falls between the future-window and the null-due-date query).
const VENDOR_OVERDUE_SQL = `
  WITH paid AS (
    SELECT commitment_id, SUM(amount) AS paid_amount FROM vendor_payments
     WHERE site_id = $1
       AND LOWER(COALESCE(status, 'approved')) = 'approved'
       AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
     GROUP BY commitment_id
  )
  SELECT COALESCE(SUM(GREATEST(0, vc.contract_amount - COALESCE(p.paid_amount, 0))), 0)::float8 AS amount
  FROM vendor_commitments vc LEFT JOIN paid p ON p.commitment_id = vc.id
  WHERE vc.site_id = $1 AND vc.status = 'open'
    AND vc.due_date IS NOT NULL AND vc.due_date < date_trunc('month', CURRENT_DATE)`;

// Farmer/land-owner outstanding liability (undated — no schedule exists).
const FARMER_SQL = `
  SELECT COALESCE(SUM(GREATEST(0, f.total_amount - COALESCE(pd.paid, 0))), 0)::float8 AS amount
  FROM farmers f
  LEFT JOIN (
    SELECT farmer_id, SUM(amount) AS paid FROM farmer_payments
     WHERE LOWER(COALESCE(status, 'approved')) = 'approved'
       AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
     GROUP BY farmer_id
  ) pd ON pd.farmer_id = f.id
  WHERE f.site_id = $1 AND f.status = 'active'`;

// ── Run-rate (predictive baseline) ────────────────────────────────────────────
// Actual cash movement over the last $2 COMPLETE months (mirrors daybook getProfitSummary's
// revenue/expense unions exactly, so the projection matches the app's own historical numbers).
const WINDOW = `date_trunc('month', CURRENT_DATE) - make_interval(months => $2::int)
                  AND %COL% < date_trunc('month', CURRENT_DATE)`;

// A single posted movement set produces both gross directions. Negative debit
// reverses into inflow and negative credit reverses into outflow, matching the
// canonical Dashboard / Balance Sheet treatment instead of cancelling a gross
// KPI on the wrong side.
const RUN_RATE_MOVEMENT_SQL = `
  SELECT
    COALESCE(SUM(
      GREATEST(COALESCE(credit, 0), 0)
      + GREATEST(-COALESCE(debit, 0), 0)
    ), 0)::float8 AS total_inflow,
    COALESCE(SUM(
      GREATEST(COALESCE(debit, 0), 0)
      + GREATEST(-COALESCE(credit, 0), 0)
    ), 0)::float8 AS total_outflow
  FROM (
    SELECT 0::numeric AS debit, pp.amount::numeric AS credit
    FROM plot_payments pp
    WHERE pp.site_id = $1 AND pp.date >= ${WINDOW.replace('%COL%', 'pp.date')}
      AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
      AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

    UNION ALL
    SELECT 0::numeric, pip.amount::numeric
    FROM plot_installment_payments pip
    JOIN plots p ON p.id = pip.plot_id
    WHERE p.site_id = $1 AND pip.payment_date >= ${WINDOW.replace('%COL%', 'pip.payment_date')}
      AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

    UNION ALL
    SELECT fp.amount::numeric, 0::numeric
    FROM farmer_payments fp
    JOIN farmers f ON f.id = fp.farmer_id
    WHERE f.site_id = $1 AND fp.date >= ${WINDOW.replace('%COL%', 'fp.date')}
      AND LOWER(COALESCE(fp.status, 'approved')) = 'approved'
      AND UPPER(COALESCE(fp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

    UNION ALL
    SELECT debit::numeric, credit::numeric
    FROM expenses
    WHERE site_id = $1 AND date >= ${WINDOW.replace('%COL%', 'date')}
      AND LOWER(COALESCE(status, 'approved')) = 'approved'
      AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

    UNION ALL
    SELECT amount::numeric, 0::numeric
    FROM plot_commissions
    WHERE site_id = $1 AND date >= ${WINDOW.replace('%COL%', 'date')}
      AND LOWER(COALESCE(status, 'approved')) = 'approved'
      AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

    UNION ALL
    SELECT amount::numeric, 0::numeric
    FROM plot_commission_payments
    WHERE site_id = $1 AND date >= ${WINDOW.replace('%COL%', 'date')}
      AND LOWER(COALESCE(status, 'approved')) = 'approved'
      AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

    UNION ALL
    SELECT amount::numeric, 0::numeric
    FROM vendor_payments
    WHERE site_id = $1 AND payment_date >= ${WINDOW.replace('%COL%', 'payment_date')}
      AND LOWER(COALESCE(status, 'approved')) = 'approved'
      AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

    UNION ALL
    SELECT debit::numeric, credit::numeric
    FROM day_book
    WHERE site_id = $1 AND date >= ${WINDOW.replace('%COL%', 'date')}
      AND UPPER(COALESCE(entry_type, '')) = 'EXPENSE'
      AND farmer_payment_id IS NULL AND commission_id IS NULL AND vendor_payment_id IS NULL
      AND LOWER(COALESCE(status, 'approved')) = 'approved'
      AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
  ) posted_movements`;

/** GET /forecast?site_id=&months=6&lookback=6 */
export const getCashflowForecast = asyncHandler(async (req, res) => {
  const siteId = Number(req.query.site_id);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return res.status(400).json({ message: 'A valid site_id is required' });
  }

  const { rows: siteRows } = await pool.query('SELECT id FROM sites WHERE id = $1 LIMIT 1', [siteId]);
  if (!siteRows[0]) return res.status(404).json({ message: 'Site not found' });

  if (req.user.role === 'sub_admin') {
    const { rows: accessRows } = await pool.query(
      'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
      [req.user.id, siteId]
    );
    if (!accessRows[0]) return res.status(403).json({ message: 'Access denied to this site' });
  }

  const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 12);
  const lookback = Math.min(Math.max(parseInt(req.query.lookback, 10) || 6, 1), 24);

  const [clockRes, inflowRes, vendorRes, vendorUnschedRes, vendorOverdueRes, farmerRes, runRateRes] = await Promise.all([
    pool.query(`SELECT to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM') AS m`),
    pool.query(INFLOW_SQL, [siteId, months]),
    pool.query(VENDOR_SQL, [siteId, months]),
    pool.query(VENDOR_UNSCHEDULED_SQL, [siteId]),
    pool.query(VENDOR_OVERDUE_SQL, [siteId]),
    pool.query(FARMER_SQL, [siteId]),
    pool.query(RUN_RATE_MOVEMENT_SQL, [siteId, lookback]),
  ]);

  // Anchor the horizon to the DB clock so its month keys match the SQL date_trunc buckets exactly.
  const horizon = buildHorizon(months, clockRes.rows[0].m);

  const inflowByMonth = {};
  let overdueReceivables = 0;
  for (const r of inflowRes.rows) {
    if (r.bucket === 'OVERDUE') overdueReceivables = r.amount;
    else inflowByMonth[r.bucket] = r.amount;
  }

  const vendorByMonth = Object.fromEntries(vendorRes.rows.map((r) => [r.month, r.amount]));

  // Predictive baseline: average monthly actual cash movement over the last `lookback` months.
  const runInflow = round2(Math.max(0, (runRateRes.rows[0]?.total_inflow || 0) / lookback));
  const runOutflow = round2(Math.max(0, (runRateRes.rows[0]?.total_outflow || 0) / lookback));

  // Each month = the run-rate baseline, bumped up in any month whose KNOWN scheduled due is larger
  // (max, not sum, so the recurring run-rate — which already includes typical dues — is never double-counted).
  const monthsOut = horizon.map((h) => {
    const scheduledInflow = round2(inflowByMonth[h.key] || 0);
    const scheduledOutflow = round2(vendorByMonth[h.key] || 0);
    const inflow = round2(Math.max(runInflow, scheduledInflow));
    const outflow = round2(Math.max(runOutflow, scheduledOutflow));
    return { key: h.key, label: h.label, inflow, outflow, net: round2(inflow - outflow), scheduledInflow, scheduledOutflow };
  });

  const totals = monthsOut.reduce(
    (a, m) => ({ inflow: a.inflow + m.inflow, outflow: a.outflow + m.outflow }),
    { inflow: 0, outflow: 0 }
  );

  res.json({
    months: monthsOut,
    runRate: { lookbackMonths: lookback, inflowPerMonth: runInflow, outflowPerMonth: runOutflow },
    context: {
      overdueReceivables: round2(overdueReceivables),
      vendorOverdue: round2(vendorOverdueRes.rows[0]?.amount || 0),
      vendorUnscheduled: round2(vendorUnschedRes.rows[0]?.amount || 0),
      farmerOutstanding: round2(farmerRes.rows[0]?.amount || 0),
    },
    totals: { inflow: round2(totals.inflow), outflow: round2(totals.outflow), net: round2(totals.inflow - totals.outflow) },
    horizonMonths: months,
    generatedAt: new Date().toISOString(),
  });
});
