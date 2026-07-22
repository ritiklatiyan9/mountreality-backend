import pool from '../config/db.js';

// Expense module performance indexes:
//   The unified expenses query joins/UNIONs across 6 source tables. Each
//   SELECT carries a `(cheque_status NOT IN BOUNCED/RETURNED) AND status !=
//   'rejected'` filter — partial indexes that pre-filter by these
//   predicates cut the working set down dramatically.
//
//   - Partial active indexes on every source table that contributes to
//     the unified breakdown (expenses, day_book[EXPENSE], farmer_payments,
//     plot_commission_payments, vendor_payments, cash_flow_entries).
//   - Site-wide DISTINCT scans (autocomplete) get partial covering indexes.
//   - (status) covers status-counts + listPending* paths.
//
// All indexes use IF NOT EXISTS so the migration is idempotent.
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── expenses table partials ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_exp_active_site
        ON expenses(site_id, date DESC)
        WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          AND status != 'rejected'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_exp_site_status
        ON expenses(site_id, status, date DESC)
    `);
    // Partial covering for autocomplete DISTINCT scans.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_exp_site_to_entity
        ON expenses(site_id, to_entity)
        WHERE to_entity IS NOT NULL AND to_entity != ''
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_exp_site_from_entity
        ON expenses(site_id, from_entity)
        WHERE from_entity IS NOT NULL AND from_entity != ''
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_exp_site_payment_mode
        ON expenses(site_id, payment_mode)
        WHERE payment_mode IS NOT NULL AND payment_mode != ''
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_exp_site_category_active
        ON expenses(site_id, category)
        WHERE category IS NOT NULL AND category != ''
    `);

    // ── day_book partial for EXPENSE entries used by unified query ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_day_book_expense_unified
        ON day_book(site_id, date DESC)
        WHERE entry_type = 'EXPENSE'
          AND farmer_payment_id IS NULL
          AND commission_id IS NULL
          AND vendor_payment_id IS NULL
          AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          AND status != 'rejected'
    `);

    // ── farmer_payments / plot_commission_payments / vendor_payments ──
    // active+approved partials covering the unified UNION ALL legs.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fp_active_for_unified
        ON farmer_payments(farmer_id, date DESC)
        WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          AND status != 'rejected'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pcp_active_for_unified
        ON plot_commission_payments(site_id, date DESC)
        WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          AND status != 'rejected'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vp_active_for_unified
        ON vendor_payments(site_id, payment_date DESC)
        WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          AND status != 'rejected'
    `);

    // ── cash_flow_entries person-ledger debit (PERSONAL LEDGER unified leg) ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfe_unified_debit
        ON cash_flow_entries(site_id, date DESC)
        WHERE debit > 0
          AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          AND (status IS NULL OR status != 'rejected')
    `);

    await client.query('COMMIT');
    console.log('Migration 057_expense_performance_indexes complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 057_expense_performance_indexes failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
