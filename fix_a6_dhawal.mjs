import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT||'5432'), database: process.env.DB_NAME, user: process.env.DB_USER, password: String(process.env.DB_PASSWORD||''), ssl:{rejectUnauthorized:false} });

const SITE_ID = 5;
const client = await pool.connect();

try {
  await client.query('BEGIN');

  // STEP 1: Verify pmt_id=31,50 on comm_id=123 are duplicates of pmt_id=86,87 on comm_id=125
  console.log('=== A6 Payment comparison ===');
  const pmts = await client.query(`
    SELECT pcp.id, pcp.plot_commission_id as comm_id, pcp.amount, pcp.date, pcp.payment_mode, pcp.status
    FROM plot_commission_payments pcp
    WHERE pcp.plot_commission_id IN (123, 125)
    ORDER BY pcp.date, pcp.amount
  `);
  pmts.rows.forEach(r => console.log(`  pmt_id=${r.id} comm=${r.comm_id} amount=${r.amount} date=${r.date} mode=${r.payment_mode} status=${r.status}`));

  // STEP 2: Delete duplicate payments on comm_id=123
  console.log('\n=== Deleting duplicate payments on comm_id=123 ===');
  const d1 = await client.query(`DELETE FROM plot_commission_payments WHERE plot_commission_id = 123 RETURNING id, amount`);
  console.log(`  Deleted ${d1.rowCount} payments:`, d1.rows);

  // STEP 3: Delete comm_id=123 (AKASH on DHAWAL)
  console.log('\n=== Deleting comm_id=123 (AKASH on DHAWAL) ===');
  const d2 = await client.query(`DELETE FROM plot_commissions_v2 WHERE id = 123 AND site_id = $1 RETURNING id, agent_id, plot_id`, [SITE_ID]);
  console.log(`  Deleted ${d2.rowCount}:`, d2.rows);

  // STEP 4: Verify A6 is now clean
  console.log('\n=== A6 after fix ===');
  const v = await client.query(`
    SELECT pc.id, m.full_name, pc.plot_id, p.buyer_name, pc.status,
      (SELECT COUNT(*) FROM plot_commission_payments WHERE plot_commission_id=pc.id) as pmts,
      (SELECT COALESCE(SUM(amount),0) FROM plot_commission_payments WHERE plot_commission_id=pc.id AND status='approved') as paid
    FROM plot_commissions_v2 pc JOIN members m ON pc.agent_id=m.id JOIN plots p ON pc.plot_id=p.id
    WHERE p.plot_no='A6' AND pc.site_id=$1 ORDER BY pc.plot_id, pc.id
  `, [SITE_ID]);
  v.rows.forEach(r => console.log(`  comm_id=${r.id} ${r.full_name} on ${r.buyer_name}(plot=${r.plot_id}) status=${r.status} ${r.pmts} pmts, paid=${r.paid}`));

  // STEP 5: Check B1
  console.log('\n=== B1 current state ===');
  const b1 = await client.query(`
    SELECT pc.id, m.full_name, pc.plot_id, p.buyer_name, pc.status,
      (SELECT COUNT(*) FROM plot_commission_payments WHERE plot_commission_id=pc.id) as pmts,
      (SELECT COALESCE(SUM(amount),0) FROM plot_commission_payments WHERE plot_commission_id=pc.id AND status='approved') as paid
    FROM plot_commissions_v2 pc JOIN members m ON pc.agent_id=m.id JOIN plots p ON pc.plot_id=p.id
    WHERE p.plot_no='B1' AND pc.site_id=$1 ORDER BY pc.plot_id, pc.id
  `, [SITE_ID]);
  b1.rows.forEach(r => console.log(`  comm_id=${r.id} ${r.full_name} on ${r.buyer_name}(plot=${r.plot_id}) status=${r.status} ${r.pmts} pmts, paid=${r.paid}`));

  // STEP 6: Check remaining 3+ agent-count plots from the LIST PAGE perspective
  // The list page likely counts agents from the CURRENT plot_id only
  console.log('\n=== All plots with 3+ commission entries (any booking) ===');
  const check = await client.query(`
    SELECT p.plot_no, COUNT(pc.id) as comms, STRING_AGG(DISTINCT m.full_name, ', ') as agents
    FROM plot_commissions_v2 pc JOIN members m ON pc.agent_id=m.id JOIN plots p ON pc.plot_id=p.id
    WHERE pc.site_id=$1
    GROUP BY p.plot_no HAVING COUNT(pc.id) >= 3
    ORDER BY p.plot_no
  `, [SITE_ID]);
  check.rows.forEach(r => console.log(`  ${r.plot_no}: ${r.comms} commissions [${r.agents}]`));

  await client.query('COMMIT');
  console.log('\n✅ Done');
} catch(e) {
  await client.query('ROLLBACK');
  console.error('ROLLBACK:', e.message);
} finally {
  client.release();
  await pool.end();
}
