/**
 * KPI Service — Direct SQL aggregation against source tables.
 * All computations happen in PostgreSQL, never in JS.
 *
 * Plot Revenue   = plot_payments + plot_installment_payments
 * Total Incoming = approved cash_flow_entries credits in the selected period
 * Total Expenses = farmer_payments + expenses + plot_commission_payments
 *                  + legacy plot_commissions + vendor_payments
 *                  + orphan day_book EXPENSE
 * Plot Registry  = mapping of plot_payments only, NOT counted as new incoming/outgoing
 * Site Balance   = opening cash_flow_entries balance + incoming − outgoing
 * Outstanding    = person-ledger pending (given − returned)
 *
 * Person-ledger debit is intentionally NOT a business expense. It still affects
 * Site Balance once through the canonical cash-flow ledger, while Outstanding
 * remains a separate informational KPI.
 */
import pool from '../../config/db.js';

// ── Date range WHERE fragments ──
const dateFilter = (col, paramStart) =>
  `AND ${col} >= $${paramStart} AND ${col} < $${paramStart + 1}`;

// ── Revenue: plot_payments + plot_installment_payments ──
export async function getRevenue(siteId, start, end, excludeOldPlots = false) {
  const oldFilter = excludeOldPlots
    ? `AND UPPER(TRIM(COALESCE(plt.plot_tag, ''))) <> 'OLD'`
    : '';
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total
     FROM (
       SELECT pp.amount FROM plot_payments pp
       JOIN plots plt ON plt.id = pp.plot_id
       WHERE plt.site_id = $1 ${dateFilter('pp.date', 2)}
         AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
         ${oldFilter}
       UNION ALL
       SELECT pip.amount FROM plot_installment_payments pip
       JOIN plots p ON p.id = pip.plot_id
       WHERE p.site_id = $1 ${dateFilter('pip.payment_date', 2)}
         AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
         ${oldFilter.replace(/plt\./g, 'p.')}
     ) u`,
    [siteId, start, end]
  );
  return parseFloat(rows[0].total) || 0;
}

// ── Expense breakdown by module ──
// Total Expenses = farmer_payments + expenses + commissions + commission_payments
//                  + vendor_payments + orphan daybook EXPENSE
// NOTE: plot_registry_payments are EXCLUDED — they are just mapped plot payments.
// NOTE: personal-ledger debit is not a business expense. It remains part of the
// canonical cash-flow balance and the separate outstanding KPI.
export async function getExpenseBreakdown(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT source_type,
            COALESCE(SUM(debit), 0)::numeric AS total_debit,
            COUNT(*)::int AS txn_count
     FROM (
       SELECT fp.amount AS debit, 'farmer_payments' AS source_type
       FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
       WHERE f.site_id = $1 ${dateFilter('fp.date', 2)}
         AND UPPER(COALESCE(fp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
         AND LOWER(COALESCE(fp.status, 'approved')) = 'approved'
       UNION ALL
       -- Expense credits are refunds/recoveries. Treat them as a reduction of
       -- operating expense; the canonical ledger independently presents the
       -- same credit as money in, so it is neither lost nor double counted.
       SELECT COALESCE(debit, 0) - COALESCE(credit, 0) AS debit,
              'expenses' AS source_type
       FROM expenses
       WHERE site_id = $1 ${dateFilter('date', 2)}
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
       UNION ALL
       SELECT amount AS debit, 'plot_commissions' AS source_type
       FROM plot_commissions
       WHERE site_id = $1 ${dateFilter('date', 2)}
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
       UNION ALL
       SELECT amount AS debit, 'commission_payments' AS source_type
       FROM plot_commission_payments
       WHERE site_id = $1 ${dateFilter('date', 2)}
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
       UNION ALL
       SELECT amount AS debit, 'vendor_payments' AS source_type
       FROM vendor_payments
       WHERE site_id = $1 ${dateFilter('payment_date', 2)}
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
       UNION ALL
       SELECT COALESCE(debit, 0) - COALESCE(credit, 0) AS debit,
              'daybook_expense' AS source_type
       FROM day_book
       WHERE site_id = $1 ${dateFilter('date', 2)}
         AND UPPER(COALESCE(entry_type, '')) = 'EXPENSE'
         AND farmer_payment_id IS NULL AND commission_id IS NULL AND vendor_payment_id IS NULL
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
     ) u
     GROUP BY source_type`,
    [siteId, start, end]
  );

  const breakdown = {};
  let total = 0;
  for (const r of rows) {
    const val = parseFloat(r.total_debit) || 0;
    breakdown[r.source_type] = { debit: val, count: parseInt(r.txn_count) || 0 };
    total += val;
  }
  return { total, breakdown };
}

// ── Canonical cash flow and site balance ──
// Mirrors the Balance Sheet validity rules. Registry rows and imprest transfers
// are mapping/internal-transfer records, so they never create financial value.
export async function getSiteCashflow(siteId, start, end) {
  const { rows } = await pool.query(
    `WITH valid_entries AS (
       SELECT cfe.date::date AS entry_date,
              (
                GREATEST(COALESCE(cfe.credit, 0), 0)
                + GREATEST(-COALESCE(cfe.debit, 0), 0)
              )::numeric AS credit,
              (
                GREATEST(COALESCE(cfe.debit, 0), 0)
                + GREATEST(-COALESCE(cfe.credit, 0), 0)
              )::numeric AS debit
       FROM cash_flow_entries cfe
       LEFT JOIN day_book db
         ON cfe.source_module = 'day_book' AND db.id = cfe.source_id
       WHERE cfe.site_id = $1
         AND cfe.date::date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
         AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
         AND COALESCE(cfe.source_module, '') <> 'plot_registry_payments'
         AND COALESCE(cfe.source_module, '') NOT IN
           ('imprest', 'imprest_requests', 'document_imprest', 'document_imprest_requests')
         AND COALESCE(cfe.source_module, '') NOT LIKE '%\\_person'
         AND NOT (
           cfe.source_module = 'day_book'
           AND UPPER(COALESCE(db.entry_type, '')) = 'IMPREST'
         )
     )
     SELECT
       COALESCE(SUM(credit) FILTER (
         WHERE entry_date >= $2::date AND entry_date < $3::date
       ), 0)::numeric AS total_credit,
       COALESCE(SUM(debit) FILTER (
         WHERE entry_date >= $2::date AND entry_date < $3::date
       ), 0)::numeric AS total_debit,
       COALESCE(SUM(credit - debit) FILTER (
         WHERE entry_date < $2::date
       ), 0)::numeric AS opening_balance
     FROM valid_entries`,
    [siteId, start, end]
  );
  const credit = parseFloat(rows[0].total_credit) || 0;
  const debit = parseFloat(rows[0].total_debit) || 0;
  const openingBalance = parseFloat(rows[0].opening_balance) || 0;
  const net = credit - debit;
  return {
    incoming: credit,
    outgoing: debit,
    net,
    openingBalance,
    siteBalance: openingBalance + net,
  };
}

// ── Person Ledger Outstanding ──
// A standing balance is cumulative through the selected period end. The end
// supplied by the dashboard is exclusive, just like every in-period KPI, so a
// historical view must not pull in later or future-dated person movements.
export async function getOutstanding(siteId, _start, end) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(
         GREATEST(COALESCE(cfe.debit, 0), 0)
         + GREATEST(-COALESCE(cfe.credit, 0), 0)
       ), 0)::numeric AS given,
       COALESCE(SUM(
         GREATEST(COALESCE(cfe.credit, 0), 0)
         + GREATEST(-COALESCE(cfe.debit, 0), 0)
       ), 0)::numeric AS returned
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1
       AND cfe.date < $2
       AND LOWER(cfm.ledger_type) = 'person'
       AND COALESCE(cfe.source_module, '') NOT IN
         ('plot_registry_payments', 'plot_registry_payments_person')
       AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'`,
    [siteId, end]
  );
  const given = parseFloat(rows[0].given) || 0;
  const returned = parseFloat(rows[0].returned) || 0;
  return { given, returned, pending: given - returned };
}

// ── Personal Ledger Credit (date-filtered) — money received from persons ──
export async function getPersonalLedgerCredit(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(
              GREATEST(COALESCE(cfe.credit, 0), 0)
              + GREATEST(-COALESCE(cfe.debit, 0), 0)
            ), 0)::numeric AS total_credit
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1 ${dateFilter('cfe.date', 2)}
       AND LOWER(cfm.ledger_type) = 'person'
       AND COALESCE(cfe.source_module, '') NOT IN
         ('plot_registry_payments', 'plot_registry_payments_person')
       AND (
         GREATEST(COALESCE(cfe.credit, 0), 0)
         + GREATEST(-COALESCE(cfe.debit, 0), 0)
       ) > 0
       AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'`,
    [siteId, start, end]
  );
  return parseFloat(rows[0].total_credit) || 0;
}

// ── Registry Payments: informational mapping of underlying receipts ──
// A registry row never creates additional incoming/outgoing. This KPI follows
// source_plot_payment_id back to the one approved plot payment it documents and
// applies the same selected date window as the rest of the dashboard.
export async function getRegistryPayments(siteId, start, end) {
  const { rows } = await pool.query(
    `WITH mapped_payments AS (
       SELECT pp.id,
              pp.amount,
              (UPPER(TRIM(COALESCE(plt.plot_tag, ''))) = 'OLD') AS is_old
       FROM plot_registry_payments prp
       JOIN plot_payments pp ON pp.id = prp.source_plot_payment_id
       JOIN plots plt ON plt.id = pp.plot_id
       WHERE plt.site_id = $1 ${dateFilter('pp.date', 2)}
         AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
     )
     SELECT
       COALESCE(SUM(amount), 0)::numeric                                         AS total,
       COALESCE(SUM(amount) FILTER (WHERE is_old), 0)::numeric                   AS old_total,
       COALESCE(SUM(amount) FILTER (WHERE NOT is_old), 0)::numeric               AS new_total,
       COUNT(*)::int                                                             AS txn_count,
       COUNT(*) FILTER (WHERE is_old)::int                                       AS old_count,
       COUNT(*) FILTER (WHERE NOT is_old)::int                                   AS new_count
     FROM mapped_payments`,
    [siteId, start, end]
  );
  const r = rows[0];
  return {
    total:    parseFloat(r.total)     || 0,
    newTotal: parseFloat(r.new_total) || 0,
    oldTotal: parseFloat(r.old_total) || 0,
    count:    parseInt(r.txn_count, 10) || 0,
    newCount: parseInt(r.new_count, 10) || 0,
    oldCount: parseInt(r.old_count, 10) || 0,
  };
}

// ── Imprest: net outstanding (cash still held by sub-admins as imprest) ──
// Sourced from imprest_ledger, which records every allocation (+), expense (−)
// and refund (−). Summing per user and taking only positive balances yields
// "money currently sitting with sub-admins" — the only portion that should
// reduce Site Balance. Expenses spent from imprest are already in totalExpense,
// and accepted returns cancel out allocations, so both drop out automatically.
// Window is cumulative up to `end` (not `start..end`) because we want the
// standing balance at period end, not in-period flow.
export async function getImprestGiven(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(GREATEST(user_balance, 0)), 0)::numeric AS total
     FROM (
       SELECT user_id, COALESCE(SUM(amount), 0) AS user_balance
       FROM imprest_ledger
       WHERE site_id IS NOT NULL AND site_id = $1 AND created_at < $2
       GROUP BY user_id
     ) u`,
    [siteId, end]
  );
  return parseFloat(rows[0].total) || 0;
}

// ── Imprest giver→receiver pair totals ──
// One row per (giverId, receiverId) showing the final net transferred amount in the window.
// Counts every non-CANCELLED allocation regardless of receipt confirmation status so the
// Site Balance KPI can surface in-flight peer transfers too.
export async function getImprestPairs(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT
       ia.admin_id                                                            AS giver_id,
       COALESCE(NULLIF(TRIM(gv.name), ''), gv.email, CONCAT('USER #', ia.admin_id::text))     AS giver_name,
       gv.role                                                                AS giver_role,
       ia.sub_admin_id                                                        AS receiver_id,
       COALESCE(NULLIF(TRIM(rc.name), ''), rc.email, CONCAT('USER #', ia.sub_admin_id::text)) AS receiver_name,
       rc.role                                                                AS receiver_role,
       COALESCE(SUM(ia.amount), 0)::numeric                                   AS total_amount,
       COUNT(*)::int                                                          AS allocation_count
     FROM imprest_allocations ia
     LEFT JOIN users gv ON gv.id = ia.admin_id
     LEFT JOIN users rc ON rc.id = ia.sub_admin_id
     WHERE ia.site_id IS NOT NULL AND ia.site_id = $1 ${dateFilter('ia.created_at', 2)}
       AND ia.status != 'CANCELLED'
     GROUP BY ia.admin_id, gv.name, gv.email, gv.role, ia.sub_admin_id, rc.name, rc.email, rc.role
     HAVING COALESCE(SUM(ia.amount), 0) > 0
     ORDER BY total_amount DESC, giver_name ASC`,
    [siteId, start, end]
  );

  return rows.map((r) => ({
    giverId: parseInt(r.giver_id, 10),
    giverName: r.giver_name,
    giverRole: r.giver_role || 'user',
    receiverId: parseInt(r.receiver_id, 10),
    receiverName: r.receiver_name,
    receiverRole: r.receiver_role || 'user',
    totalAmount: parseFloat(r.total_amount) || 0,
    allocationCount: parseInt(r.allocation_count, 10) || 0,
  }));
}

// ── Imprest distribution: net outstanding per recipient ──
// Mirrors getImprestGiven semantics: per sub-admin, the current imprest_ledger
// balance (allocations − expenses − refunds), keeping only positive balances
// so the list sums to the Site Balance card's "Imprest Given" total.
export async function getImprestDistribution(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT
       il.user_id AS sub_admin_id,
       COALESCE(NULLIF(TRIM(sa.name), ''), sa.email, CONCAT('USER #', il.user_id::text)) AS recipient_name,
       SUM(il.amount)::numeric AS balance,
       COUNT(*) FILTER (WHERE il.type = 'ALLOCATION')::int AS allocation_count
     FROM imprest_ledger il
     LEFT JOIN users sa ON sa.id = il.user_id
     WHERE il.site_id IS NOT NULL AND il.site_id = $1 AND il.created_at < $2
     GROUP BY il.user_id, recipient_name
     HAVING SUM(il.amount) > 0
     ORDER BY balance DESC, recipient_name ASC`,
    [siteId, end]
  );

  return rows.map((r) => ({
    subAdminId: parseInt(r.sub_admin_id, 10),
    recipientName: r.recipient_name,
    totalAmount: parseFloat(r.balance) || 0,
    allocationCount: parseInt(r.allocation_count, 10) || 0,
  }));
}

// ── Canonical Profit / Margin — every consumer (Dashboard cards, charts,
// reports, Finance Forecast) must call these instead of re-deriving the
// formula, so a future policy change only has one place to edit. ──
export const getProfit = (revenue, expenseTotal) => revenue - expenseTotal;
export const getProfitMargin = (revenue, profit) =>
  revenue > 0 ? Math.round((profit / revenue) * 10000) / 100 : 0;

// ── Combined KPI fetch (single round-trip where possible) ──
export async function getAllKpis(siteId, start, end, excludeOldPlots = false) {
  const [revenue, expData, cashflow, outstanding, personalLedgerCredit, imprestGiven, imprestDistribution, registryPayments, imprestPairs] = await Promise.all([
    getRevenue(siteId, start, end, excludeOldPlots),
    getExpenseBreakdown(siteId, start, end),
    getSiteCashflow(siteId, start, end),
    getOutstanding(siteId, start, end),
    getPersonalLedgerCredit(siteId, start, end),
    getImprestGiven(siteId, start, end),
    getImprestDistribution(siteId, start, end),
    getRegistryPayments(siteId, start, end),
    getImprestPairs(siteId, start, end),
  ]);

  // Plot Revenue = plot payments + installments (used for operating profit).
  // Total Incoming / Outgoing / Site Balance come from the canonical ledger.
  // Total Expenses = farmer + expenses + commissions + vendors + orphan daybook
  // Profit = Plot Revenue - Total Expenses
  const netProfit = getProfit(revenue, expData.total);
  const profitMargin = getProfitMargin(revenue, netProfit);

  return {
    totalRevenue: revenue,
    totalIncoming: cashflow.incoming,
    totalOutgoing: cashflow.outgoing,
    openingBalance: cashflow.openingBalance,
    siteBalance: cashflow.siteBalance,
    totalExpense: expData.total,
    netProfit,
    profitMargin,
    outstanding: outstanding.pending,
    cashflow: cashflow.net,
    personalLedgerCredit,
    imprestGiven,
    imprestDistribution,
    imprestPairs,
    registryPayments: registryPayments.total,
    registryPaymentsCount: registryPayments.count,
    registryPaymentsNew: registryPayments.newTotal,
    registryPaymentsOld: registryPayments.oldTotal,
    registryPaymentsNewCount: registryPayments.newCount,
    registryPaymentsOldCount: registryPayments.oldCount,
    breakdown: {
      ...expData.breakdown,
      plot_payments: { credit: revenue, debit: 0, count: 0 },
    },
    cashflowDetail: cashflow,
    outstandingDetail: outstanding,
  };
}
