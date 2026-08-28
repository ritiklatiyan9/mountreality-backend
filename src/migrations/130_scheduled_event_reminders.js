import pool from '../config/db.js';

const MIGRATION_KEY = '130_scheduled_event_reminders_v1';

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
      CREATE TABLE IF NOT EXISTS public.scheduled_event_reminder_deliveries (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
        site_id INTEGER REFERENCES public.sites(id) ON DELETE SET NULL,
        event_id BIGINT NOT NULL REFERENCES public.scheduled_events(id) ON DELETE CASCADE,
        reminder_type VARCHAR(36) NOT NULL
          CHECK (reminder_type IN ('ONE_DAY_BEFORE','ON_DAY','THIRTY_MINUTES_BEFORE')),
        channel VARCHAR(20) NOT NULL
          CHECK (channel IN ('DASHBOARD','FCM','EMAIL')),
        recipient_key VARCHAR(320) NOT NULL,
        recipient_user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
        recipient_email VARCHAR(255),
        due_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING','PROCESSING','DELIVERED','FAILED','SKIPPED')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        delivery_reference TEXT,
        failure_reason TEXT,
        sent_at TIMESTAMPTZ,
        last_attempt_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id,event_id,reminder_type,channel,recipient_key)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_event_reminders_queue
        ON public.scheduled_event_reminder_deliveries (status,due_at,id)
        WHERE status IN ('PENDING','PROCESSING','FAILED')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_event_reminders_event
        ON public.scheduled_event_reminder_deliveries (organization_id,event_id,reminder_type,channel)
    `);

    await client.query(
      'INSERT INTO public.app_schema_migrations(version) VALUES($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: durable scheduled-event reminders');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error('Migration 130_scheduled_event_reminders failed:', error.message);
  process.exit(1);
});
