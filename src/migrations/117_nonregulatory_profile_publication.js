import pool from '../config/db.js';

const MIGRATION_KEY = '117_nonregulatory_profile_publication_v1';

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
    const applied = await client.query(
      'SELECT 1 FROM public.app_schema_migrations WHERE version=$1',
      [MIGRATION_KEY],
    );
    if (applied.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    // The non-regulatory setup UI intentionally has no RERA ruleset step.
    // Keep the evidence-backed ruleset gate for the two RERA operating models,
    // while allowing a generic/development Site to publish its operating and
    // finance choices without attaching an irrelevant legal configuration.
    await client.query(`
      ALTER TABLE site_operating_profile_revisions
        DROP CONSTRAINT IF EXISTS site_profile_published_chk
    `);
    await client.query(`
      ALTER TABLE site_operating_profile_revisions
        ADD CONSTRAINT site_profile_published_chk CHECK (
          lifecycle_status <> 'PUBLISHED'
          OR (
            review_decision = 'APPROVED'
            AND reviewed_by IS NOT NULL
            AND reviewed_at IS NOT NULL
            AND published_by IS NOT NULL
            AND published_at IS NOT NULL
            AND effective_from IS NOT NULL
            AND (
              operating_model NOT IN ('RERA_PROJECT_PROMOTER', 'RERA_ONGOING_PROJECT_REGULARISATION')
              OR ruleset_version_id IS NOT NULL
            )
          )
        )
    `);
    await client.query(
      'INSERT INTO public.app_schema_migrations (version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: non-regulatory operating-profile publication');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 117_nonregulatory_profile_publication failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
