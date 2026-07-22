import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT||'5432'), database: process.env.DB_NAME, user: process.env.DB_USER, password: String(process.env.DB_PASSWORD||''), ssl:{rejectUnauthorized:false} });

const r = await pool.query(`
  SELECT pc.id, pc.plot_id, pc.agent_id, m.full_name, p.buyer_name, pc.total_commission, pc.status,
    (SELECT COUNT(*) FROM plot_commission_payments WHERE plot_commission_id=pc.id) as pmts,
    (SELECT COALESCE(SUM(amount),0) FROM plot_commission_payments WHERE plot_commission_id=pc.id AND status='approved') as paid
  FROM plot_commissions_v2 pc JOIN members m ON pc.agent_id=m.id JOIN plots p ON pc.plot_id=p.id
  WHERE p.plot_no='B1' AND pc.site_id=5 ORDER BY pc.plot_id, pc.id
`);
console.log('B1 commissions:');
r.rows.forEach(row => console.log(`  comm_id=${row.id} plot_id=${row.plot_id} agent=${row.full_name}(${row.agent_id}) buyer=${row.buyer_name} commission=${row.total_commission} paid=${row.paid} pmts=${row.pmts} status=${row.status}`));

await pool.end();
