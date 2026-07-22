import pool from './src/config/db.js';

// Find the Anup Singh plot payment in cash_flow_entries
const r = await pool.query(`
  SELECT cfe.id, cfe.source_module, cfe.source_id, cfe.particular, cfe.debit, cfe.credit, 
         cfe.cash_type, cfe.cheque_status, cfe.status, cfe.date
  FROM cash_flow_entries cfe
  WHERE cfe.particular ILIKE '%ANUP%'
  ORDER BY cfe.date DESC
  LIMIT 10
`);
console.log('Anup Singh cash_flow_entries:', r.rows);

// Check plot_payments for Anup Singh
const pp = await pool.query(`
  SELECT id, plot_id, amount, payment_type, payment_from, cheque_status, status, date, buyer_name
  FROM plot_payments
  WHERE payment_from ILIKE '%ANUP%' OR buyer_name ILIKE '%ANUP%'
  ORDER BY date DESC
  LIMIT 10
`);
console.log('\nAnup Singh plot_payments:', pp.rows);

// Check if cash_flow_entry exists for these payment ids
if (pp.rows.length > 0) {
  const ids = pp.rows.map(r => r.id);
  const cfe = await pool.query(
    `SELECT source_id, debit, credit, cheque_status FROM cash_flow_entries WHERE source_module = 'plot_payments' AND source_id = ANY($1)`,
    [ids]
  );
  console.log('\nCashflow entries for those payment ids:', cfe.rows);
}

process.exit(0);
