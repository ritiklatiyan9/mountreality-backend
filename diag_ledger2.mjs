import 'dotenv/config';
import pool from './src/config/db.js';

// KPI total
const { rows: kpiRows } = await pool.query(
  `SELECT COALESCE(SUM(cfe.debit),0)::numeric as given, COALESCE(SUM(cfe.credit),0)::numeric as returned
   FROM cash_flow_entries cfe
   JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
   WHERE cfe.site_id = 5
     AND LOWER(cfm.ledger_type) = 'person'
     AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`
);
console.log('KPI total: given=' + kpiRows[0].given + ' returned=' + kpiRows[0].returned);

// Per-ledger breakdown
const { rows: ledgers } = await pool.query(
  `SELECT cfm.id, cfm.person_name,
          COALESCE(SUM(cfe.debit),0)::numeric as debit,
          COALESCE(SUM(cfe.credit),0)::numeric as credit,
          COUNT(*)::int as cnt
   FROM cash_flow_months cfm
   LEFT JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = cfm.id
   WHERE cfm.site_id = 5 AND LOWER(cfm.ledger_type) = 'person'
   GROUP BY cfm.id, cfm.person_name
   ORDER BY debit DESC`
);
let totalGiven = 0, totalReturned = 0;
for (const l of ledgers) {
  const d = parseFloat(l.debit);
  const c = parseFloat(l.credit);
  totalGiven += d;
  totalReturned += c;
  if (d > 0 || c > 0) console.log(`  ${l.person_name} (id=${l.id}): given=${d} ret=${c} pending=${d-c} entries=${l.cnt}`);
}
console.log('Sum all ledgers: given=' + totalGiven + ' returned=' + totalReturned + ' pending=' + (totalGiven - totalReturned));

pool.end();
