import pool from '../config/db.js';

// Targeted indexes for the Plot Detail read path.  Existing general indexes
// already serve all-record history; these partial indexes keep the much more
// common posted-receipt totals small and cache-friendly.
const MIGRATION_KEY = '109_plot_detail_performance';

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
      CREATE INDEX IF NOT EXISTS idx_plot_payments_posted_detail
        ON plot_payments(plot_id, date ASC, created_at ASC)
        INCLUDE (amount, payment_type, payment_from, received_by)
        WHERE LOWER(COALESCE(status, 'approved')) = 'approved'
          AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plot_installment_payments_plot_date
        ON plot_installment_payments(plot_id, payment_date ASC, created_at ASC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plot_installment_payments_posted_detail
        ON plot_installment_payments(plot_id, payment_date ASC, created_at ASC)
        INCLUDE (amount, payment_mode)
        WHERE UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
    `);
    // The payment history query resolves allocations per payment. This turns
    // that lookup from repeated scans into a narrow index seek.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plot_payment_allocations_payment
        ON plot_payment_allocations(plot_payment_id, installment_id)
        INCLUDE (id, allocated_amount, created_at)
    `);

    await client.query('INSERT INTO app_schema_migrations(version) VALUES($1)', [MIGRATION_KEY]);
    await client.query('COMMIT');
    console.log('✓ Migration applied: plot detail performance indexes');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error('Migration 109_plot_detail_performance failed:', error.message);
  process.exit(1);
});
