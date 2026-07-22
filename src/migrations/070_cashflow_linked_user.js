import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 070 — map Personal Ledgers to managed login users.
 *
 * Additive and idempotent: existing ledgers remain intact and unmapped until
 * an administrator selects a user from User Management in the edit dialog.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      ALTER TABLE cash_flow_months
      ADD COLUMN IF NOT EXISTS linked_user_id INTEGER
      REFERENCES users(id) ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfm_linked_user_id
      ON cash_flow_months(linked_user_id)
      WHERE linked_user_id IS NOT NULL
    `);
    await client.query('COMMIT');
    console.log('Migration 070_cashflow_linked_user complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 070_cashflow_linked_user failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
