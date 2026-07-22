import 'dotenv/config';
import pool from '../config/db.js';

async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE plot_registry_payments
      ADD COLUMN IF NOT EXISTS source_plot_payment_id INTEGER REFERENCES plot_payments(id) ON DELETE SET NULL
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_plot_registry_payments_source_plot_payment_id
      ON plot_registry_payments(source_plot_payment_id)
      WHERE source_plot_payment_id IS NOT NULL
    `);

    await client.query('COMMIT');
    console.log('Migration 025 (registry source plot payment mapping) completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during migration 025:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function down() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DROP INDEX IF EXISTS uq_plot_registry_payments_source_plot_payment_id');
    await client.query('ALTER TABLE plot_registry_payments DROP COLUMN IF EXISTS source_plot_payment_id');

    await client.query('COMMIT');
    console.log('Migration 025 rollback completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during rollback of migration 025:', err);
    throw err;
  } finally {
    client.release();
  }
}

up().then(() => process.exit(0)).catch(() => process.exit(1));
