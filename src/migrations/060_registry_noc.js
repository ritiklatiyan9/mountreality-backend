import 'dotenv/config';
import pool from '../config/db.js';

async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // NOC meta lives on the registry itself — one NOC per registry.
    await client.query(`
      ALTER TABLE plot_registries
      ADD COLUMN IF NOT EXISTS noc_no VARCHAR(80),
      ADD COLUMN IF NOT EXISTS noc_date DATE,
      ADD COLUMN IF NOT EXISTS noc_place VARCHAR(150),
      ADD COLUMN IF NOT EXISTS noc_notes TEXT,
      ADD COLUMN IF NOT EXISTS noc_generated_at TIMESTAMP
    `);

    // Which registry payments print on the NOC. Existing rows default to
    // included so already-assigned payments appear without re-toggling.
    await client.query(`
      ALTER TABLE plot_registry_payments
      ADD COLUMN IF NOT EXISTS include_in_noc BOOLEAN NOT NULL DEFAULT TRUE
    `);

    await client.query('COMMIT');
    console.log('Migration 060 (registry NOC fields) completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during migration 060:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function down() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE plot_registries
      DROP COLUMN IF EXISTS noc_no,
      DROP COLUMN IF EXISTS noc_date,
      DROP COLUMN IF EXISTS noc_place,
      DROP COLUMN IF EXISTS noc_notes,
      DROP COLUMN IF EXISTS noc_generated_at
    `);
    await client.query('ALTER TABLE plot_registry_payments DROP COLUMN IF EXISTS include_in_noc');

    await client.query('COMMIT');
    console.log('Migration 060 rollback completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during rollback of migration 060:', err);
    throw err;
  } finally {
    client.release();
  }
}

up().then(() => process.exit(0)).catch(() => process.exit(1));
