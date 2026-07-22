import pool from '../config/db.js';

// Plot Payments performance indexes:
//   - Partial index over only "active" plot_payments (cheque NOT IN
//     BOUNCED/RETURNED). Used by every aggregation in findBySiteId /
//     findByIdWithTotals + the cash/bank split filter.
//   - (plot_id, payment_type) covers the cash-vs-bank-vs-cheque split.
//   - (plot_id, date) composite for the per-plot listing.
//   - (site_id, plot_no UPPER) for the duplicate plot-no check.
//   - (site_id, status) composite for the status filter on the table view.
//   - Site-wide DISTINCT scans (autocomplete) get partial covering indexes.
//
// All indexes use IF NOT EXISTS so the migration is idempotent.
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── plots ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plots_site_plot_no_upper
        ON plots(site_id, UPPER(plot_no))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plots_site_status
        ON plots(site_id, status)
    `);
    // Free-to-sale candidate filter — partial covers the WHERE clause.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plots_fts_candidates
        ON plots(site_id)
        WHERE installments_enabled = TRUE
          AND free_to_sale_days > 0
          AND status NOT IN ('UNDER CANCELLATION', 'CANCELLED', 'RESALE', 'TRANSFERRED', 'COMPANY')
    `);

    // ── plot_payments ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pp_active_plot
        ON plot_payments(plot_id)
        WHERE cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pp_plot_type
        ON plot_payments(plot_id, payment_type)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pp_plot_date
        ON plot_payments(plot_id, date, created_at)
    `);
    // Autocomplete partials.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pp_site_payment_from
        ON plot_payments(site_id, payment_from)
        WHERE payment_from IS NOT NULL AND payment_from != ''
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pp_site_received_by
        ON plot_payments(site_id, received_by)
        WHERE received_by IS NOT NULL AND received_by != ''
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pp_site_booked_by
        ON plot_payments(site_id, booked_by)
        WHERE booked_by IS NOT NULL AND booked_by != ''
    `);

    // ── plot_installments — used by the FTS sweep batched lookup ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plot_installments_plot
        ON plot_installments(plot_id, sort_order, due_date)
    `);

    await client.query('COMMIT');
    console.log('Migration 056_plot_performance_indexes complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 056_plot_performance_indexes failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
