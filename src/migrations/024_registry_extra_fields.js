import 'dotenv/config';
import pool from '../config/db.js';

async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE plot_registries
      ADD COLUMN IF NOT EXISTS plot_id INTEGER REFERENCES plots(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS circle_rate NUMERIC(15,2),
      ADD COLUMN IF NOT EXISTS firm_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS seller_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS created_entry_date DATE,
      ADD COLUMN IF NOT EXISTS bank_amount NUMERIC(15,2)
    `);

    await client.query(`
      UPDATE plot_registries
      SET created_entry_date = COALESCE(created_entry_date, created_at::date)
      WHERE created_entry_date IS NULL
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_registries_plot_id ON plot_registries(plot_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_registries_created_entry_date ON plot_registries(created_entry_date)`);

    await client.query('COMMIT');
    console.log('Migration 024 (registry extra fields) completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during migration 024:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function down() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DROP INDEX IF EXISTS idx_plot_registries_plot_id');
    await client.query('DROP INDEX IF EXISTS idx_plot_registries_created_entry_date');

    await client.query(`
      ALTER TABLE plot_registries
      DROP COLUMN IF EXISTS bank_amount,
      DROP COLUMN IF EXISTS created_entry_date,
      DROP COLUMN IF EXISTS seller_name,
      DROP COLUMN IF EXISTS firm_name,
      DROP COLUMN IF EXISTS circle_rate,
      DROP COLUMN IF EXISTS plot_id
    `);

    await client.query('COMMIT');
    console.log('Migration 024 rollback completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during rollback of migration 024:', err);
    throw err;
  } finally {
    client.release();
  }
}

up().then(() => process.exit(0)).catch(() => process.exit(1));
