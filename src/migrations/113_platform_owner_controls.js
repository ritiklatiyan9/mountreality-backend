import pool from '../config/db.js';

const MIGRATION_KEY = '113_platform_owner_controls_v1';

/** Platform-owner audit history used by the launch operations console. */
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
      'SELECT 1 FROM public.app_schema_migrations WHERE version = $1',
      [MIGRATION_KEY],
    );
    if (applied.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_owner_audit_log (
        id BIGSERIAL PRIMARY KEY,
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        organization_id INTEGER,
        organization_name VARCHAR(200),
        action VARCHAR(80) NOT NULL,
        summary TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        request_id VARCHAR(128),
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_owner_audit_created
        ON platform_owner_audit_log (created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_owner_audit_org
        ON platform_owner_audit_log (organization_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_owner_audit_action
        ON platform_owner_audit_log (action, created_at DESC)
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_platform_owner_audit_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'platform owner audit records are append-only';
      END;
      $$;
      DROP TRIGGER IF EXISTS trg_platform_owner_audit_append_only ON platform_owner_audit_log;
      CREATE TRIGGER trg_platform_owner_audit_append_only
        BEFORE UPDATE OR DELETE ON platform_owner_audit_log
        FOR EACH ROW EXECUTE FUNCTION prevent_platform_owner_audit_mutation();
    `);
    await client.query(
      'INSERT INTO public.app_schema_migrations (version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: platform owner controls');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 113_platform_owner_controls failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
