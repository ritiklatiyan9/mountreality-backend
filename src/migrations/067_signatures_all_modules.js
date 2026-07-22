import pool from '../config/db.js';

/**
 * Migration: customer + authority signature columns on every payment table
 * whose printed receipt has a signature footer (pad-captured PNGs on S3,
 * same as expenses migrations 064/065).
 */
const TABLES = [
  'farmer_payments',
  'day_book',
  'vendor_payments',
  'plot_payments',
  'plot_registry_payments',
  'plot_commission_payments',
  'cash_flow_entries',
];

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const table of TABLES) {
      await client.query(`
        ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS customer_signature_url TEXT,
        ADD COLUMN IF NOT EXISTS authority_signature_url TEXT
      `);
    }

    await client.query('COMMIT');
    console.log(`✅ Migration 067 complete: signature columns added to ${TABLES.length} tables.`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 067 failed (rolled back, no changes):', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
