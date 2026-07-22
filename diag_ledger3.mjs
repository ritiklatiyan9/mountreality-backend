import 'dotenv/config';
import pool from './src/config/db.js';

// Get columns
const { rows: cols } = await pool.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name = 'cash_flow_months' ORDER BY ordinal_position`
);
console.log('cash_flow_months columns:', cols.map(x => x.column_name).join(', '));

// Per-ledger breakdown
const { rows: ledgers } = await pool.query(
  `SELECT cfm.id, cfm.ledger_name, cfm.ledger_type,
          COALESCE(SUM(cfe.debit),0)::numeric as debit,
          COALESCE(SUM(cfe.credit),0)::numeric as credit,
          COUNT(cfe.id)::int as cnt
   FROM cash_flow_months cfm
   LEFT JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = cfm.id
   WHERE cfm.site_id = 5 AND LOWER(cfm.ledger_type) = 'person'
   GROUP BY cfm.id, cfm.ledger_name, cfm.ledger_type
   ORDER BY debit DESC`
);
let totalGiven = 0, totalReturned = 0;
for (const l of ledgers) {
  const d = parseFloat(l.debit);
  const c = parseFloat(l.credit);
  totalGiven += d;
  totalReturned += c;
  if (d > 0 || c > 0) console.log(`  ${l.ledger_name} (id=${l.id}): given=${d} ret=${c} pending=${d-c} entries=${l.cnt}`);
}
console.log('Sum all person ledgers: given=' + totalGiven + ' returned=' + totalReturned + ' pending=' + (totalGiven - totalReturned));

pool.end();
