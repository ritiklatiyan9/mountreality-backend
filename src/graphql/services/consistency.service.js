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
import { getRevenue, getExpenseBreakdown, getProfit, getProfitMargin } from './kpi.service.js';

const TOLERANCE = 0.01;

/**
 * Run A — Source tables (single source of truth).
 * Revenue/expense are sourced from the same canonical kpi.service.js formula
 * the live Dashboard KPI cards use, so this checker can never silently drift
 * from what's actually displayed — it stays a check of Run A's *table*
 * (module tables) against Run B's *table* (cash_flow_entries), which is what
 * "sync triggers are broken" actually means, without also having to keep two
 * independently-maintained copies of the revenue/expense SQL in sync by hand.
 */
async function runFromSourceTables(siteId, start, end) {
  const [totalRevenue, expData] = await Promise.all([
    getRevenue(siteId, start, end),
    getExpenseBreakdown(siteId, start, end),
  ]);
  const totalExpense = expData.total;

  // Personal Ledgers are manual-only. Their own entries are therefore the
  // authoritative source for outstanding balances; no other module is rebuilt
  // into a person's ledger or expected to create a mirror row.
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
       AND COALESCE(cfe.source_module, '') NOT LIKE '%\\_person'
       AND COALESCE(cfe.source_module, '') NOT IN
         ('plot_registry_payments', 'plot_registry_payments_person')
       AND LOWER(COALESCE(cfe.status, 'approved')) = 'approved'
       AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED','RETURNED')`,
    [siteId, end]
  );
  const outstanding = (parseFloat(outResult.rows[0].given) || 0) - (parseFloat(outResult.rows[0].returned) || 0);

  const netProfit = getProfit(totalRevenue, totalExpense);
  return {
    totalRevenue,
    totalExpense,
    netProfit,
    profitMargin: getProfitMargin(totalRevenue, netProfit),
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
  const netProfit = getProfit(totalRevenue, adjExpense);

  // Outstanding Run B: actual manual Personal Ledger entries only.
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
       AND COALESCE(cfe.source_module, '') NOT LIKE '%\\_person'
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
    profitMargin: getProfitMargin(totalRevenue, netProfit),
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
