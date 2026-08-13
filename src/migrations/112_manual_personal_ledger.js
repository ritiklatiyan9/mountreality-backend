import pool from '../config/db.js';

// Personal Ledgers must be intentional, manual records. Older trigger
// revisions mirrored mapped financial-module activity into person ledgers,
// which made a source payment appear again as a Personal Ledger entry.
const MIGRATION_KEY = '112_manual_personal_ledger';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_schema_migrations (
        version VARCHAR(160) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = await client.query('SELECT 1 FROM app_schema_migrations WHERE version = $1', [MIGRATION_KEY]);
    if (applied.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    const functionResult = await client.query(`
      SELECT pg_get_functiondef('public.sync_cashflow_from_modules()'::regprocedure) AS definition
    `);
    const definition = functionResult.rows[0]?.definition;
    const mirrorStart = definition?.indexOf('-- ── person-ledger mirror');
    const returnStart = mirrorStart === undefined || mirrorStart < 0
      ? -1
      : definition.indexOf('RETURN NEW;', mirrorStart);
    if (!definition || mirrorStart < 0 || returnStart < 0) {
      throw new Error('The installed cash-flow trigger does not contain the expected person-ledger mirror block');
    }

    const manualOnlyDefinition = `${definition.slice(0, mirrorStart)}
        -- Personal Ledgers are manual-only. Remove any stale automatic mirror
        -- for this source whenever the source transaction changes.
        DELETE FROM cash_flow_entries cfe
         WHERE cfe.source_module = v_person_source_module
           AND cfe.source_id = v_source_id;

        ${definition.slice(returnStart)}`;
    await client.query(manualOnlyDefinition);

    const removedMirrors = await client.query(`
      DELETE FROM cash_flow_entries
       WHERE source_module LIKE '%\\_person' ESCAPE '\\'
    `);
    const clearedMappings = await client.query(`
      UPDATE cash_flow_months
         SET linked_user_id = NULL,
             linked_member_id = NULL,
             updated_at = NOW()
       WHERE ledger_type = 'person'
         AND (linked_user_id IS NOT NULL OR linked_member_id IS NOT NULL)
    `);

    await client.query('INSERT INTO app_schema_migrations(version) VALUES($1)', [MIGRATION_KEY]);
    await client.query('COMMIT');
    console.log(`✓ Migration applied: Personal Ledger manual-only (${removedMirrors.rowCount} automatic entries removed, ${clearedMappings.rowCount} mappings cleared)`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error('Migration 112_manual_personal_ledger failed:', error.message);
  process.exit(1);
});
