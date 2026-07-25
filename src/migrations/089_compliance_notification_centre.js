import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 089 — Global notification-centre state for Phase 5.
 *
 * Dashboard-channel reminders are durable rows already. This additive
 * migration records when the assigned recipient reads one of those rows so
 * the header bell can expose a useful unread badge without duplicating data.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('089_compliance_notification_centre'))`);
    await client.query(`
      ALTER TABLE compliance_notification_log
      ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_compliance_notifications_recipient_unread
      ON compliance_notification_log (organization_id, recipient_user_id, site_id, created_at DESC)
      WHERE channel='DASHBOARD' AND status='DELIVERED' AND read_at IS NULL
    `);
    await client.query('COMMIT');
    console.log('Migration 089_compliance_notification_centre complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 089 failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function rollback() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('089_compliance_notification_centre'))`);
    await client.query(`DROP INDEX IF EXISTS idx_compliance_notifications_recipient_unread`);
    await client.query(`ALTER TABLE compliance_notification_log DROP COLUMN IF EXISTS read_at`);
    await client.query('COMMIT');
    console.log('Migration 089_compliance_notification_centre rolled back');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 089 rollback failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

const action = process.argv.includes('--down') ? rollback : migrate;
action()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
