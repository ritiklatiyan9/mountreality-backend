import 'dotenv/config';
import pool from './src/config/db.js';

// 1. KPI query: all person ledgers, site-wide, excludes BOUNCED/RETURNED
const { rows: kpiRows } = await pool.query(
  `SELECT COALESCE(SUM(cfe.debit),0)::numeric as given, COALESCE(SUM(cfe.credit),0)::numeric as returned
   FROM cash_flow_entries cfe
   JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
   WHERE cfe.site_id = 5
     AND LOWER(cfm.ledger_type) = 'person'
     AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`
);
console.log('KPI (excludes bounced):', kpiRows[0], 'pending:', parseFloat(kpiRows[0].given) - parseFloat(kpiRows[0].returned));

// 2. Same but WITHOUT cheque filter (what frontend does)
const { rows: allRows } = await pool.query(
  `SELECT COALESCE(SUM(cfe.debit),0)::numeric as given, COALESCE(SUM(cfe.credit),0)::numeric as returned
   FROM cash_flow_entries cfe
   JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
   WHERE cfe.site_id = 5
     AND LOWER(cfm.ledger_type) = 'person'`
);
console.log('All (incl bounced):', allRows[0], 'pending:', parseFloat(allRows[0].given) - parseFloat(allRows[0].returned));

// 3. Check bounced/returned entries specifically
const { rows: bouncedRows } = await pool.query(
  `SELECT cfe.cheque_status, COALESCE(SUM(cfe.debit),0)::numeric as debit, COALESCE(SUM(cfe.credit),0)::numeric as credit, COUNT(*)::int as cnt
   FROM cash_flow_entries cfe
   JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
   WHERE cfe.site_id = 5
     AND LOWER(cfm.ledger_type) = 'person'
     AND cfe.cheque_status IN ('BOUNCED','RETURNED')
   GROUP BY cfe.cheque_status`
);
console.log('Bounced/Returned entries:', bouncedRows);

// 4. List all person ledgers with their totals
const { rows: ledgers } = await pool.query(
  `SELECT cfm.id, cfm.month_label, cfm.person_name,
          COALESCE(SUM(cfe.debit),0)::numeric as debit,
          COALESCE(SUM(cfe.credit),0)::numeric as credit
   FROM cash_flow_months cfm
   LEFT JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = cfm.id
   WHERE cfm.site_id = 5 AND LOWER(cfm.ledger_type) = 'person'
   GROUP BY cfm.id, cfm.month_label, cfm.person_name
   ORDER BY debit DESC`
);
console.log('\nPer-ledger totals:');
let totalGiven = 0, totalReturned = 0;
for (const l of ledgers) {
  const d = parseFloat(l.debit);
  const c = parseFloat(l.credit);
  if (d > 0 || c > 0) {
    console.log(`  ${l.person_name || l.month_label} (id=${l.id}): given=${d} returned=${c} pending=${d-c}`);
    totalGiven += d;
    totalReturned += c;
  }
}
console.log(`\nClient-side sum of all ledgers: given=${totalGiven} returned=${totalReturned} pending=${totalGiven - totalReturned}`);

pool.end();
