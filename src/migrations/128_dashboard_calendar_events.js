import pool from '../config/db.js';

const MIGRATION_KEY = '128_dashboard_calendar_events_v1';

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

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.scheduled_events (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
        site_id INTEGER NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
        title VARCHAR(300) NOT NULL,
        description TEXT,
        event_date DATE NOT NULL,
        event_time TIME,
        priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM'
          CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        status VARCHAR(24) NOT NULL DEFAULT 'SCHEDULED'
          CHECK (status IN ('SCHEDULED','COMPLETED','CANCELLED')),
        created_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_events_org_site_date
        ON public.scheduled_events (organization_id, site_id, event_date, event_time, id)
        WHERE deleted_at IS NULL
    `);

    await client.query(
      'INSERT INTO public.app_schema_migrations(version) VALUES($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: dashboard scheduled calendar events');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error('Migration 128_dashboard_calendar_events failed:', error.message);
  process.exit(1);
});
