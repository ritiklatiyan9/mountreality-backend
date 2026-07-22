import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Read-only reporting indexes for Balance Sheet / Day Book statements.
 * No financial rows are changed, backfilled, or deleted.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfe_balance_site_date
        ON cash_flow_entries (site_id, date DESC)
        INCLUDE (debit, credit, cash_type, source_module, source_id, status, cheque_status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfe_balance_approved_site_mode_date
        ON cash_flow_entries (site_id, cash_type, date DESC)
        WHERE LOWER(COALESCE(status, 'approved')) = 'approved'
          AND UPPER(COALESCE(cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfe_balance_source
        ON cash_flow_entries (site_id, source_module, date DESC)
    `);
    await client.query('COMMIT');
    console.log('Migration 073_balance_sheet_performance complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 073_balance_sheet_performance failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
