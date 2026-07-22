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

const SITE_ID = 5;

async function fix() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ═══════════════════════════════════════════════
    // FIX 1: A6 — Change AJAY (236) → AKASH (30) on comm_id=125 (current booking KAVITA)
    // ═══════════════════════════════════════════════
    console.log('=== FIX 1: A6 — reassign comm_id=125 from AJAY(236) to AKASH(30) ===');
    const r1 = await client.query(
      `UPDATE plot_commissions_v2 SET agent_id = 30 WHERE id = 125 AND agent_id = 236 AND site_id = $1 RETURNING id, agent_id`,
      [SITE_ID]
    );
    console.log(`  Updated ${r1.rowCount} row(s):`, r1.rows);

    // ═══════════════════════════════════════════════
    // FIX 2: A7 — Delete AKASH (comm_id=129) from old booking (plot_id=28, CHANDRA MOHAN ADV)
    // ═══════════════════════════════════════════════
    console.log('\n=== FIX 2: A7 — delete comm_id=129 (AKASH on old booking, 0 payments) ===');
    // Verify 0 payments first
    const pmtCheck = await client.query(`SELECT COUNT(*) as cnt FROM plot_commission_payments WHERE plot_commission_id = 129`);
    if (parseInt(pmtCheck.rows[0].cnt) > 0) {
      console.log(`  SKIPPED: comm_id=129 has ${pmtCheck.rows[0].cnt} payments! Not safe to delete.`);
    } else {
      const r2 = await client.query(
        `DELETE FROM plot_commissions_v2 WHERE id = 129 AND agent_id = 30 AND site_id = $1 RETURNING id, plot_id, agent_id`,
        [SITE_ID]
      );
      console.log(`  Deleted ${r2.rowCount} row(s):`, r2.rows);
    }

    // ═══════════════════════════════════════════════
    // FIX 3: Delete duplicate agent entries (same agent on both old & new plot_id, same buyer)
    // These are migration artifacts — old entry has 0 paid, new entry is the real one
    // ═══════════════════════════════════════════════
    console.log('\n=== FIX 3: Delete duplicate agent entries on same-buyer resold plots ===');

    // Find all duplicate entries: same agent on 2 plot_ids for same plot_no, where old entry has 0 payments
    const dupes = await client.query(`
      WITH agent_bookings AS (
        SELECT pc.id as comm_id, pc.plot_id, pc.agent_id, m.full_name, p.plot_no, p.buyer_name,
               (SELECT COALESCE(SUM(amount),0) FROM plot_commission_payments WHERE plot_commission_id = pc.id AND status='approved') as total_paid,
               (SELECT COUNT(*) FROM plot_commission_payments WHERE plot_commission_id = pc.id) as pmt_count
        FROM plot_commissions_v2 pc
        JOIN members m ON pc.agent_id = m.id
        JOIN plots p ON pc.plot_id = p.id
        WHERE pc.site_id = $1
      ),
      dupes AS (
        SELECT ab1.comm_id as old_comm_id, ab1.plot_id as old_plot_id, ab1.full_name,
               ab1.plot_no, ab1.buyer_name as old_buyer,
               ab2.buyer_name as new_buyer, ab2.plot_id as new_plot_id, ab2.comm_id as new_comm_id,
               ab1.total_paid as old_paid, ab2.total_paid as new_paid,
               ab1.pmt_count as old_pmt_count
        FROM agent_bookings ab1
        JOIN agent_bookings ab2 ON ab1.agent_id = ab2.agent_id AND ab1.plot_no = ab2.plot_no AND ab1.plot_id < ab2.plot_id
        WHERE ab1.pmt_count = 0  -- old entry has zero payments (safe to delete)
      )
      SELECT * FROM dupes ORDER BY plot_no, old_comm_id
    `, [SITE_ID]);

    console.log(`  Found ${dupes.rows.length} duplicate old entries to delete:`);
    const deleteIds = [];
    for (const d of dupes.rows) {
      console.log(`  ${d.plot_no}: ${d.full_name} — old comm_id=${d.old_comm_id}(plot=${d.old_plot_id}, ${d.old_buyer}, paid=${d.old_paid}) → new comm_id=${d.new_comm_id}(plot=${d.new_plot_id}, ${d.new_buyer}, paid=${d.new_paid})`);
      deleteIds.push(d.old_comm_id);
    }

    if (deleteIds.length > 0) {
      // Exclude IDs already handled above (129 was deleted in FIX 2)
      const toDelete = deleteIds.filter(id => id !== 129);
      if (toDelete.length > 0) {
        const r3 = await client.query(
          `DELETE FROM plot_commissions_v2 WHERE id = ANY($1) AND site_id = $2 RETURNING id, plot_id, agent_id`,
          [toDelete, SITE_ID]
        );
        console.log(`  Deleted ${r3.rowCount} duplicate entries:`, r3.rows.map(r => `comm_id=${r.id}`));
      }
    }

    // ═══════════════════════════════════════════════
    // VERIFY results
    // ═══════════════════════════════════════════════
    console.log('\n=== VERIFICATION ===');

    // A6
    const vA6 = await client.query(`
      SELECT pc.id, m.full_name, pc.plot_id, p.buyer_name, pc.status
      FROM plot_commissions_v2 pc JOIN members m ON pc.agent_id = m.id JOIN plots p ON pc.plot_id = p.id
      WHERE p.plot_no = 'A6' AND pc.site_id = $1 ORDER BY pc.plot_id, pc.id
    `, [SITE_ID]);
    console.log('A6 commissions:', vA6.rows.map(r => `${r.full_name}(comm=${r.id}) on ${r.buyer_name}`));

    // A7
    const vA7 = await client.query(`
      SELECT pc.id, m.full_name, pc.plot_id, p.buyer_name, pc.status
      FROM plot_commissions_v2 pc JOIN members m ON pc.agent_id = m.id JOIN plots p ON pc.plot_id = p.id
      WHERE p.plot_no = 'A7' AND pc.site_id = $1 ORDER BY pc.plot_id, pc.id
    `, [SITE_ID]);
    console.log('A7 commissions:', vA7.rows.map(r => `${r.full_name}(comm=${r.id}) on ${r.buyer_name}`));

    // Check no more 3+ entry plots
    const check3 = await client.query(`
      SELECT p.plot_no, COUNT(DISTINCT pc.id) as cnt
      FROM plot_commissions_v2 pc JOIN plots p ON pc.plot_id = p.id
      WHERE pc.site_id = $1
      GROUP BY p.plot_no HAVING COUNT(DISTINCT pc.id) >= 3
    `, [SITE_ID]);
    console.log('Plots still with 3+ commission entries:', check3.rows);

    // Check remaining multi-booking agents
    const checkMulti = await client.query(`
      WITH ab AS (
        SELECT pc.agent_id, m.full_name, p.plot_no, pc.plot_id
        FROM plot_commissions_v2 pc JOIN members m ON pc.agent_id = m.id JOIN plots p ON pc.plot_id = p.id
        WHERE pc.site_id = $1
      )
      SELECT plot_no, full_name, COUNT(DISTINCT plot_id) as cnt
      FROM ab GROUP BY plot_no, full_name, agent_id
      HAVING COUNT(DISTINCT plot_id) > 1
      ORDER BY plot_no
    `, [SITE_ID]);
    console.log('Remaining agents on multiple bookings:', checkMulti.rows);

    await client.query('COMMIT');
    console.log('\n✅ All fixes committed.');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ ROLLED BACK:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

fix().then(() => pool.end()).catch(e => { console.error(e); pool.end(); });
