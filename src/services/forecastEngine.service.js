/**
 * Finance Forecast — explainable predictive cash-flow engine.
 *
 * This is a successor to the old embedded Dashboard widget
 * (forecast.controller.js / CashFlowForecast.jsx, both retired). The known-due
 * SQL below (INFLOW_SQL, VENDOR_SQL, VENDOR_UNSCHEDULED_SQL,
 * VENDOR_OVERDUE_SQL, FARMER_SQL) is carried over unchanged from that
 * controller — it already correctly recomputes live balances instead of
 * trusting stale status fields, and reports undated liabilities as context
 * instead of fake-dating them. See each query's own comment for the
 * accounting rule it encodes.
 *
 * Revenue/expense TOTALS for any single period go through kpi.service.js
 * (the canonical formula also used by the Dashboard KPI cards) — this module
 * never re-derives that formula. The one exception is MOVEMENTS_UNION_SQL
 * below: the forecast engine needs a *time series* (monthly trend,
 * seasonality, weekday pattern, volatility), not a single total, so it keeps
 * one shared raw-row union (same accounting rules: approved, non-bounced/
 * returned, orphan day_book EXPENSE only) and groups it differently for each
 * need. Any single-total need still calls kpi.service.js directly.
 *
 * DECISION SUPPORT, NOT A GUARANTEE — every payload carries a `disclaimer`.
 */
import pool from '../config/db.js';
import { getRevenue, getExpenseBreakdown, getSiteCashflow } from '../graphql/services/kpi.service.js';

export const MODEL_VERSION = 'finance-forecast-v1';

const DISCLAIMER = 'Decision support only — a projection from historical patterns and known dues, not a guaranteed collection or payment.';

// ── Pure month helpers (moved from the retired forecast.controller.js) ──
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const keyToIdx = (key) => { const [y, m] = String(key).split('-').map(Number); return y * 12 + (m - 1); };
export const idxToKey = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export function buildHorizon(n, start) {
  let startIdx;
  if (typeof start === 'string') startIdx = keyToIdx(start);
  else { const d = start instanceof Date ? start : new Date(); startIdx = d.getFullYear() * 12 + d.getMonth(); }
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = startIdx + i;
    out.push({ key: idxToKey(idx), label: `${MONTHS_ABBR[idx % 12]} ${String(Math.floor(idx / 12) % 100).padStart(2, '0')}`, calMonth: idx % 12 });
  }
  return out;
}

// ── Known future cash movements (unchanged from forecast.controller.js) ──

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

async function getKnownDues(siteId, horizonMonths) {
  const [inflowRes, vendorRes, vendorUnschedRes, vendorOverdueRes, farmerRes] = await Promise.all([
    pool.query(INFLOW_SQL, [siteId, horizonMonths]),
    pool.query(VENDOR_SQL, [siteId, horizonMonths]),
    pool.query(VENDOR_UNSCHEDULED_SQL, [siteId]),
    pool.query(VENDOR_OVERDUE_SQL, [siteId]),
    pool.query(FARMER_SQL, [siteId]),
  ]);

  const inflowByMonth = {};
  let overdueReceivables = 0;
  for (const r of inflowRes.rows) {
    if (r.bucket === 'OVERDUE') overdueReceivables = r.amount;
    else inflowByMonth[r.bucket] = r.amount;
  }
  const outflowByMonth = Object.fromEntries(vendorRes.rows.map((r) => [r.month, r.amount]));

  return {
    inflowByMonth,
    outflowByMonth,
    context: {
      overdueReceivables: round2(overdueReceivables),
      vendorOverdue: round2(vendorOverdueRes.rows[0]?.amount || 0),
      vendorUnscheduled: round2(vendorUnschedRes.rows[0]?.amount || 0),
      farmerOutstanding: round2(farmerRes.rows[0]?.amount || 0),
    },
  };
}

// ── Historical time series ──
// Same accounting rules as kpi.service.js's getRevenue/getExpenseBreakdown
// (approved, non-bounced/returned, orphan day_book EXPENSE only), kept as raw
// per-row (date, debit, credit) data — a signed reversal (negative debit
// reverses into inflow, negative credit into outflow) matches the canonical
// Dashboard/Balance Sheet treatment.
const MOVEMENTS_UNION_SQL = `
  SELECT pp.date::date AS d, 0::numeric AS debit, pp.amount::numeric AS credit
  FROM plot_payments pp
  WHERE pp.site_id = $1 AND pp.date >= $2 AND pp.date < $3
    AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
    AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
  UNION ALL
  SELECT pip.payment_date::date, 0::numeric, pip.amount::numeric
  FROM plot_installment_payments pip
  JOIN plots p ON p.id = pip.plot_id
  WHERE p.site_id = $1 AND pip.payment_date >= $2 AND pip.payment_date < $3
    AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
  UNION ALL
  SELECT fp.date::date, fp.amount::numeric, 0::numeric
  FROM farmer_payments fp
  JOIN farmers f ON f.id = fp.farmer_id
  WHERE f.site_id = $1 AND fp.date >= $2 AND fp.date < $3
    AND LOWER(COALESCE(fp.status, 'approved')) = 'approved'
    AND UPPER(COALESCE(fp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
  UNION ALL
  SELECT date::date, debit::numeric, credit::numeric
  FROM expenses
  WHERE site_id = $1 AND date >= $2 AND date < $3
    AND LOWER(COALESCE(status, 'approved')) = 'approved'
    AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
  UNION ALL
  SELECT date::date, amount::numeric, 0::numeric
  FROM plot_commissions
  WHERE site_id = $1 AND date >= $2 AND date < $3
    AND LOWER(COALESCE(status, 'approved')) = 'approved'
    AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
  UNION ALL
  SELECT date::date, amount::numeric, 0::numeric
  FROM plot_commission_payments
  WHERE site_id = $1 AND date >= $2 AND date < $3
    AND LOWER(COALESCE(status, 'approved')) = 'approved'
    AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
  UNION ALL
  SELECT payment_date::date, amount::numeric, 0::numeric
  FROM vendor_payments
  WHERE site_id = $1 AND payment_date >= $2 AND payment_date < $3
    AND LOWER(COALESCE(status, 'approved')) = 'approved'
    AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
  UNION ALL
  SELECT date::date, debit::numeric, credit::numeric
  FROM day_book
  WHERE site_id = $1 AND date >= $2 AND date < $3
    AND UPPER(COALESCE(entry_type, '')) = 'EXPENSE'
    AND farmer_payment_id IS NULL AND commission_id IS NULL AND vendor_payment_id IS NULL
    AND LOWER(COALESCE(status, 'approved')) = 'approved'
    AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')`;

async function getMonthlyHistory(siteId, lookbackMonths, clockKey) {
  const startIdx = keyToIdx(clockKey) - lookbackMonths;
  const startKey = idxToKey(startIdx);
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', m.d), 'YYYY-MM') AS bucket,
            COALESCE(SUM(GREATEST(COALESCE(m.credit, 0), 0) + GREATEST(-COALESCE(m.debit, 0), 0)), 0)::float8 AS inflow,
            COALESCE(SUM(GREATEST(COALESCE(m.debit, 0), 0) + GREATEST(-COALESCE(m.credit, 0), 0)), 0)::float8 AS outflow,
            COUNT(*)::int AS txn_count
     FROM (${MOVEMENTS_UNION_SQL}) m
     GROUP BY 1`,
    [siteId, `${startKey}-01`, `${clockKey}-01`]
  );
  const byMonth = Object.fromEntries(rows.map((r) => [r.bucket, r]));
  const horizon = buildHorizon(lookbackMonths, startKey);
  return horizon.map((h) => {
    const r = byMonth[h.key];
    return {
      key: h.key,
      label: h.label,
      calMonth: h.calMonth,
      inflow: round2(r?.inflow || 0),
      outflow: round2(r?.outflow || 0),
      net: round2((r?.inflow || 0) - (r?.outflow || 0)),
      txnCount: r ? parseInt(r.txn_count, 10) || 0 : 0,
    };
  });
}

async function getWeekdayPattern(siteId, lookbackMonths, clockKey) {
  const startIdx = keyToIdx(clockKey) - lookbackMonths;
  const startKey = idxToKey(startIdx);
  const { rows } = await pool.query(
    `SELECT EXTRACT(DOW FROM m.d)::int AS dow,
            COALESCE(SUM(GREATEST(COALESCE(m.credit, 0), 0) + GREATEST(-COALESCE(m.debit, 0), 0)), 0)::float8 AS inflow,
            COALESCE(SUM(GREATEST(COALESCE(m.debit, 0), 0) + GREATEST(-COALESCE(m.credit, 0), 0)), 0)::float8 AS outflow,
            COUNT(*)::int AS txn_count
     FROM (${MOVEMENTS_UNION_SQL}) m
     GROUP BY 1`,
    [siteId, `${startKey}-01`, `${clockKey}-01`]
  );
  const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDow = Object.fromEntries(rows.map((r) => [r.dow, r]));
  return DOW_LABEL.map((label, dow) => {
    const r = byDow[dow];
    return {
      weekday: dow,
      label,
      txnCount: r ? parseInt(r.txn_count, 10) || 0 : 0,
      inflow: round2(r?.inflow || 0),
      outflow: round2(r?.outflow || 0),
    };
  });
}

async function getCurrentMonthActual(siteId, clockKey, today) {
  const monthStart = `${clockKey}-01`;
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const [inflow, expenseBreakdown] = await Promise.all([
    getRevenue(siteId, monthStart, tomorrowStr),
    getExpenseBreakdown(siteId, monthStart, tomorrowStr),
  ]);
  return { inflow: round2(inflow), outflow: round2(expenseBreakdown.total) };
}

// ── Pure statistical helpers (explainable, deliberately simple) ──

function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }

function stddev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((a, v) => a + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Coefficient of variation — 0 when flat, grows with relative swinginess. */
function volatilityOf(values) {
  const m = mean(values);
  if (m <= 0) return values.some((v) => v > 0) ? 1 : 0;
  return clamp(stddev(values) / m, 0, 2);
}

/** More weight on recent months — weights 1..n, most-recent last in `values`. */
function recencyWeightedAverage(values) {
  if (!values.length) return 0;
  const n = values.length;
  const weightSum = (n * (n + 1)) / 2;
  return values.reduce((acc, v, i) => acc + v * (i + 1), 0) / weightSum;
}

/** Simple linear regression slope (per-month change) over an evenly-spaced series. */
function linearSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** Clip a per-month trend slope to a % of the baseline so projections can't run away exponentially. */
function clipTrend(slopePerMonth, baseline, maxPct = 0.2) {
  const cap = Math.abs(baseline) * maxPct || Math.abs(slopePerMonth);
  return clamp(slopePerMonth, -cap, cap);
}

/**
 * Restrained seasonality — only meaningful with >= 12 months of evidence.
 * Per-calendar-month index = that month's historical average / overall
 * average, capped to a narrow band so a single unusual month can't dominate.
 */
function computeSeasonalIndex(monthlyHistory, lookbackMonths, field) {
  if (lookbackMonths < 12) return () => 1;
  const overall = mean(monthlyHistory.map((m) => m[field]));
  if (overall <= 0) return () => 1;
  const byCalMonth = new Map();
  for (const m of monthlyHistory) {
    if (!byCalMonth.has(m.calMonth)) byCalMonth.set(m.calMonth, []);
    byCalMonth.get(m.calMonth).push(m[field]);
  }
  const index = new Map();
  for (const [calMonth, vals] of byCalMonth) {
    const idx = clamp(mean(vals) / overall, 0.85, 1.15);
    index.set(calMonth, idx);
  }
  return (calMonth) => index.get(calMonth) ?? 1;
}

function confidenceFromInputs({ txnCount, activeMonths, lookbackMonths, volatility }) {
  const txnScore = clamp(txnCount / 40, 0, 1) * 40; // up to 40 pts for transaction volume
  const activeScore = clamp(activeMonths / Math.max(lookbackMonths, 1), 0, 1) * 30; // up to 30 pts for consistency
  const stabilityScore = clamp(1 - volatility / 1.5, 0, 1) * 30; // up to 30 pts for low volatility
  const score = Math.round(txnScore + activeScore + stabilityScore);
  const level = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
  return { score, level };
}

function classifyRisk({ lowestProjectedCash, deficitMonthCount, currentCash }) {
  if (deficitMonthCount === 0 && lowestProjectedCash >= currentCash * 0.5) {
    return { riskLevel: 'low', summary: 'Projected cash position stays healthy across the forecast horizon.' };
  }
  if (deficitMonthCount === 0) {
    return { riskLevel: 'medium', summary: 'Cash stays positive but is projected to run noticeably lower than today at some point.' };
  }
  if (deficitMonthCount <= 1) {
    return { riskLevel: 'medium', summary: 'One month in the forecast horizon is projected to dip into deficit — worth planning around.' };
  }
  return { riskLevel: 'high', summary: `${deficitMonthCount} months in the forecast horizon are projected to run a cash deficit under the base scenario.` };
}

const SCENARIO_MULTIPLIERS = {
  conservative: { inflow: 0.85, outflow: 1.10 },
  base: { inflow: 1.00, outflow: 1.00 },
  optimistic: { inflow: 1.10, outflow: 0.95 },
};

/**
 * projectedMonthlyAmount = MAX(patternBaseline, knownScheduledAmount) — never
 * summed. The pattern baseline already reflects typical historical dues, so
 * adding the scheduled figure on top would double-count the same money twice.
 */
const combineBaselineAndScheduled = (pattern, scheduled) => Math.max(pattern, scheduled);

export async function getFinanceForecast(siteId, { horizonMonths = 6, lookbackMonths = 6 } = {}) {
  horizonMonths = clamp(parseInt(horizonMonths, 10) || 6, 1, 24);
  lookbackMonths = clamp(parseInt(lookbackMonths, 10) || 6, 1, 24);

  const clockRes = await pool.query(`SELECT to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM') AS m, CURRENT_DATE::date AS today`);
  const clockKey = clockRes.rows[0].m;
  const today = new Date(clockRes.rows[0].today);

  const [monthlyHistory, weekdayPattern, dues, currentMonthActual, cashflow] = await Promise.all([
    getMonthlyHistory(siteId, lookbackMonths, clockKey),
    getWeekdayPattern(siteId, lookbackMonths, clockKey),
    getKnownDues(siteId, horizonMonths),
    getCurrentMonthActual(siteId, clockKey, today),
    getSiteCashflow(siteId, '1900-01-01', idxToKey(keyToIdx(clockKey) + 1) + '-01'),
  ]);

  const currentCash = round2(cashflow.siteBalance);

  const inflowSeries = monthlyHistory.map((m) => m.inflow);
  const outflowSeries = monthlyHistory.map((m) => m.outflow);
  const activeMonths = monthlyHistory.filter((m) => m.txnCount > 0).length;
  const totalTxnCount = monthlyHistory.reduce((a, m) => a + m.txnCount, 0);

  const inflowBaseline = recencyWeightedAverage(inflowSeries);
  const outflowBaseline = recencyWeightedAverage(outflowSeries);
  const inflowTrendRaw = linearSlope(inflowSeries);
  const outflowTrendRaw = linearSlope(outflowSeries);
  const inflowTrend = clipTrend(inflowTrendRaw, inflowBaseline);
  const outflowTrend = clipTrend(outflowTrendRaw, outflowBaseline);
  const inflowTrendPct = inflowBaseline > 0 ? round2((inflowTrend / inflowBaseline) * 100) : 0;
  const outflowTrendPct = outflowBaseline > 0 ? round2((outflowTrend / outflowBaseline) * 100) : 0;

  const inflowVolatility = round2(volatilityOf(inflowSeries));
  const outflowVolatility = round2(volatilityOf(outflowSeries));

  const seasonalInflowIdx = computeSeasonalIndex(monthlyHistory, lookbackMonths, 'inflow');
  const seasonalOutflowIdx = computeSeasonalIndex(monthlyHistory, lookbackMonths, 'outflow');

  const confidence = confidenceFromInputs({
    txnCount: totalTxnCount,
    activeMonths,
    lookbackMonths,
    volatility: (inflowVolatility + outflowVolatility) / 2,
  });
  // Wider bounds for lower confidence and for months further out in the horizon.
  const boundFactorAt = (monthIndex) => (0.08 + (1 - confidence.score / 100) * 0.35) * (1 + monthIndex * 0.12);

  const horizon = buildHorizon(horizonMonths, clockKey);
  let runningCash = { conservative: currentCash, base: currentCash, optimistic: currentCash };
  let firstDeficitMonth = null;
  let deficitMonthCount = 0;
  let lowestProjectedCash = currentCash;
  let conservativeCashFloor = currentCash;
  const totals = { base: { inflow: 0, outflow: 0 }, conservative: { inflow: 0, outflow: 0 }, optimistic: { inflow: 0, outflow: 0 } };

  const months = horizon.map((h, i) => {
    const scheduledInflow = round2(dues.inflowByMonth[h.key] || 0);
    const scheduledOutflow = round2(dues.outflowByMonth[h.key] || 0);

    let patternInflow = (inflowBaseline + inflowTrend * (i + 1)) * seasonalInflowIdx(h.calMonth);
    let patternOutflow = (outflowBaseline + outflowTrend * (i + 1)) * seasonalOutflowIdx(h.calMonth);
    patternInflow = Math.max(0, patternInflow);
    patternOutflow = Math.max(0, patternOutflow);

    // Current-month prorating: blend actual month-to-date with the
    // pattern-projected remainder of the month.
    if (i === 0) {
      const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
      const remaining = clamp(daysInMonth - today.getDate(), 0, daysInMonth) / daysInMonth;
      patternInflow = currentMonthActual.inflow + patternInflow * remaining;
      patternOutflow = currentMonthActual.outflow + patternOutflow * remaining;
    }

    patternInflow = round2(patternInflow);
    patternOutflow = round2(patternOutflow);

    const scenarios = {};
    for (const [name, mult] of Object.entries(SCENARIO_MULTIPLIERS)) {
      const scenarioPatternInflow = patternInflow * mult.inflow;
      const scenarioPatternOutflow = patternOutflow * mult.outflow;
      const inflow = round2(combineBaselineAndScheduled(scenarioPatternInflow, scheduledInflow));
      const outflow = round2(combineBaselineAndScheduled(scenarioPatternOutflow, scheduledOutflow));
      const net = round2(inflow - outflow);
      runningCash[name] = round2(runningCash[name] + net);
      totals[name].inflow += inflow;
      totals[name].outflow += outflow;

      if (name === 'base') {
        if (runningCash.base < 0 && firstDeficitMonth === null) firstDeficitMonth = h.key;
        if (runningCash.base < 0) deficitMonthCount += 1;
        if (runningCash.base < lowestProjectedCash) lowestProjectedCash = runningCash.base;
      }
      if (name === 'conservative' && runningCash.conservative < conservativeCashFloor) {
        conservativeCashFloor = runningCash.conservative;
      }

      const band = Math.abs(net) * boundFactorAt(i) + (scheduledInflow + scheduledOutflow) * 0.05;
      scenarios[name] = {
        inflow, outflow, net,
        projectedClosingCash: runningCash[name],
        lowerBound: round2(runningCash[name] - band),
        upperBound: round2(runningCash[name] + band),
      };
    }

    return {
      key: h.key,
      label: h.label,
      patternInflow,
      patternOutflow,
      scheduledInflow,
      scheduledOutflow,
      scenarios,
    };
  });

  const expectedTotalInflow = round2(totals.base.inflow);
  const expectedTotalOutflow = round2(totals.base.outflow);
  const netMovement = round2(expectedTotalInflow - expectedTotalOutflow);

  const risk = classifyRisk({ lowestProjectedCash, deficitMonthCount, currentCash });

  // Historical source mix — reuse kpi.service.js's own breakdown for the
  // most recently completed month so the "source mix" figure is guaranteed
  // to agree with the canonical expense breakdown, not a second derivation.
  const prevMonthStart = idxToKey(keyToIdx(clockKey) - 1) + '-01';
  const [recentRevenue, recentExpense] = await Promise.all([
    getRevenue(siteId, prevMonthStart, `${clockKey}-01`),
    getExpenseBreakdown(siteId, prevMonthStart, `${clockKey}-01`),
  ]);
  const sourceMix = {
    revenue: { plot_payments: round2(recentRevenue) },
    expense: Object.fromEntries(Object.entries(recentExpense.breakdown).map(([k, v]) => [k, round2(v.debit)])),
  };

  return {
    modelVersion: MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
    horizonMonths,
    lookbackMonths,
    currentCash,
    expectedTotalInflow,
    expectedTotalOutflow,
    netMovement,
    lowestProjectedCash: round2(lowestProjectedCash),
    firstDeficitMonth,
    deficitMonthCount,
    conservativeCashFloor: round2(conservativeCashFloor),
    riskLevel: risk.riskLevel,
    riskSummary: risk.summary,
    inflowTrendPct,
    outflowTrendPct,
    inflowVolatility,
    outflowVolatility,
    confidenceScore: confidence.score,
    confidenceLevel: confidence.level,
    history: monthlyHistory,
    weekdayPattern,
    sourceMix,
    dueItems: dues.context,
    months,
  };
}
