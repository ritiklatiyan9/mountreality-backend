import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 071 — allow Personal Ledgers to be linked to a Clients/User
 * Management member as well as a managed login account.
 *
 * Additive and idempotent: it does not alter existing ledger data.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      ALTER TABLE cash_flow_months
      ADD COLUMN IF NOT EXISTS linked_member_id INTEGER
      REFERENCES members(id) ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfm_linked_member_id
      ON cash_flow_months(linked_member_id)
      WHERE linked_member_id IS NOT NULL
    `);
    await client.query('COMMIT');
    console.log('Migration 071_cashflow_linked_member complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 071_cashflow_linked_member failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
