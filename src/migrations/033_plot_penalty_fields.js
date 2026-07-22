import pool from '../config/db.js';

export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Penalty charge when installment is unpaid after bench/grace period
    await client.query(`
      ALTER TABLE plots
      ADD COLUMN IF NOT EXISTS penalty_enabled BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await client.query(`
      ALTER TABLE plots
      ADD COLUMN IF NOT EXISTS penalty_rate NUMERIC(10,4) DEFAULT 0
    `);

    // penalty_type: per_day, per_week, per_month, percentage (of installment amount per period)
    await client.query(`
      ALTER TABLE plots
      ADD COLUMN IF NOT EXISTS penalty_type VARCHAR(20) DEFAULT 'per_day'
    `);

    // Days after bench/grace period overdue when plot becomes free to sale
    await client.query(`
      ALTER TABLE plots
      ADD COLUMN IF NOT EXISTS free_to_sale_days INTEGER DEFAULT 0
    `);

    await client.query('COMMIT');
    console.log('Migration 033: Added penalty and free_to_sale_days columns to plots');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const down = async () => {
  await pool.query('ALTER TABLE plots DROP COLUMN IF EXISTS penalty_enabled');
  await pool.query('ALTER TABLE plots DROP COLUMN IF EXISTS penalty_rate');
  await pool.query('ALTER TABLE plots DROP COLUMN IF EXISTS penalty_type');
  await pool.query('ALTER TABLE plots DROP COLUMN IF EXISTS free_to_sale_days');
  console.log('Migration 033: Removed penalty and free_to_sale_days columns');
};
