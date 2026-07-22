import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 062 — Document Imprest becomes site-scoped.
 *
 * SAFETY: 100% additive + idempotent. Adds one nullable FK column + index to the
 * document_imprest table (created in 061, still empty at time of writing).
 * ON DELETE SET NULL so removing a site never deletes register history. Re-runnable.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE document_imprest ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_document_imprest_site ON document_imprest(site_id)`);
    await client.query('COMMIT');
    console.log('Migration 062_document_imprest_site complete (site_id + index)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 062_document_imprest_site failed (rolled back, no changes):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
