import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl: process.env.DB_HOST?.includes('neon') ? { rejectUnauthorized: false } : false });
const fmt = (n) => new Intl.NumberFormat('en-IN').format(n);

console.log('=== CHECKING OVERLAP / DOUBLE-COUNTING ===\n');

// 1. Check if EXPENSE day_book entries have corresponding expenses records
const dbExpenses = await pool.query(`
  SELECT db.id as db_id, db.debit, db.date, db.particular, db.expense_id,
    e.id as exp_id, e.debit as exp_debit
  FROM day_book db
  LEFT JOIN expenses e ON e.id = db.expense_id
  WHERE db.site_id = 2 AND db.entry_type = 'EXPENSE'
    AND (db.cheque_status IS NULL OR db.cheque_status NOT IN ('BOUNCED','RETURNED'))
  ORDER BY db.id
`);
console.log('Day_book EXPENSE entries (' + dbExpenses.rows.length + '):');
let linkedCount = 0;
for (const r of dbExpenses.rows) {
  const linked = r.exp_id ? 'LINKED→expenses#' + r.exp_id : 'NO LINK';
  if (r.exp_id) linkedCount++;
  console.log(`  db#${r.db_id} debit=₹${fmt(parseFloat(r.debit) || 0)} ${r.particular?.substring(0, 40)} [${linked}]`);
}
console.log(`  ${linkedCount} of ${dbExpenses.rows.length} linked to expenses table\n`);

// 2. Check if FARMER PAYMENT day_book entries have farmer_payment_id
const dbFarmer = await pool.query(`
  SELECT db.id as db_id, db.debit, db.date, db.particular, db.farmer_payment_id,
    fp.id as fp_id, fp.amount as fp_amount
  FROM day_book db
  LEFT JOIN farmer_payments fp ON fp.id = db.farmer_payment_id
  WHERE db.site_id = 2 AND db.entry_type = 'FARMER PAYMENT'
    AND (db.cheque_status IS NULL OR db.cheque_status NOT IN ('BOUNCED','RETURNED'))
  ORDER BY db.id
`);
console.log('Day_book FARMER PAYMENT entries (' + dbFarmer.rows.length + '):');
let fpLinked = 0;
for (const r of dbFarmer.rows) {
  const linked = r.fp_id ? 'LINKED→fp#' + r.fp_id + '(₹' + fmt(parseFloat(r.fp_amount)) + ')' : 'NO LINK';
  if (r.fp_id) fpLinked++;
  console.log(`  db#${r.db_id} debit=₹${fmt(parseFloat(r.debit) || 0)} ${r.particular?.substring(0, 40)} [${linked}]`);
}
console.log(`  ${fpLinked} of ${dbFarmer.rows.length} linked\n`);

// 3. Check expenses table entries that are NOT linked from any day_book entry
const standaloneExp = await pool.query(`
  SELECT e.id, e.debit, e.credit, e.from_entity, e.to_entity, e.category
  FROM expenses e
  WHERE e.site_id = 2
    AND (e.cheque_status IS NULL OR e.cheque_status NOT IN ('BOUNCED','RETURNED'))
    AND e.id NOT IN (SELECT expense_id FROM day_book WHERE expense_id IS NOT NULL AND site_id = 2)
  ORDER BY e.id
`);
console.log('Expenses table entries NOT linked from day_book (' + standaloneExp.rows.length + '):');
let sTotal = 0;
for (const r of standaloneExp.rows) {
  const d = parseFloat(r.debit) || 0;
  sTotal += d;
  console.log(`  exp#${r.id} debit=₹${fmt(d)} ${r.from_entity || ''} → ${r.to_entity || ''} [${r.category || ''}]`);
}
console.log(`  Standalone total: ₹${fmt(sTotal)}\n`);

// 4. Check day_book columns
const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='day_book' ORDER BY ordinal_position`);
console.log('day_book columns:', cols.rows.map(r => r.column_name).join(', '));

// 5. plot_commissions vs plot_commission_payments
const pcSum = await pool.query(`SELECT COALESCE(SUM(amount),0) as total, COUNT(*)::int as cnt FROM plot_commissions WHERE site_id=2`);
const cpSum = await pool.query(`SELECT COALESCE(SUM(amount),0) as total, COUNT(*)::int as cnt FROM plot_commission_payments WHERE site_id=2 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))`);
console.log(`\nplot_commissions: ${pcSum.rows[0].cnt} records, ₹${fmt(parseFloat(pcSum.rows[0].total))} (commission owed/defined)`);
console.log(`plot_commission_payments: ${cpSum.rows[0].cnt} records, ₹${fmt(parseFloat(cpSum.rows[0].total))} (actual payments made)`);

// 6. Check plot_commissions - are these actual expense payments or liability records?
const pcAll = await pool.query(`SELECT * FROM plot_commissions WHERE site_id=2 LIMIT 5`);
console.log('\nplot_commissions sample columns:', Object.keys(pcAll.rows[0] || {}).join(', '));

await pool.end();
