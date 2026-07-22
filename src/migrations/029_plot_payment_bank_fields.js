import 'dotenv/config';
import pool from '../config/db.js';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE plot_payments
      ADD COLUMN IF NOT EXISTS bank_name VARCHAR(150),
      ADD COLUMN IF NOT EXISTS branch VARCHAR(150)
    `);

    await client.query('COMMIT');
    console.log('Migration 029 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 029 failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
