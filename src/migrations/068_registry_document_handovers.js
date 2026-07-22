import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Registry document handover timeline — one row per (offline) handover event of
 * registry papers to the customer: who received, who gave, when, optional notes
 * and a live photo taken at the moment of handover (S3 URL via /upload/single).
 * Purely additive; no existing tables are altered.
 */
async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS registry_document_handovers (
        id SERIAL PRIMARY KEY,
        registry_id INTEGER NOT NULL REFERENCES plot_registries(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        given_to VARCHAR(255) NOT NULL,
        notes TEXT,
        photo_url TEXT,
        given_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        given_at TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_registry_handovers_registry
        ON registry_document_handovers(registry_id)
    `);

    await client.query('COMMIT');
    console.log('Migration 068 (registry document handovers) completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during migration 068:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function down() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DROP TABLE IF EXISTS registry_document_handovers');
    await client.query('COMMIT');
    console.log('Migration 068 rollback completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during rollback of migration 068:', err);
    throw err;
  } finally {
    client.release();
  }
}

up().then(() => process.exit(0)).catch(() => process.exit(1));
