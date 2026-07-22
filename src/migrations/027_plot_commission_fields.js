import 'dotenv/config';
import pool from '../config/db.js';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE plots
      ADD COLUMN IF NOT EXISTS commission_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS commission_type VARCHAR(20) NOT NULL DEFAULT 'PERCENTAGE',
      ADD COLUMN IF NOT EXISTS commission_value NUMERIC(15,2) NOT NULL DEFAULT 0
    `);

    await client.query(`
      ALTER TABLE plots
      DROP CONSTRAINT IF EXISTS chk_plots_commission_type
    `);

    await client.query(`
      ALTER TABLE plots
      ADD CONSTRAINT chk_plots_commission_type CHECK (commission_type IN ('PERCENTAGE', 'FIXED'))
    `);

    await client.query('COMMIT');
    console.log('Migration 027 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 027 failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
