import pool from '../config/db.js';

export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add buyer_name to plot_payments — who is the buyer for this payment
    await client.query(`
      ALTER TABLE plot_payments
      ADD COLUMN IF NOT EXISTS buyer_name VARCHAR(255)
    `);

    // Add booked_by to plot_payments — who helped submit/book this payment
    await client.query(`
      ALTER TABLE plot_payments
      ADD COLUMN IF NOT EXISTS booked_by VARCHAR(255)
    `);

    await client.query('COMMIT');
    console.log('Migration 034: Added buyer_name, booked_by to plot_payments');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const down = async () => {
  await pool.query(`ALTER TABLE plot_payments DROP COLUMN IF EXISTS buyer_name`);
  await pool.query(`ALTER TABLE plot_payments DROP COLUMN IF EXISTS booked_by`);
  console.log('Migration 034 rolled back');
};
