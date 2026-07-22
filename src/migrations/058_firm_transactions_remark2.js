import pool from '../config/db.js';

/**
 * Migration: Add remark2 column to firm_transactions
 * The cheque_no column already exists; this migration only introduces the
 * second free-text remark field used by the Firm Transactions table.
 */
export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE firm_transactions
      ADD COLUMN IF NOT EXISTS remark2 VARCHAR(255)
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 058 complete: remark2 added to firm_transactions.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 058 failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

export const down = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE firm_transactions
      DROP COLUMN IF EXISTS remark2
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 058 rollback complete.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 058 rollback failed:', error);
    throw error;
  } finally {
    client.release();
  }
};
