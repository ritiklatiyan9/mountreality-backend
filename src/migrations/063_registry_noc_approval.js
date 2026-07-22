import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 063 — NOC approval step for plot registries.
 *
 * New flow: creating a registry sets the plot to 'PENDING NOC' (was: straight to
 * 'REGISTRY'). Only after the NOC is generated AND approved does the plot become
 * 'REGISTRY'. These two columns record the approval.
 *
 * SAFETY: 100% additive + idempotent, accounting-owned table (plot_registries),
 * FK ON DELETE SET NULL. Existing registries keep their current plot status —
 * nothing is backfilled or reverted. Re-runnable.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      ALTER TABLE plot_registries
      ADD COLUMN IF NOT EXISTS noc_approved_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS noc_approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);
    await client.query('COMMIT');
    console.log('Migration 063_registry_noc_approval complete (noc_approved_at/by)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 063_registry_noc_approval failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
