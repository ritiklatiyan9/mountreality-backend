/**
 * Consistency Service — Dual-run financial verification.
 *
 * Run A: Aggregate from SOURCE TABLES directly (plot_payments, expenses, etc.)
 * Run B: Aggregate from CASH_FLOW_ENTRIES (sync table maintained by triggers)
 *
 * If Run A ≠ Run B → sync triggers are broken → CRITICAL flag.
 *
 * Tolerance: ₹0.01 (floating-point rounding)
 */
import pool from '../../config/db.js';

const TOLERANCE = 0.01;

/**
 * Run A — Source tables (single source of truth).
 * Mirrors getProfitSummary logic exactly.
 */
async function runFromSourceTables(siteId, start, end) {
  // Revenue: plot_payments + installments
  const revResult = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total
     FROM (
       SELECT pp.amount FROM plot_payments pp
       JOIN plots plt ON plt.id = pp.plot_id
       WHERE plt.site_id = $1 AND pp.date >= $2 AND pp.date < $3
         AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       UNION ALL
       SELECT pip.amount FROM plot_installment_payments pip
       JOIN plots p ON p.id = pip.plot_id
       WHERE p.site_id = $1 AND pip.payment_date >= $2 AND pip.payment_date < $3
         AND UPPER(COALESCE(pip.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
     ) u`,
    [siteId, start, end]
  );
  const totalRevenue = parseFloat(revResult.rows[0].total) || 0;

  // Expense: mirror getProfitSummary exactly. Person-ledger debit is a financing
  // movement rather than an operating expense, and is verified separately as
  // outstanding.
  const expResult = await pool.query(
    `SELECT COALESCE(SUM(debit), 0)::numeric AS total
     FROM (
       SELECT fp.amount AS debit FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
       WHERE f.site_id = $1 AND fp.date >= $2 AND fp.date < $3
         AND LOWER(COALESCE(fp.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(fp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       UNION ALL
       SELECT COALESCE(debit, 0) - COALESCE(credit, 0) AS debit FROM expenses
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       UNION ALL
       SELECT amount AS debit FROM plot_commissions
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       UNION ALL
       SELECT amount AS debit FROM plot_commission_payments
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       UNION ALL
       SELECT amount AS debit FROM vendor_payments
       WHERE site_id = $1 AND payment_date >= $2 AND payment_date < $3
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       UNION ALL
       SELECT COALESCE(debit, 0) - COALESCE(credit, 0) AS debit FROM day_book
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND UPPER(COALESCE(entry_type, '')) = 'EXPENSE'
         AND farmer_payment_id IS NULL AND commission_id IS NULL AND vendor_payment_id IS NULL
         AND LOWER(COALESCE(status, 'approved')) = 'approved'
         AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
     ) u`,
    [siteId, start, end]
  );
  const totalExpense = parseFloat(expResult.rows[0].total) || 0;

  // Outstanding Run A: direct person-ledger entries are already their own
  // source of truth, while mapped person movements are independently rebuilt
  // from the seven module tables that should have produced `%_person` mirrors.
  // This makes the verifier capable of detecting a missing/stale mirror instead
  // of comparing the same cash_flow_entries query with itself.
  const outResult = await pool.query(
    `WITH source_person_movements AS (
       SELECT fp.date::date AS entry_date, fp.amount::numeric AS debit, 0::numeric AS credit
       FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
       WHERE f.site_id = $1 AND fp.date < $2
         AND (fp.mapped_member_id IS NOT NULL OR fp.mapped_user_id IS NOT NULL)
         AND LOWER(COALESCE(fp.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(fp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

       UNION ALL
       SELECT pcp.date::date, pcp.amount::numeric, 0::numeric
       FROM plot_commission_payments pcp
       WHERE pcp.site_id = $1 AND pcp.date < $2
         AND (pcp.mapped_member_id IS NOT NULL OR pcp.mapped_user_id IS NOT NULL)
         AND LOWER(COALESCE(pcp.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(pcp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

       UNION ALL
       SELECT db.date::date, db.debit::numeric, db.credit::numeric
       FROM day_book db
       WHERE db.site_id = $1 AND db.date < $2
         AND (db.mapped_member_id IS NOT NULL OR db.mapped_user_id IS NOT NULL)
         AND UPPER(COALESCE(db.entry_type, 'GENERAL')) NOT IN
           ('CASH FLOW', 'FARMER PAYMENT', 'PLOT COMMISSION',
            'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT')
         AND LOWER(COALESCE(db.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(db.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

       UNION ALL
       SELECT ft.date::date, ft.debit::numeric, ft.credit::numeric
       FROM firm_transactions ft
       WHERE ft.site_id = $1 AND ft.date < $2
         AND (ft.mapped_member_id IS NOT NULL OR ft.mapped_user_id IS NOT NULL)
         AND LOWER(COALESCE(ft.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(ft.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

       UNION ALL
       SELECT pp.date::date, 0::numeric, pp.amount::numeric
       FROM plot_payments pp
       WHERE pp.site_id = $1 AND pp.date < $2
         AND (pp.mapped_member_id IS NOT NULL OR pp.mapped_user_id IS NOT NULL)
         AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(pp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

       UNION ALL
       SELECT ex.date::date, ex.debit::numeric, ex.credit::numeric
       FROM expenses ex
       WHERE ex.site_id = $1 AND ex.date < $2
         AND (ex.mapped_member_id IS NOT NULL OR ex.mapped_user_id IS NOT NULL)
         AND LOWER(COALESCE(ex.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(ex.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')

       UNION ALL
       SELECT vp.payment_date::date, vp.amount::numeric, 0::numeric
       FROM vendor_payments vp
       WHERE vp.site_id = $1 AND vp.payment_date < $2
         AND (vp.mapped_member_id IS NOT NULL OR vp.mapped_user_id IS NOT NULL)
         AND LOWER(COALESCE(vp.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(vp.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
     ), direct_person_movements AS (
       SELECT cfe.date::date AS entry_date, cfe.debit::numeric, cfe.credit::numeric
       FROM cash_flow_entries cfe
       JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
       WHERE cfe.site_id = $1 AND cfe.date < $2
         AND LOWER(cfm.ledger_type) = 'person'
         AND COALESCE(cfe.source_module, '') NOT LIKE '%\\_person'
         AND COALESCE(cfe.source_module, '') NOT IN
           ('plot_registry_payments', 'plot_registry_payments_person')
         AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
         AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
     ), person_movements AS (
       SELECT debit, credit FROM source_person_movements
       UNION ALL
       SELECT debit, credit FROM direct_person_movements
     )
     SELECT
       COALESCE(SUM(
         GREATEST(COALESCE(debit, 0), 0)
         + GREATEST(-COALESCE(credit, 0), 0)
       ), 0)::numeric AS given,
       COALESCE(SUM(
         GREATEST(COALESCE(credit, 0), 0)
         + GREATEST(-COALESCE(debit, 0), 0)
       ), 0)::numeric AS returned
     FROM person_movements`,
    [siteId, end]
  );
  const outstanding = (parseFloat(outResult.rows[0].given) || 0) - (parseFloat(outResult.rows[0].returned) || 0);

  const netProfit = totalRevenue - totalExpense;
  return {
    totalRevenue,
    totalExpense,
    netProfit,
    profitMargin: totalRevenue > 0 ? Math.round((netProfit / totalRevenue) * 10000) / 100 : 0,
    outstanding,
    // Kept for GraphQL backward compatibility. It is the same independently
    // derived profit-module net, not a second cash-flow assertion.
    cashflow: netProfit,
  };
}

/**
 * Run B — Cash flow entries table (trigger-synced mirror).
 * Profit modules only, matching the exact set used in Run A / getProfitSummary.
 */
async function runFromCashFlowEntries(siteId, start, end) {
  // Revenue side: plot payments + installments
  const revenueModules = ['plot_payments', 'plot_installment_payments'];
  // Expense side: every source table that contributes to canonical totalExpense.
  // Registry is intentionally absent because it only maps an underlying receipt.
  const expenseModules = [
    'farmer_payments', 'expenses',
    'plot_commissions', 'plot_commission_payments',
    'vendor_payments',
  ];

  const revPlaceholders = revenueModules.map((_, i) => `$${i + 4}`).join(', ');
  const revResult = await pool.query(
    `SELECT COALESCE(SUM(credit), 0)::numeric AS total_credit
     FROM cash_flow_entries cfe
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND cfe.source_module IN (${revPlaceholders})
       AND COALESCE(cfe.source_module, '') <> 'plot_registry_payments'
       AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'`,
    [siteId, start, end, ...revenueModules]
  );
  const totalRevenue = parseFloat(revResult.rows[0].total_credit) || 0;

  const expPlaceholders = expenseModules.map((_, i) => `$${i + 4}`).join(', ');
  const expResult = await pool.query(
    `SELECT COALESCE(SUM(COALESCE(debit, 0) - COALESCE(credit, 0)), 0)::numeric AS total_debit
     FROM cash_flow_entries cfe
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND cfe.source_module IN (${expPlaceholders})
       AND COALESCE(cfe.source_module, '') <> 'plot_registry_payments'
       AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'`,
    [siteId, start, end, ...expenseModules]
  );
  const totalExpense = parseFloat(expResult.rows[0].total_debit) || 0;

  // Orphan day_book EXPENSE entries synced to cash_flow
  const orphanResult = await pool.query(
    `SELECT COALESCE(SUM(COALESCE(cfe.debit, 0) - COALESCE(cfe.credit, 0)), 0)::numeric AS total
     FROM cash_flow_entries cfe
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND cfe.source_module = 'day_book'
       AND COALESCE(cfe.source_module, '') <> 'plot_registry_payments'
       AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
       AND EXISTS (
         SELECT 1 FROM day_book db
         WHERE db.id = cfe.source_id AND UPPER(COALESCE(db.entry_type, '')) = 'EXPENSE'
           AND db.farmer_payment_id IS NULL AND db.commission_id IS NULL AND db.vendor_payment_id IS NULL
       )`,
    [siteId, start, end]
  );
  const orphanExpense = parseFloat(orphanResult.rows[0].total) || 0;

  // Person-ledger debit belongs to outstanding, not operating expense.
  const adjExpense = totalExpense + orphanExpense;
  const netProfit = totalRevenue - adjExpense;

  // Outstanding Run B: actual person-ledger rows, including module `_person`
  // mirrors. Registry mappings remain informational and never form a balance.
  const outResult = await pool.query(
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
     WHERE cfe.site_id = $1 AND cfe.date < $2
       AND LOWER(cfm.ledger_type) = 'person'
       AND COALESCE(cfe.source_module, '') NOT IN
         ('plot_registry_payments', 'plot_registry_payments_person')
       AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')
       AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'`,
    [siteId, end]
  );
  const outstanding = (parseFloat(outResult.rows[0].given) || 0) - (parseFloat(outResult.rows[0].returned) || 0);

  return {
    totalRevenue,
    totalExpense: adjExpense,
    netProfit,
    profitMargin: totalRevenue > 0 ? Math.round((netProfit / totalRevenue) * 10000) / 100 : 0,
    outstanding,
    cashflow: netProfit,
  };
}

/**
 * Compare two KPI objects, return list of discrepancies.
 */
function compareRuns(runA, runB) {
  const kpis = ['totalRevenue', 'totalExpense', 'netProfit', 'profitMargin', 'outstanding'];
  const discrepancies = [];
  for (const kpi of kpis) {
    const a = runA[kpi];
    const b = runB[kpi];
    const diff = Math.abs(a - b);
    if (diff > TOLERANCE) {
      discrepancies.push({
        kpi,
        runAValue: a,
        runBValue: b,
        diff,
        severity: diff > 100 ? 'CRITICAL' : 'WARNING',
      });
    }
  }
  return discrepancies;
}

/**
 * SQL queries used — exposed for transparency panel.
 */
export function getQueryDescriptions() {
  return {
    totalRevenue: {
      runA: 'SUM(amount) FROM approved plot_payments + posted plot_installment_payments WHERE site_id, date range, and cheque status is valid',
      runB: 'SUM(credit) FROM approved cash_flow_entries WHERE source_module IN (plot_payments, plot_installment_payments), date range, and registry is excluded',
    },
    totalExpense: {
      runA: 'SUM(amount/debit) FROM approved farmer_payments + expenses + plot_commissions + plot_commission_payments + vendor_payments + orphan day_book EXPENSE rows. Registry and person-ledger debit are excluded.',
      runB: 'SUM(debit) FROM approved cash_flow_entries for the same expense modules plus orphan day_book EXPENSE rows. Registry and person-ledger debit are excluded.',
    },
    netProfit: {
      formula: 'totalRevenue − totalExpense',
    },
    profitMargin: {
      formula: '(netProfit / totalRevenue) × 100',
    },
    outstanding: {
      runA: 'Direct person-ledger entries plus independently rebuilt approved mapped-module movements before the exclusive period end; bounced/returned and registry mappings excluded',
      runB: 'Signed approved person-ledger entries, including mapped mirrors, before the exclusive period end; bounced/returned and registry mappings excluded',
      formula: 'normalized given − normalized returned',
    },
    cashflow: {
      formula: 'Backward-compatible alias of netProfit; not compared as an independent assertion',
    },
  };
}

/**
 * Main verification function — runs both paths and compares.
 */
export async function verifyFinancialIntegrity(siteId, start, end) {
  const [runA, runB] = await Promise.all([
    runFromSourceTables(siteId, start, end),
    runFromCashFlowEntries(siteId, start, end),
  ]);

  const discrepancies = compareRuns(runA, runB);

  return {
    passed: discrepancies.length === 0,
    runA,
    runB,
    discrepancies,
    queriesUsed: getQueryDescriptions(),
    checkedAt: new Date().toISOString(),
  };
}
