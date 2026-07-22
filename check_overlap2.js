import pg from 'pg'; import dotenv from 'dotenv'; dotenv.config();
const pool = new pg.Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl: process.env.DB_HOST?.includes('neon') ? { rejectUnauthorized: false } : false });
const fmt = (n) => new Intl.NumberFormat('en-IN').format(n);

console.log('=== TABLE SCHEMAS ===\n');
const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='day_book' ORDER BY ordinal_position`);
console.log('day_book:', cols.rows.map(r => r.column_name).join(', '));

const ecols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='expenses' ORDER BY ordinal_position`);
console.log('expenses:', ecols.rows.map(r => r.column_name).join(', '));

// Check if day_book has any linking column to expenses
const linkCols = cols.rows.map(r => r.column_name).filter(c => c.includes('expense') || c.includes('linked') || c.includes('ref'));
console.log('\nday_book link columns:', linkCols.length > 0 ? linkCols.join(', ') : 'NONE');

// Check for overlap by date + amount
console.log('\n=== CHECKING OVERLAP ===');
const overlap = await pool.query(`
  SELECT db.id as db_id, db.debit as db_debit, db.date as db_date, db.particular,
    e.id as exp_id, e.debit as exp_debit, e.from_entity, e.to_entity
  FROM day_book db
  JOIN expenses e ON e.site_id = db.site_id AND e.date = db.date AND e.debit = db.debit
  WHERE db.site_id = 2 AND db.entry_type = 'EXPENSE'
    AND (db.cheque_status IS NULL OR db.cheque_status NOT IN ('BOUNCED','RETURNED'))
    AND (e.cheque_status IS NULL OR e.cheque_status NOT IN ('BOUNCED','RETURNED'))
  ORDER BY db.date, db.id
`);
console.log(`\nPotential overlaps (day_book EXPENSE ↔ expenses, same date+debit): ${overlap.rows.length}`);
for (const r of overlap.rows) {
  console.log(`  db#${r.db_id} ₹${fmt(parseFloat(r.db_debit))} ${r.db_date} "${r.particular?.substring(0,30)}" ↔ exp#${r.exp_id} ₹${fmt(parseFloat(r.exp_debit))} ${r.from_entity || ''}→${r.to_entity || ''}`);
}

// All day_book entries in unified view
console.log('\n=== ALL DAY_BOOK ENTRIES IN EXPENSES UNIFIED ===');
const allDb = await pool.query(`
  SELECT id, date, particular, entry_type, debit, credit, farmer_payment_id
  FROM day_book
  WHERE site_id = 2 AND entry_type IN ('EXPENSE','FARMER PAYMENT','PLOT COMMISSION','VENDOR PAYMENT')
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  ORDER BY entry_type, id
`);
for (const r of allDb.rows) {
  const fp = r.farmer_payment_id ? ` [fp#${r.farmer_payment_id}]` : '';
  console.log(`  db#${r.id} ${r.entry_type} debit=₹${fmt(parseFloat(r.debit)||0)} credit=₹${fmt(parseFloat(r.credit)||0)} "${r.particular?.substring(0,40)}"${fp}`);
}

// All expenses table entries
console.log('\n=== ALL EXPENSES TABLE ENTRIES ===');
const allExp = await pool.query(`
  SELECT id, date, debit, credit, from_entity, to_entity, category, remark
  FROM expenses
  WHERE site_id = 2
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  ORDER BY id
`);
for (const r of allExp.rows) {
  console.log(`  exp#${r.id} debit=₹${fmt(parseFloat(r.debit)||0)} credit=₹${fmt(parseFloat(r.credit)||0)} ${r.from_entity||''}→${r.to_entity||''} [${r.category||''}] "${(r.remark||'').substring(0,30)}"`);
}

// Check plot_commissions
console.log('\n=== PLOT COMMISSIONS TABLE ===');
const pcCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='plot_commissions' ORDER BY ordinal_position`);
console.log('Columns:', pcCols.rows.map(r => r.column_name).join(', '));

const pcAll = await pool.query(`SELECT * FROM plot_commissions WHERE site_id=2 ORDER BY id`);
for (const r of pcAll.rows) {
  console.log(`  pc#${r.id} amount=₹${fmt(parseFloat(r.amount))} paid=₹${fmt(parseFloat(r.paid_amount)||0)} status=${r.status}`);
}

console.log('\n=== PLOT COMMISSION PAYMENTS TABLE ===');
const cpAll = await pool.query(`SELECT * FROM plot_commission_payments WHERE site_id=2 ORDER BY id`);
for (const r of cpAll.rows) {
  console.log(`  cp#${r.id} commission_id=${r.commission_id} amount=₹${fmt(parseFloat(r.amount))} date=${r.payment_date}`);
}

await pool.end();
