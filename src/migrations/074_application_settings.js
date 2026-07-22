import 'dotenv/config';
import pool from '../config/db.js';

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS application_settings (
        id SERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        setting_key VARCHAR(100) NOT NULL,
        setting_value JSONB NOT NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (site_id, setting_key)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_application_settings_site
        ON application_settings (site_id)
    `);
    await client.query('COMMIT');
    console.log('Migration 074_application_settings complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 074_application_settings failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
