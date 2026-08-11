import pool from '../config/db.js';

const MIGRATION_KEY = '105_inventory_invariants_v1';

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
      'SELECT 1 FROM public.app_schema_migrations WHERE version = $1',
      [MIGRATION_KEY],
    );
    if (applied.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }
    await client.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128)`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_movement_idempotency
        ON inventory_movements(site_id,idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);
    await client.query(
      'INSERT INTO public.app_schema_migrations (version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: inventory invariants');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error('Migration 105_inventory_invariants failed:', error.message);
  process.exit(1);
});
