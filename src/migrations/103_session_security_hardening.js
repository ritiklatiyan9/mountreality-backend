import pool from '../config/db.js';

const MIGRATION_KEY = '103_session_security_hardening_v1';

const migrateSessionSecurityHardening = async () => {
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
      ALTER TABLE user_sessions
        ADD COLUMN IF NOT EXISTS refresh_token_hash TEXT,
        ADD COLUMN IF NOT EXISTS refresh_expires_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS user_agent TEXT,
        ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_user_sessions_active_user
        ON user_sessions (user_id, id)
        WHERE logout_time IS NULL;

      CREATE INDEX IF NOT EXISTS idx_user_sessions_refresh_expiry
        ON user_sessions (refresh_expires_at)
        WHERE logout_time IS NULL;
    `);
    await client.query(
      'INSERT INTO public.app_schema_migrations (version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: session security hardening');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export default migrateSessionSecurityHardening;

migrateSessionSecurityHardening()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Migration 103_session_security_hardening failed:', error.message);
    process.exit(1);
  });
