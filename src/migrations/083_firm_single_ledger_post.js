import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 083 — remove legacy Firm -> Cash Flow dual posts.
 *
 * The unified firm_transactions trigger creates the canonical ledger row.
 * Older controller code could also create a source-less cash_flow_entries row
 * and link it through firm_transactions.cash_flow_entry_id, doubling the same
 * transaction on Dashboard, Day Book, Balance Sheet and Cash Flow totals.
 */

const MIGRATION_KEY = '083_firm_single_ledger_post_v1';

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.app_schema_migrations (
        version VARCHAR(160) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const marker = await client.query(
      'SELECT 1 FROM public.app_schema_migrations WHERE version = $1',
      [MIGRATION_KEY]
    );
    if (marker.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    // Only remove the old source-less row when migration 081 has already
    // produced the matching canonical firm_transactions row.
    await client.query(`
      CREATE TEMP TABLE tmp_083_firm_duplicate_cfe ON COMMIT DROP AS
      SELECT DISTINCT ft.cash_flow_entry_id AS legacy_cfe_id
      FROM firm_transactions ft
      JOIN cash_flow_entries legacy
        ON legacy.id = ft.cash_flow_entry_id
      JOIN cash_flow_entries canonical
        ON canonical.source_module = 'firm_transactions'
       AND canonical.source_id = ft.id
      WHERE ft.cash_flow_entry_id IS NOT NULL
        AND COALESCE(legacy.source_module, '') = ''
        AND legacy.id <> canonical.id
    `);

    const countResult = await client.query(
      'SELECT COUNT(*)::int AS count FROM tmp_083_firm_duplicate_cfe'
    );

    await client.query(`
      UPDATE firm_transactions ft
      SET cash_flow_entry_id = NULL
      WHERE ft.cash_flow_entry_id IN (
        SELECT legacy_cfe_id FROM tmp_083_firm_duplicate_cfe
      )
    `);

    await client.query(`
      DELETE FROM cash_flow_entries cfe
      WHERE cfe.id IN (
        SELECT legacy_cfe_id FROM tmp_083_firm_duplicate_cfe
      )
    `);

    await client.query(
      `INSERT INTO public.app_schema_migrations (version)
       VALUES ($1)
       ON CONFLICT (version) DO NOTHING`,
      [MIGRATION_KEY]
    );
    await client.query('COMMIT');
    console.log(`Migration ${MIGRATION_KEY} complete — removed ${countResult.rows[0]?.count || 0} duplicate firm ledger row(s)`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .catch((error) => {
    console.error(`Migration ${MIGRATION_KEY} failed:`, error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

