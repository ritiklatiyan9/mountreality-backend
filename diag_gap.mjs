import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({
  host: process.env.DB_HOST, port: +process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD || ''), ssl: { rejectUnauthorized: false },
});

const SITE_ID = 5;
const fmt = n => Number(n).toLocaleString('en-IN');

// 1) Expenses page unified CTE (ALL TIME, no date filter)
const expPageQ = `
SELECT source, COALESCE(SUM(debit),0)::numeric AS total, COUNT(*)::int AS cnt FROM (
  SELECT debit, 'expenses' as source FROM expenses
  WHERE site_id=$1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT fp.amount, 'farmer_payment' FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id
  WHERE f.site_id=$1 AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT pcp.amount, 'commission' FROM plot_commission_payments pcp
  JOIN plot_commissions_v2 pcm ON pcp.plot_commission_id=pcm.id
  WHERE pcp.site_id=$1 AND (pcp.cheque_status IS NULL OR pcp.cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT vp.amount, 'vendor_payment' FROM vendor_payments vp JOIN vendor_commitments vc ON vp.commitment_id=vc.id
  WHERE vp.site_id=$1 AND (vp.cheque_status IS NULL OR vp.cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT cfe.debit, 'personal_ledger' FROM cash_flow_entries cfe
  JOIN cash_flow_months cfm ON cfm.id=cfe.cash_flow_month_id
  WHERE cfe.site_id=$1 AND LOWER(cfm.ledger_type)='person' AND cfe.debit>0
  AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT d.debit, 'daybook' FROM day_book d
  WHERE d.site_id=$1 AND d.entry_type='EXPENSE'
  AND d.farmer_payment_id IS NULL AND d.commission_id IS NULL AND d.vendor_payment_id IS NULL
  AND (d.cheque_status IS NULL OR d.cheque_status NOT IN ('BOUNCED','RETURNED'))
) u GROUP BY source ORDER BY total DESC
`;

// 2) Consistency Run A (with date range used by dashboard)
// The dashboard typically passes start='1970-01-01' and end=far future for "All Time"
// But let's check what range the consistency check actually uses
const consistQ = `
SELECT source_type, COALESCE(SUM(debit),0)::numeric AS total, COUNT(*)::int AS cnt FROM (
  SELECT fp.amount AS debit, 'farmer_payments' AS source_type
  FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id
  WHERE f.site_id=$1 AND fp.date >= $2 AND fp.date < $3
  AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT debit, 'expenses' FROM expenses
  WHERE site_id=$1 AND date >= $2 AND date < $3
  AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT amount, 'commission_payments' FROM plot_commission_payments
  WHERE site_id=$1 AND date >= $2 AND date < $3
  AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT amount, 'vendor_payments' FROM vendor_payments
  WHERE site_id=$1 AND payment_date >= $2 AND payment_date < $3
  AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT cfe.debit, 'personal_ledger_debit' FROM cash_flow_entries cfe
  JOIN cash_flow_months cfm ON cfm.id=cfe.cash_flow_month_id
  WHERE cfe.site_id=$1 AND cfe.date >= $2 AND cfe.date < $3
  AND LOWER(cfm.ledger_type)='person' AND cfe.debit>0
  AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
  UNION ALL
  SELECT debit, 'daybook_expense' FROM day_book
  WHERE site_id=$1 AND date >= $2 AND date < $3
  AND entry_type='EXPENSE'
  AND farmer_payment_id IS NULL AND commission_id IS NULL AND vendor_payment_id IS NULL
  AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
) u GROUP BY source_type ORDER BY total DESC
`;

// Check what date range the dashboard sends
const dateRangeQ = `
  SELECT MIN(date) as earliest, MAX(date) as latest FROM (
    SELECT fp.date FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id WHERE f.site_id=$1
    UNION ALL SELECT date FROM plot_commission_payments WHERE site_id=$1
    UNION ALL SELECT cfe.date FROM cash_flow_entries cfe JOIN cash_flow_months cfm ON cfm.id=cfe.cash_flow_month_id WHERE cfe.site_id=$1 AND LOWER(cfm.ledger_type)='person' AND cfe.debit>0
  ) u
`;

const dateInfo = (await pool.query(dateRangeQ, [SITE_ID])).rows[0];
console.log(`=== Date range of data: ${dateInfo.earliest} to ${dateInfo.latest} ===`);

// Run both
const [expRes, consistRes] = await Promise.all([
  pool.query(expPageQ, [SITE_ID]),
  pool.query(consistQ, [SITE_ID, '1970-01-01', '2100-01-01']), // all time
]);

console.log('\n=== Expenses Page (ALL TIME, no date filter) ===');
let expTotal = 0;
for (const r of expRes.rows) {
  console.log(`  ${r.source.padEnd(25)} ₹${fmt(r.total).padStart(15)}  (${r.cnt})`);
  expTotal += Number(r.total);
}
console.log(`  ${'TOTAL'.padEnd(25)} ₹${fmt(expTotal).padStart(15)}`);

console.log('\n=== Consistency Run A (date: 1970 to 2100) ===');
let conTotal = 0;
for (const r of consistRes.rows) {
  console.log(`  ${r.source_type.padEnd(25)} ₹${fmt(r.total).padStart(15)}  (${r.cnt})`);
  conTotal += Number(r.total);
}
console.log(`  ${'TOTAL'.padEnd(25)} ₹${fmt(conTotal).padStart(15)}`);

console.log(`\n=== Difference ===`);
console.log(`  Expenses Page:  ₹${fmt(expTotal)}`);
console.log(`  Consistency:    ₹${fmt(conTotal)}`);
console.log(`  Diff:           ₹${fmt(expTotal - conTotal)}`);

// Check if the diff comes from personal_ledger - join differences
const plExpQ = `SELECT COALESCE(SUM(cfe.debit),0)::numeric as total, COUNT(*)::int as cnt
  FROM cash_flow_entries cfe JOIN cash_flow_months cfm ON cfm.id=cfe.cash_flow_month_id
  WHERE cfe.site_id=$1 AND LOWER(cfm.ledger_type)='person' AND cfe.debit>0
  AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`;

const plDateQ = `SELECT COALESCE(SUM(cfe.debit),0)::numeric as total, COUNT(*)::int as cnt
  FROM cash_flow_entries cfe JOIN cash_flow_months cfm ON cfm.id=cfe.cash_flow_month_id
  WHERE cfe.site_id=$1 AND cfe.date >= $2 AND cfe.date < $3
  AND LOWER(cfm.ledger_type)='person' AND cfe.debit>0
  AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`;

const [plAll, plDated] = await Promise.all([
  pool.query(plExpQ, [SITE_ID]),
  pool.query(plDateQ, [SITE_ID, '1970-01-01', '2100-01-01']),
]);
console.log(`\n=== Personal Ledger Debit check ===`);
console.log(`  No date filter: ₹${fmt(plAll.rows[0].total)} (${plAll.rows[0].cnt} entries)`);
console.log(`  With 1970-2100: ₹${fmt(plDated.rows[0].total)} (${plDated.rows[0].cnt} entries)`);

// Check for NULL dates
const nullDateQ = `SELECT COUNT(*) as cnt, COALESCE(SUM(cfe.debit),0)::numeric as total
  FROM cash_flow_entries cfe JOIN cash_flow_months cfm ON cfm.id=cfe.cash_flow_month_id
  WHERE cfe.site_id=$1 AND LOWER(cfm.ledger_type)='person' AND cfe.debit>0
  AND cfe.date IS NULL
  AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`;
const nullRes = (await pool.query(nullDateQ, [SITE_ID])).rows[0];
console.log(`  NULL date rows:  ₹${fmt(nullRes.total)} (${nullRes.cnt} entries)`);

// Also check farmer_payments for NULL dates
const fpNullQ = `SELECT COUNT(*) as cnt, COALESCE(SUM(fp.amount),0)::numeric as total
  FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id
  WHERE f.site_id=$1 AND fp.date IS NULL
  AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED','RETURNED'))`;
const fpNull = (await pool.query(fpNullQ, [SITE_ID])).rows[0];
console.log(`  farmer_payments NULL date: ₹${fmt(fpNull.total)} (${fpNull.cnt})`);

// Check commission_payments NULL dates
const pcpNullQ = `SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0)::numeric as total
  FROM plot_commission_payments WHERE site_id=$1 AND date IS NULL
  AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))`;
const pcpNull = (await pool.query(pcpNullQ, [SITE_ID])).rows[0];
console.log(`  commission_payments NULL date: ₹${fmt(pcpNull.total)} (${pcpNull.cnt})`);

await pool.end();
