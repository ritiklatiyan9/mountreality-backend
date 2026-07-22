import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD || ''),
  ssl: { rejectUnauthorized: false },
});

const SITE_ID = 5; // OM ASSOCIATES

async function diagnose() {
  console.log('=== STEP 1: Diagnose A6 ===\n');

  // Get A6 commissions
  const a6 = await pool.query(`
    SELECT pc.id as comm_id, pc.plot_id, pc.agent_id, m.full_name as agent_name,
           p.buyer_name, p.plot_no, pc.total_commission, pc.status,
           (SELECT COUNT(*) FROM plot_commission_payments WHERE plot_commission_id = pc.id) as pmt_count,
           (SELECT COALESCE(SUM(amount),0) FROM plot_commission_payments WHERE plot_commission_id = pc.id AND status='approved') as total_paid
    FROM plot_commissions_v2 pc
    JOIN members m ON pc.agent_id = m.id
    JOIN plots p ON pc.plot_id = p.id
    WHERE p.plot_no = 'A6' AND pc.site_id = $1
    ORDER BY pc.plot_id, pc.id
  `, [SITE_ID]);
  console.log('A6 commissions:');
  a6.rows.forEach(r => console.log(`  comm_id=${r.comm_id} plot_id=${r.plot_id} agent=${r.agent_name}(${r.agent_id}) buyer=${r.buyer_name} commission=${r.total_commission} paid=${r.total_paid} pmts=${r.pmt_count} status=${r.status}`));

  // Get AKASH and AJAY member IDs
  const members = await pool.query(`
    SELECT id, full_name, phone FROM members
    WHERE full_name ILIKE '%akash%' OR full_name ILIKE '%ajay%'
    ORDER BY full_name
  `);
  console.log('\nRelevant members:');
  members.rows.forEach(r => console.log(`  id=${r.id} name=${r.full_name} phone=${r.phone}`));

  // Get payments for A6 current booking commissions
  const a6payments = await pool.query(`
    SELECT pcp.id as pmt_id, pcp.plot_commission_id as comm_id, pcp.amount, pcp.date, pcp.status,
           pcp.payment_mode, m.full_name as agent_name
    FROM plot_commission_payments pcp
    JOIN plot_commissions_v2 pc ON pcp.plot_commission_id = pc.id
    JOIN members m ON pc.agent_id = m.id
    JOIN plots p ON pc.plot_id = p.id
    WHERE p.plot_no = 'A6' AND pc.site_id = $1
    ORDER BY pcp.date
  `, [SITE_ID]);
  console.log('\nA6 payments:');
  a6payments.rows.forEach(r => console.log(`  pmt_id=${r.pmt_id} comm_id=${r.comm_id} agent=${r.agent_name} amount=${r.amount} date=${r.date} status=${r.status} mode=${r.payment_mode}`));

  console.log('\n=== STEP 2: Diagnose A7 ===\n');

  const a7 = await pool.query(`
    SELECT pc.id as comm_id, pc.plot_id, pc.agent_id, m.full_name as agent_name,
           p.buyer_name, p.plot_no, pc.total_commission, pc.status,
           (SELECT COUNT(*) FROM plot_commission_payments WHERE plot_commission_id = pc.id) as pmt_count,
           (SELECT COALESCE(SUM(amount),0) FROM plot_commission_payments WHERE plot_commission_id = pc.id AND status='approved') as total_paid
    FROM plot_commissions_v2 pc
    JOIN members m ON pc.agent_id = m.id
    JOIN plots p ON pc.plot_id = p.id
    WHERE p.plot_no = 'A7' AND pc.site_id = $1
    ORDER BY pc.plot_id, pc.id
  `, [SITE_ID]);
  console.log('A7 commissions:');
  a7.rows.forEach(r => console.log(`  comm_id=${r.comm_id} plot_id=${r.plot_id} agent=${r.agent_name}(${r.agent_id}) buyer=${r.buyer_name} commission=${r.total_commission} paid=${r.total_paid} pmts=${r.pmt_count} status=${r.status}`));

  console.log('\n=== STEP 3: Find ALL plots with potential wrong agents (3+ agent entries on same plot_no) ===\n');

  const multi = await pool.query(`
    SELECT p.plot_no, COUNT(DISTINCT pc.id) as comm_count, COUNT(DISTINCT pc.agent_id) as agent_count,
           STRING_AGG(DISTINCT m.full_name, ', ' ORDER BY m.full_name) as agents,
           STRING_AGG(DISTINCT p.buyer_name, ', ') as buyers,
           ARRAY_AGG(DISTINCT pc.plot_id ORDER BY pc.plot_id) as plot_ids
    FROM plot_commissions_v2 pc
    JOIN members m ON pc.agent_id = m.id
    JOIN plots p ON pc.plot_id = p.id
    WHERE pc.site_id = $1
    GROUP BY p.plot_no
    HAVING COUNT(DISTINCT pc.id) >= 3
    ORDER BY p.plot_no
  `, [SITE_ID]);
  console.log(`Found ${multi.rows.length} plots with 3+ commission entries:`);
  multi.rows.forEach(r => console.log(`  ${r.plot_no}: ${r.comm_count} commissions, ${r.agent_count} agents [${r.agents}] buyers=[${r.buyers}] plot_ids=[${r.plot_ids}]`));

  // Now let's check: for each plot with multiple plot_ids (resales), check if any agent appears on BOTH old and new booking
  console.log('\n=== STEP 4: Agents appearing on multiple bookings of same plot_no ===\n');

  const dupes = await pool.query(`
    WITH agent_bookings AS (
      SELECT p.plot_no, pc.agent_id, m.full_name, pc.plot_id, p.buyer_name,
             pc.id as comm_id, pc.total_commission, pc.status,
             (SELECT COALESCE(SUM(amount),0) FROM plot_commission_payments WHERE plot_commission_id = pc.id AND status='approved') as total_paid
      FROM plot_commissions_v2 pc
      JOIN members m ON pc.agent_id = m.id
      JOIN plots p ON pc.plot_id = p.id
      WHERE pc.site_id = $1
    )
    SELECT ab.plot_no, ab.full_name, ab.agent_id,
           COUNT(DISTINCT ab.plot_id) as booking_count,
           ARRAY_AGG(ab.plot_id ORDER BY ab.plot_id) as plot_ids,
           ARRAY_AGG(ab.comm_id ORDER BY ab.comm_id) as comm_ids,
           ARRAY_AGG(ab.buyer_name ORDER BY ab.plot_id) as buyers,
           ARRAY_AGG(ab.total_paid ORDER BY ab.plot_id) as paid_arr
    FROM agent_bookings ab
    GROUP BY ab.plot_no, ab.full_name, ab.agent_id
    HAVING COUNT(DISTINCT ab.plot_id) > 1
    ORDER BY ab.plot_no
  `, [SITE_ID]);
  console.log(`Found ${dupes.rows.length} agents appearing on multiple bookings of same plot:`);
  dupes.rows.forEach(r => console.log(`  ${r.plot_no}: ${r.full_name}(${r.agent_id}) on ${r.booking_count} bookings, plot_ids=[${r.plot_ids}] comm_ids=[${r.comm_ids}] buyers=[${r.buyers}] paid=[${r.paid_arr}]`));
}

diagnose().then(() => pool.end()).catch(e => { console.error(e); pool.end(); });
