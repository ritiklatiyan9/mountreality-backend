import pool from '../config/db.js';

// Personal Ledger (cashflow) performance indexes:
//   - Partial index over only "active" cash_flow_entries (excluding rejected
//     and BOUNCED/RETURNED cheques) — used by EVERY aggregation in the
//     listing + month summary + category breakdown.
//   - (cash_flow_month_id, cash_type) for the cash-vs-bank totals split.
//   - (cash_flow_month_id, date) for the per-month entry list ordered by date.
//   - (site_id, month, year, ledger_name) is already a UNIQUE constraint;
//     keep it but also add (site_id, ledger_name) for the "previous month"
//     carry-forward lookup that joins by ledger.
//
// All indexes use IF NOT EXISTS so the migration is idempotent.
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Partial index — every "approved & not bounced/returned" aggregation.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfe_active_month
        ON cash_flow_entries(cash_flow_month_id)
        WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          AND (status IS NULL OR status != 'rejected')
    `);

    // (month, cash_type) for cash-vs-bank totals split.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfe_month_cash_type
        ON cash_flow_entries(cash_flow_month_id, cash_type)
    `);

    // (month, date) for the per-month entry list ordered by date.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfe_month_date
        ON cash_flow_entries(cash_flow_month_id, date, created_at)
    `);

    // (site_id, ledger_name, year, month) covers the previous-month
    // carry-forward lookup in createMonth.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfm_site_ledger_period
        ON cash_flow_months(site_id, ledger_name, year DESC, month DESC)
    `);

    // (site_id, particular) for the autocomplete DISTINCT scan.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfe_site_particular
        ON cash_flow_entries(site_id, particular)
    `);

    await client.query('COMMIT');
    console.log('Migration 053_cashflow_performance_indexes complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 053_cashflow_performance_indexes failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
