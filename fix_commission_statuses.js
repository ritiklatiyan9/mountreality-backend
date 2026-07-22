/**
 * One-time fix: Recalculate all plot_commissions_v2 statuses based on actual approved payments.
 * Run with: node fix_commission_statuses.js
 */

import 'dotenv/config';
import pool from './src/config/db.js';

async function fixCommissionStatuses() {
  try {
    console.log('Recalculating commission statuses based on approved payments...\n');

    const result = await pool.query(`
      UPDATE plot_commissions_v2 pcm
      SET status = CASE
        WHEN COALESCE(paid.total_paid, 0) >= pcm.total_commission AND pcm.total_commission > 0 THEN 'Completed'
        WHEN COALESCE(paid.total_paid, 0) > 0 THEN 'Partial'
        ELSE 'Pending'
      END,
      updated_at = NOW()
      FROM (
        SELECT
          plot_commission_id,
          COALESCE(SUM(amount) FILTER (
            WHERE status = 'approved'
            AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          ), 0) AS total_paid
        FROM plot_commission_payments
        GROUP BY plot_commission_id
      ) paid
      WHERE pcm.id = paid.plot_commission_id
      RETURNING pcm.id, pcm.status
    `);

    console.log(`Updated ${result.rowCount} commission records.`);

    // Show breakdown
    const counts = { Completed: 0, Partial: 0, Pending: 0 };
    for (const row of result.rows) {
      counts[row.status] = (counts[row.status] || 0) + 1;
    }
    console.log(`  Completed: ${counts.Completed}`);
    console.log(`  Partial:   ${counts.Partial}`);
    console.log(`  Pending:   ${counts.Pending}`);

    // Also fix commissions that have no payments at all (ensure they are Pending)
    const resetResult = await pool.query(`
      UPDATE plot_commissions_v2
      SET status = 'Pending', updated_at = NOW()
      WHERE id NOT IN (SELECT DISTINCT plot_commission_id FROM plot_commission_payments)
        AND status != 'Pending'
      RETURNING id
    `);
    if (resetResult.rowCount > 0) {
      console.log(`\nReset ${resetResult.rowCount} commissions with no payments back to Pending.`);
    }

    console.log('\nDone!');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

fixCommissionStatuses();
