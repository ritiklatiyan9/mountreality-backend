import 'dotenv/config';
import pool from './src/config/db.js';

const { rows } = await pool.query(
  `SELECT COALESCE(SUM(debit),0)::numeric as given, COALESCE(SUM(credit),0)::numeric as returned
   FROM cash_flow_entries cfe
   JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
   WHERE cfe.site_id = 5
     AND LOWER(cfm.ledger_type) = 'person'
     AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`
);
console.log('DB live outstanding:', rows[0]);
console.log('Given:', parseFloat(rows[0].given));
console.log('Returned:', parseFloat(rows[0].returned));
console.log('Pending:', parseFloat(rows[0].given) - parseFloat(rows[0].returned));
pool.end();
