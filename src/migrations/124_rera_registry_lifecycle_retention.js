import pool from '../config/db.js';

const MIGRATION_KEY = '124_rera_registry_lifecycle_retention_v1';

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
    const applied = await client.query(
      'SELECT 1 FROM public.app_schema_migrations WHERE version=$1',
      [MIGRATION_KEY],
    );
    if (applied.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    // There is deliberately no implicit reopen path for a registered legal
    // instrument. EXECUTED may advance to COMPLETE; neither terminal state may
    // move backwards or sideways through direct SQL/integration writers.
    await client.query(`
      CREATE OR REPLACE FUNCTION protect_executed_rera_registry_lifecycle()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.lifecycle_status NOT IN ('EXECUTED','COMPLETE')
           OR NOT rera_registry_site_is_controlled(OLD.site_id)
           OR NEW.lifecycle_status IS NOT DISTINCT FROM OLD.lifecycle_status THEN
          RETURN NEW;
        END IF;
        IF OLD.lifecycle_status='EXECUTED' AND NEW.lifecycle_status='COMPLETE' THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION USING ERRCODE='23514',
          MESSAGE='An executed RERA registry cannot be reopened or downgraded without a controlled reopen workflow',
          CONSTRAINT='executed_rera_registry_lifecycle_immutable';
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_executed_rera_registry_lifecycle ON plot_registries');
    await client.query(`
      CREATE TRIGGER trg_protect_executed_rera_registry_lifecycle
      BEFORE UPDATE OF lifecycle_status ON plot_registries
      FOR EACH ROW EXECUTE FUNCTION protect_executed_rera_registry_lifecycle()
    `);

    await client.query(
      'INSERT INTO public.app_schema_migrations(version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: executed RERA registry lifecycle retention');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 124_rera_registry_lifecycle_retention failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
