import pool from '../config/db.js';

/**
 * Migration: Add customer_signature_url to expenses
 * Stores the S3 URL of the customer's hand-drawn signature (captured on a
 * signature pad / pen tablet) so it can be embedded on printed receipts.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS customer_signature_url TEXT
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 064 complete: customer_signature_url added to expenses.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 064 failed (rolled back, no changes):', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
