import pool from './src/config/db.js';
const siteId = 5;

// Check registry payments: linked vs manual
const r1 = await pool.query(`SELECT COUNT(*) AS total, SUM(amount)::numeric AS total_amt FROM plot_registry_payments WHERE site_id = $1`, [siteId]);
const r2 = await pool.query(`SELECT COUNT(*) AS linked, SUM(amount)::numeric AS linked_amt FROM plot_registry_payments WHERE site_id = $1 AND source_plot_payment_id IS NOT NULL`, [siteId]);
const r3 = await pool.query(`SELECT COUNT(*) AS manual, SUM(amount)::numeric AS manual_amt FROM plot_registry_payments WHERE site_id = $1 AND source_plot_payment_id IS NULL`, [siteId]);
console.log('=== REGISTRY PAYMENTS ===');
console.log('Total:', r1.rows[0]);
console.log('Linked (from plot_payments):', r2.rows[0]);
console.log('Manual (genuinely new):', r3.rows[0]);

// Revenue
const rev = await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM (
  SELECT amount FROM plot_payments WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT amount FROM plot_installment_payments WHERE plot_id IN (SELECT id FROM plots WHERE site_id = $1) AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
) u`, [siteId]);
console.log('\n=== REVENUE (plot_payments + installments) ===');
console.log('Total:', rev.rows[0].total);

// Site cashflow
const cf = await pool.query(`SELECT
  COALESCE(SUM(cfe.credit),0)::numeric AS incoming,
  COALESCE(SUM(cfe.debit),0)::numeric AS outgoing
FROM cash_flow_entries cfe
JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
WHERE cfe.site_id = $1 AND LOWER(cfm.ledger_type) = 'site'
AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`, [siteId]);
console.log('\n=== SITE CASHFLOW ===');
console.log('Incoming:', cf.rows[0].incoming, 'Outgoing:', cf.rows[0].outgoing);

// Person ledger
const pl = await pool.query(`SELECT
  COALESCE(SUM(cfe.debit),0)::numeric AS given,
  COALESCE(SUM(cfe.credit),0)::numeric AS returned
FROM cash_flow_entries cfe
JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
WHERE cfe.site_id = $1 AND LOWER(cfm.ledger_type) = 'person'
AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`, [siteId]);
console.log('\n=== PERSON LEDGER ===');
console.log('Given:', pl.rows[0].given, 'Returned:', pl.rows[0].returned, 'Pending:', parseFloat(pl.rows[0].given) - parseFloat(pl.rows[0].returned));

// Expenses (with fix)
const exp = await pool.query(`SELECT source_type, COALESCE(SUM(debit),0)::numeric AS total FROM (
  SELECT fp.amount AS debit, 'farmer_payments' AS source_type FROM farmer_payments fp JOIN farmers f ON f.id = fp.farmer_id WHERE f.site_id = $1 AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT debit, 'expenses' FROM expenses WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT amount AS debit, 'plot_registry_payments' FROM plot_registry_payments WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED')) AND source_plot_payment_id IS NULL
  UNION ALL
  SELECT amount AS debit, 'commissions' FROM plot_commissions WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT amount AS debit, 'commission_payments' FROM plot_commission_payments WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT amount AS debit, 'vendor_payments' FROM vendor_payments WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
) u GROUP BY source_type`, [siteId]);
console.log('\n=== EXPENSES (fixed - no linked registry) ===');
let totalExp = 0;
for (const r of exp.rows) { console.log(r.source_type + ':', r.total); totalExp += parseFloat(r.total); }
console.log('TOTAL EXPENSE:', totalExp);
console.log('PROFIT:', parseFloat(rev.rows[0].total) - totalExp);

await pool.end();
