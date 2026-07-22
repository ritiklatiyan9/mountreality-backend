import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl: process.env.DB_HOST?.includes('neon') ? { rejectUnauthorized: false } : false });
const fmt = (n) => new Intl.NumberFormat('en-IN').format(n);

console.log('=== VERIFY NEW DASHBOARD QUERY ===\n');

// Earn
const earn = await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM plot_payments WHERE site_id=2 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))`);
const totalEarn = parseFloat(earn.rows[0].total);
console.log('Earn (Plot Payments):', '₹' + fmt(totalEarn));

// Expenses unified
const exp = await pool.query(`
  SELECT source_type, COALESCE(SUM(debit),0)::numeric AS total_debit FROM (
    SELECT debit, 'expenses' AS source_type FROM expenses WHERE site_id=2 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
    UNION ALL
    SELECT debit, CASE entry_type WHEN 'EXPENSE' THEN 'expenses' WHEN 'FARMER PAYMENT' THEN 'farmer_payments' WHEN 'PLOT COMMISSION' THEN 'commissions' WHEN 'VENDOR PAYMENT' THEN 'vendor_payments' END AS source_type
    FROM day_book WHERE site_id=2 AND entry_type IN ('EXPENSE','FARMER PAYMENT','PLOT COMMISSION','VENDOR PAYMENT') AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  ) u GROUP BY source_type
`);
let totalExpense = 0;
console.log('\nExpenses breakdown:');
for (const r of exp.rows) {
  const d = parseFloat(r.total_debit);
  totalExpense += d;
  console.log(`  ${r.source_type}: ₹${fmt(d)}`);
}
console.log(`  TOTAL: ₹${fmt(totalExpense)}`);

const profit = totalEarn - totalExpense;
console.log(`\nProfit: ₹${fmt(totalEarn)} - ₹${fmt(totalExpense)} = ₹${fmt(profit)}`);

// Person pending (unchanged)
const person = await pool.query(`
  SELECT COALESCE(SUM(cfe.debit),0) as given, COALESCE(SUM(cfe.credit),0) as returned
  FROM cash_flow_entries cfe JOIN cash_flow_months cfm ON cfm.id=cfe.cash_flow_month_id
  WHERE cfe.site_id=2 AND cfm.ledger_type='person'
    AND (cfe.source_module IS NULL OR cfe.source_module NOT IN ('plot_payments','farmer_payments','expenses','plot_commissions','plot_commission_payments','vendor_payments'))
    AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
`);
const pending = parseFloat(person.rows[0].given) - parseFloat(person.rows[0].returned);
console.log(`Personal Pending: ₹${fmt(pending)}`);
console.log(`Balance: ₹${fmt(profit)} - ₹${fmt(pending)} = ₹${fmt(profit - pending)}`);

// Firm (new query)
const firm = await pool.query(`
  SELECT
    COALESCE((SELECT SUM(ft.debit) FROM firm_transactions ft JOIN firms f ON f.id=ft.firm_id WHERE f.site_id=2 AND (ft.cheque_status IS NULL OR ft.cheque_status NOT IN ('BOUNCED','RETURNED'))),0)
    + COALESCE((SELECT SUM(COALESCE(cfe.debit,0)+COALESCE(cfe.credit,0)) FROM cash_flow_entries cfe JOIN firms f ON f.id=cfe.from_firm_id WHERE f.site_id=2 AND cfe.is_firm_transaction=true AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))),0)
    AS total_debit,
    COALESCE((SELECT SUM(ft.credit) FROM firm_transactions ft JOIN firms f ON f.id=ft.firm_id WHERE f.site_id=2 AND (ft.cheque_status IS NULL OR ft.cheque_status NOT IN ('BOUNCED','RETURNED'))),0)
    + COALESCE((SELECT SUM(COALESCE(cfe.debit,0)+COALESCE(cfe.credit,0)) FROM cash_flow_entries cfe JOIN firms f ON f.id=cfe.to_firm_id WHERE f.site_id=2 AND cfe.is_firm_transaction=true AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))),0)
    AS total_credit
`);
console.log(`\nFirm: Debit=₹${fmt(parseFloat(firm.rows[0].total_debit))} Credit=₹${fmt(parseFloat(firm.rows[0].total_credit))}`);

// Expenses page check
const expPage = await pool.query(`
  SELECT COALESCE(SUM(debit),0) as total FROM (
    SELECT debit FROM expenses WHERE site_id=2 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
    UNION ALL
    SELECT debit FROM day_book WHERE site_id=2 AND entry_type IN ('EXPENSE','FARMER PAYMENT','PLOT COMMISSION','VENDOR PAYMENT') AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  ) u
`);
console.log(`\nExpenses page total: ₹${fmt(parseFloat(expPage.rows[0].total))}`);
console.log(`Dashboard expense total: ₹${fmt(totalExpense)}`);
console.log('Match: ' + (Math.abs(parseFloat(expPage.rows[0].total) - totalExpense) < 0.01 ? '✅' : '❌'));

await pool.end();
