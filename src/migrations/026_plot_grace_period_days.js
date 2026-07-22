import 'dotenv/config';
import pool from '../config/db.js';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE plots
      ADD COLUMN IF NOT EXISTS grace_period_days INTEGER NOT NULL DEFAULT 15
    `);

    await client.query(`
      ALTER TABLE plots
      DROP CONSTRAINT IF EXISTS chk_plots_grace_period_days_non_negative
    `);

    await client.query(`
      ALTER TABLE plots
      ADD CONSTRAINT chk_plots_grace_period_days_non_negative CHECK (grace_period_days >= 0)
    `);

    await client.query('COMMIT');
    console.log('Migration 026 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 026 failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
