import pool from '../config/db.js';

// Plot Registry performance indexes:
//   - (site_id, UPPER(plot_no)) covers the duplicate-check on createRegistry.
//   - (site_id, created_entry_date DESC) for the listing's typical sort.
//   - (registry_id, payment_date) composite covers per-registry listings.
//   - (source_plot_payment_id) WHERE NOT NULL covers the "already linked"
//     guard in createRegistryPayment.
//   - Site-wide DISTINCT scans (autocomplete) get partial covering indexes.
//
// All indexes use IF NOT EXISTS so the migration is idempotent.
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── plot_registries ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pr_site_plot_no_upper
        ON plot_registries(site_id, UPPER(plot_no))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pr_site_created_entry_date
        ON plot_registries(site_id, created_entry_date DESC)
    `);
    // Autocomplete DISTINCT scans benefit from these covering partials.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pr_site_customer
        ON plot_registries(site_id, customer_name)
        WHERE customer_name IS NOT NULL AND customer_name != ''
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pr_site_farmer
        ON plot_registries(site_id, farmer_name)
        WHERE farmer_name IS NOT NULL AND farmer_name != ''
    `);

    // ── plot_registry_payments ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_prp_registry_date
        ON plot_registry_payments(registry_id, payment_date, created_at)
    `);
    // Source-plot-payment dup-check (exists() lookup).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_prp_source_plot_payment
        ON plot_registry_payments(source_plot_payment_id)
        WHERE source_plot_payment_id IS NOT NULL
    `);
    // Site-wide DISTINCT scan for payment-mode autocomplete.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_prp_site_mode
        ON plot_registry_payments(site_id, payment_mode)
        WHERE payment_mode IS NOT NULL AND payment_mode != ''
    `);

    await client.query('COMMIT');
    console.log('Migration 055_registry_performance_indexes complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 055_registry_performance_indexes failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
