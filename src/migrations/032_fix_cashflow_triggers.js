import pool from '../config/db.js';

/**
 * Migration 032: Fix cashflow triggers to handle INSERT, UPDATE, DELETE
 * and clean up orphaned cash_flow_entries.
 */
export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Re-create triggers with INSERT OR UPDATE OR DELETE ──
    const tables = [
      'farmer_payments',
      'plot_commissions',
      'plot_commission_payments',
      'day_book',
      'firm_transactions',
      'plot_payments',
      'expenses',
      'vendor_payments',
    ];

    for (const table of tables) {
      await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_${table} ON ${table}`);
      await client.query(`
        CREATE TRIGGER trg_sync_cfe_${table}
        AFTER INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
      `);
      console.log(`  ✓ Trigger trg_sync_cfe_${table} recreated (INSERT/UPDATE/DELETE)`);
    }

    // ── 2. Clean up orphaned cash_flow_entries ──
    const orphanChecks = [
      { module: 'plot_payments', table: 'plot_payments' },
      { module: 'farmer_payments', table: 'farmer_payments' },
      { module: 'plot_commissions', table: 'plot_commissions' },
      { module: 'plot_commission_payments', table: 'plot_commission_payments' },
      { module: 'day_book', table: 'day_book' },
      { module: 'firm_transactions', table: 'firm_transactions' },
      { module: 'expenses', table: 'expenses' },
      { module: 'vendor_payments', table: 'vendor_payments' },
    ];

    for (const { module, table } of orphanChecks) {
      const r = await client.query(
        `DELETE FROM cash_flow_entries cfe
         WHERE cfe.source_module = $1
           AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = cfe.source_id)`,
        [module]
      );
      if (r.rowCount > 0) {
        console.log(`  ✓ Deleted ${r.rowCount} orphan cash_flow_entries for ${module}`);
      }
    }

    await client.query('COMMIT');
    console.log('Migration 032 complete');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const down = async () => {
  // The triggers with INSERT OR UPDATE OR DELETE are correct; nothing to revert meaningfully.
  console.log('No revert needed for migration 032');
};
