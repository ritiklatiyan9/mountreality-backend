import pool from '../config/db.js';

export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add original_plot_rate column (stores the rate set at creation time)
    await client.query(`
      ALTER TABLE plots
      ADD COLUMN IF NOT EXISTS original_plot_rate NUMERIC(15,2) DEFAULT 0
    `);

    // Add discount_rate column (per-gaz discount given at booking)
    await client.query(`
      ALTER TABLE plots
      ADD COLUMN IF NOT EXISTS discount_rate NUMERIC(15,2) DEFAULT 0
    `);

    await client.query('COMMIT');
    console.log('Migration 032: Added original_plot_rate and discount_rate columns to plots');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const down = async () => {
  await pool.query('ALTER TABLE plots DROP COLUMN IF EXISTS original_plot_rate');
  await pool.query('ALTER TABLE plots DROP COLUMN IF EXISTS discount_rate');
  console.log('Migration 032: Removed original_plot_rate and discount_rate columns');
};
