import 'dotenv/config';
import pool from './src/config/db.js';

// KPI query (same as kpi.service.js getOutstanding)
const { rows: kpi } = await pool.query(
  `SELECT COALESCE(SUM(cfe.debit),0)::numeric as given, COALESCE(SUM(cfe.credit),0)::numeric as returned
   FROM cash_flow_entries cfe
   JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
   WHERE cfe.site_id = 5
     AND LOWER(cfm.ledger_type) = 'person'
     AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`
);

// Page query (no cheque filter, for single ledger but we sum all)
const { rows: page } = await pool.query(
  `SELECT COALESCE(SUM(cfe.debit),0)::numeric as given, COALESCE(SUM(cfe.credit),0)::numeric as returned
   FROM cash_flow_entries cfe
   JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
   WHERE cfm.site_id = 5
     AND LOWER(cfm.ledger_type) = 'person'`
);

console.log('KPI query (with cheque filter):', kpi[0]);
console.log('Page query (no cheque filter):', page[0]);
console.log('Difference in given:', parseFloat(page[0].given) - parseFloat(kpi[0].given));

pool.end();
