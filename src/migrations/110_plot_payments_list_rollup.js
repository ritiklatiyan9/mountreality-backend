import pool from '../config/db.js';

// Cover the set-based Plot Payments landing-page aggregates. These are
// additive indexes only; no business rows are changed.
const MIGRATION_KEY = '110_plot_payments_list_rollup';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_schema_migrations (
        version VARCHAR(160) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = await client.query('SELECT 1 FROM app_schema_migrations WHERE version = $1', [MIGRATION_KEY]);
    if (applied.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plot_payments_site_plot_rollup
        ON plot_payments(site_id, plot_id)
        INCLUDE (amount, status, cheque_status, payment_type, buyer_name, booked_by)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plot_installment_payments_plot_rollup
        ON plot_installment_payments(plot_id)
        INCLUDE (amount, cheque_status, payment_mode)
    `);

    await client.query('INSERT INTO app_schema_migrations(version) VALUES($1)', [MIGRATION_KEY]);
    await client.query('COMMIT');
    await client.query('ANALYZE plot_payments');
    await client.query('ANALYZE plot_installment_payments');
    console.log('✓ Migration applied: Plot Payments list rollup indexes');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error('Migration 110_plot_payments_list_rollup failed:', error.message);
  process.exit(1);
});
