import pool from '../config/db.js';

const MIGRATION_KEY = '108_company_appearance_preferences';

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
    const applied = await client.query('SELECT 1 FROM app_schema_migrations WHERE version=$1', [MIGRATION_KEY]);
    if (applied.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS organization_appearance_settings (
        organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        theme VARCHAR(10) NOT NULL DEFAULT 'light' CHECK (theme IN ('light','dark')),
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_appearance_preferences (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        theme VARCHAR(10) NOT NULL CHECK (theme IN ('light','dark')),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_user_appearance_preferences_theme ON user_appearance_preferences(theme)');
    await client.query('INSERT INTO app_schema_migrations(version) VALUES($1)', [MIGRATION_KEY]);
    await client.query('COMMIT');
    console.log('✓ Migration applied: company and personal appearance preferences');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error('Migration 108_company_appearance_preferences failed:', error.message);
  process.exit(1);
});
