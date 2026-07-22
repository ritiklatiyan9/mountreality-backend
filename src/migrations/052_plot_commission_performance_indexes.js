import pool from '../config/db.js';

// Adds composite + partial indexes that speed up the Plot Commission module:
//   - (plot_id, site_id) covers the heaviest query (getPlotCommissionByPlot
//     joins by both columns).
//   - Partial index on "active approved" payments covers every aggregation
//     that filters by status='approved' AND cheque NOT IN BOUNCED/RETURNED.
//   - (plot_commission_id, status) covers the per-commission status check
//     used by autoUpdateCommissionStatus.
//
// All indexes use IF NOT EXISTS so the migration is idempotent.
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── plot_commissions_v2 ────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pcv2_plot_site
        ON plot_commissions_v2(plot_id, site_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pcv2_site_created_at
        ON plot_commissions_v2(site_id, created_at DESC)
    `);
    // Used by createPlotCommission's WHERE NOT EXISTS dup check.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pcv2_plot_agent
        ON plot_commissions_v2(plot_id, agent_id)
    `);

    // ── plot_commission_payments ───────────────────────────────
    // Partial index over only "active approved" rows — used by every
    // SUM(amount) aggregation in the listing + detail + analytics queries.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pcp_active_approved
        ON plot_commission_payments(plot_commission_id)
        WHERE status = 'approved'
          AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    `);
    // (commission_id, status) for autoUpdateCommissionStatus's filter.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pcp_master_status
        ON plot_commission_payments(plot_commission_id, status)
    `);
    // (commission_id, date DESC) for the per-commission ORDER BY date DESC
    // used by findByCommissionId and the ANY() listing in getPlotCommissionByPlot.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pcp_master_date
        ON plot_commission_payments(plot_commission_id, date DESC, created_at DESC)
    `);

    await client.query('COMMIT');
    console.log('Migration 052_plot_commission_performance_indexes complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 052_plot_commission_performance_indexes failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
