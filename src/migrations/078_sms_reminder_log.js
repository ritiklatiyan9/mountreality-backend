import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Log of payment-reminder SMS queued to SQS. `dedupe_key` carries the send date
 * so the daily automatic run can never send the same reminder twice; manual
 * sends use a key with a timestamp so they are always allowed through.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS sms_reminder_log (
        id SERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        plot_id INTEGER REFERENCES plots(id) ON DELETE SET NULL,
        dedupe_key TEXT NOT NULL,
        phone VARCHAR(20) NOT NULL,
        reminder_type VARCHAR(20) NOT NULL,
        message TEXT NOT NULL,
        source VARCHAR(10) NOT NULL DEFAULT 'auto',
        status VARCHAR(20) NOT NULL DEFAULT 'queued',
        error TEXT,
        queued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (site_id, dedupe_key)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sms_reminder_log_site_created
        ON sms_reminder_log (site_id, created_at DESC)
    `);
    await client.query('COMMIT');
    console.log('Migration 078_sms_reminder_log complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 078_sms_reminder_log failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
