import pool from '../config/db.js';

/**
 * Migration: Add authority_signature_url to expenses
 * When the "Name Sign" setting is off, the authorized signatory also signs
 * on the pad; the drawn signature replaces the cursive printed name.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS authority_signature_url TEXT
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 065 complete: authority_signature_url added to expenses.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 065 failed (rolled back, no changes):', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
