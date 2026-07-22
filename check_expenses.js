import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl: process.env.DB_HOST?.includes('neon') ? { rejectUnauthorized: false } : false });
const fmt = (n) => new Intl.NumberFormat('en-IN').format(n);

console.log('=== EXPENSE & COMMISSION ANALYSIS ===\n');

// 1. What Expenses page shows (unified query)
const unified = await pool.query(`
  SELECT COALESCE(SUM(debit),0) as total_debit, COALESCE(SUM(credit),0) as total_credit, COUNT(*)::int as cnt
  FROM (
    SELECT debit, credit FROM expenses WHERE site_id=2 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
    UNION ALL
    SELECT debit, credit FROM day_book WHERE site_id=2 AND entry_type IN ('EXPENSE','FARMER PAYMENT','PLOT COMMISSION','VENDOR PAYMENT') AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  ) u
`);
console.log('Expenses Page (unified):', 'Debit=₹' + fmt(parseFloat(unified.rows[0].total_debit)), 'Credit=₹' + fmt(parseFloat(unified.rows[0].total_credit)), 'Count=' + unified.rows[0].cnt);

// 2. What dashboard queries separately
const expOnly = await pool.query(`SELECT COALESCE(SUM(debit),0) as d, COALESCE(SUM(credit),0) as c FROM expenses WHERE site_id=2 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))`);
console.log('Dashboard expenses table:', 'Debit=₹' + fmt(parseFloat(expOnly.rows[0].d)), 'Credit=₹' + fmt(parseFloat(expOnly.rows[0].c)));

const fpOnly = await pool.query(`SELECT COALESCE(SUM(fp.amount),0) as d FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id WHERE f.site_id=2 AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED','RETURNED'))`);
console.log('Dashboard farmer_payments:', 'Debit=₹' + fmt(parseFloat(fpOnly.rows[0].d)));

const pcOnly = await pool.query(`SELECT COALESCE(SUM(amount),0) as d FROM plot_commissions WHERE site_id=2`);
console.log('Dashboard plot_commissions:', 'Debit=₹' + fmt(parseFloat(pcOnly.rows[0].d)));

const cpOnly = await pool.query(`SELECT COALESCE(SUM(amount),0) as d FROM plot_commission_payments WHERE site_id=2 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))`);
console.log('Dashboard plot_commission_payments:', 'Debit=₹' + fmt(parseFloat(cpOnly.rows[0].d)));

const vpOnly = await pool.query(`SELECT COALESCE(SUM(amount),0) as d FROM vendor_payments WHERE site_id=2 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))`);
console.log('Dashboard vendor_payments:', 'Debit=₹' + fmt(parseFloat(vpOnly.rows[0].d)));

// 3. Break down by source in unified
const bySource = await pool.query(`
  SELECT source, COALESCE(SUM(debit),0) as d, COALESCE(SUM(credit),0) as c, COUNT(*)::int as cnt FROM (
    SELECT debit, credit, 'expenses' as source FROM expenses WHERE site_id=2 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
    UNION ALL
    SELECT debit, credit, 'daybook_' || entry_type as source FROM day_book WHERE site_id=2 AND entry_type IN ('EXPENSE','FARMER PAYMENT','PLOT COMMISSION','VENDOR PAYMENT') AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  ) u GROUP BY source ORDER BY source
`);
console.log('\nUnified breakdown by source:');
for (const r of bySource.rows) {
  console.log(`  ${r.source}: Debit=₹${fmt(parseFloat(r.d))} Credit=₹${fmt(parseFloat(r.c))} Count=${r.cnt}`);
}

// 4. Check for overlap: do expenses rows have linked day_book entries?
const linked = await pool.query(`
  SELECT COUNT(*) as cnt FROM day_book WHERE site_id=2 AND entry_type IN ('EXPENSE','FARMER PAYMENT','PLOT COMMISSION','VENDOR PAYMENT')
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
`);
console.log('\nDay_book entries included in Expenses page:', linked.rows[0].cnt);

// 5. Dashboard total expense
const dashExpense = parseFloat(expOnly.rows[0].d) + parseFloat(fpOnly.rows[0].d) + parseFloat(pcOnly.rows[0].d) + parseFloat(cpOnly.rows[0].d) + parseFloat(vpOnly.rows[0].d);
console.log('\nDashboard total expense (sum of all modules):', '₹' + fmt(dashExpense));
console.log('Expenses page total_debit:', '₹' + fmt(parseFloat(unified.rows[0].total_debit)));
console.log('Difference:', '₹' + fmt(parseFloat(unified.rows[0].total_debit) - dashExpense));

// 6. Check plot_commissions vs plot_commission_payments - are these different tables?
const pcDetails = await pool.query(`SELECT id, plot_id, amount, commission_type FROM plot_commissions WHERE site_id=2 ORDER BY id LIMIT 10`);
console.log('\nplot_commissions table sample:');
for (const r of pcDetails.rows) console.log(`  id=${r.id} plot=${r.plot_id} amount=₹${fmt(parseFloat(r.amount))} type=${r.commission_type}`);

const cpDetails = await pool.query(`SELECT id, commission_id, amount, payment_date FROM plot_commission_payments WHERE site_id=2 ORDER BY id LIMIT 10`);
console.log('\nplot_commission_payments table sample:');
for (const r of cpDetails.rows) console.log(`  id=${r.id} commission=${r.commission_id} amount=₹${fmt(parseFloat(r.amount))} date=${r.payment_date}`);

await pool.end();
