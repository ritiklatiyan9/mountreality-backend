import 'dotenv/config';
import pool from './src/config/db.js';

const r = await pool.query(`
  SELECT pcp.id, pcp.plot_commission_id, pcp.amount, pcp.status,
         pc.agent_id, m.full_name as agent_name, pc.plot_id,
         p.plot_no, p.buyer_name
  FROM plot_commission_payments pcp
  JOIN plot_commissions_v2 pc ON pc.id = pcp.plot_commission_id
  JOIN members m ON m.id = pc.agent_id
  JOIN plots p ON p.id = pc.plot_id
  WHERE p.plot_no = 'A6' AND pc.site_id = 5
  ORDER BY pcp.created_at
`);
console.log('Payments for Plot A6:');
console.table(r.rows.map(row => ({
  pmt_id: row.id,
  agent: row.agent_name,
  plot_id: row.plot_id,
  buyer: row.buyer_name,
  comm_id: row.plot_commission_id,
  amount: row.amount,
  status: row.status,
})));

const c = await pool.query(`
  SELECT pc.id as comm_id, m.full_name as agent, pc.plot_id, p.buyer_name,
         pc.total_commission, pc.status
  FROM plot_commissions_v2 pc
  JOIN members m ON m.id = pc.agent_id
  JOIN plots p ON p.id = pc.plot_id
  WHERE p.plot_no = 'A6' AND pc.site_id = 5
  ORDER BY pc.created_at
`);
console.log('\nAll commissions for Plot A6:');
console.table(c.rows);

process.exit(0);
