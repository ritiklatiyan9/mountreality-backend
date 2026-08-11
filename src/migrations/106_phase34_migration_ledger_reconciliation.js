import pool from '../config/db.js';

const MIGRATION_KEY = '106_phase34_migration_ledger_reconciliation_v1';
const VERIFIED_KEYS = [
  '098_construction_certification_filing_v1',
  '099_phase4_portals_enterprise_v1',
  '100_phase4_performance_hardening_v1',
  '101_phase4_portal_collaboration_v1',
  '102_phase4_enterprise_rollup_performance_v1',
];

const REQUIRED_RELATIONS = [
  'public.construction_certifications',
  'public.rera_filing_periods',
  'public.portal_memberships',
  'public.integration_connections',
  'public.developer_groups',
  'public.idx_bookings_portal_member_scope',
  'public.idx_portal_comments_unresolved',
  'public.idx_bookings_enterprise_project_rollup',
  'public.idx_certifications_enterprise_latest',
  'public.idx_registries_enterprise_project_rollup',
];

async function migrate() {
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
    const alreadyApplied = await client.query(
      'SELECT 1 FROM public.app_schema_migrations WHERE version=$1',
      [MIGRATION_KEY],
    );
    if (alreadyApplied.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    for (const relation of REQUIRED_RELATIONS) {
      const result = await client.query('SELECT to_regclass($1) AS relation', [relation]);
      if (!result.rows[0]?.relation) {
        throw new Error(`Cannot reconcile Phase 3/4 ledger: missing ${relation}`);
      }
    }
    const collaborationColumns = await client.query(`
      SELECT COUNT(*)::int AS count
        FROM information_schema.columns
       WHERE table_schema='public' AND table_name='portal_comments'
         AND column_name IN ('attachment_document_grant_id','resolved_at','resolved_by','resolution_notes')
    `);
    if (collaborationColumns.rows[0].count !== 4) {
      throw new Error('Cannot reconcile Phase 4 collaboration ledger: required portal comment columns are missing');
    }

    await client.query(
      `INSERT INTO public.app_schema_migrations(version)
       SELECT UNNEST($1::text[])
       ON CONFLICT(version) DO NOTHING`,
      [VERIFIED_KEYS],
    );
    await client.query(
      'INSERT INTO public.app_schema_migrations(version) VALUES($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: Phase 3/4 migration ledger reconciliation');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error('Migration 106_phase34_migration_ledger_reconciliation failed:', error.message);
  process.exit(1);
});

