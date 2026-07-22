import pool from '../config/db.js';

/**
 * Migration 009: Add voucher_url, status, approved_by, approved_at columns
 * to all financial entry tables that are missing them.
 *
 * Tables affected:
 *   - farmer_payments  (add voucher_url, status, approved_by, approved_at)
 *   - plot_commissions (add voucher_url, status, approved_by, approved_at)
 *   - cash_flow_entries(add voucher_url, status, approved_by, approved_at)
 *   - firm_transactions(add voucher_url, status, approved_by, approved_at)
 *   - plot_payments    (add voucher_url, status, approved_by, approved_at)
 *   - expenses         (already has status/approved — just ensure voucher_url exists)
 */
export default async function migrateVoucherStatusAllModules() {
  const tables = [
    'farmer_payments',
    'plot_commissions',
    'cash_flow_entries',
    'firm_transactions',
    'plot_payments',
  ];

  try {
    for (const table of tables) {
      await pool.query(`
        ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS voucher_url  VARCHAR(1000),
          ADD COLUMN IF NOT EXISTS status       VARCHAR(20) NOT NULL DEFAULT 'pending',
          ADD COLUMN IF NOT EXISTS approved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ
      `);

      // Add index on status for faster approval queries
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_${table}_status ON ${table}(status)
      `);

      console.log(`✓ ${table} updated with voucher_url, status, approved_by, approved_at`);
    }

    // Ensure expenses table has voucher_url (may already exist from migration 008)
    await pool.query(`
      ALTER TABLE expenses
        ADD COLUMN IF NOT EXISTS voucher_url VARCHAR(1000)
    `);
    console.log('✓ expenses table voucher_url ensured');

    // Set all existing records to approved so they don't block workflows
    for (const table of tables) {
      const result = await pool.query(`
        UPDATE ${table} SET status = 'approved' WHERE status = 'pending'
      `);
      if (result.rowCount > 0) {
        console.log(`  → ${table}: ${result.rowCount} existing rows set to 'approved'`);
      }
    }

    console.log('✓ Migration 009 complete: voucher + status added to all modules');
  } catch (err) {
    console.error('✗ Migration 009 failed:', err.message);
    throw err;
  }
}
