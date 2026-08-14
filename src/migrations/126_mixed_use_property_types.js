import pool from '../config/db.js';

const MIGRATION_KEY = '126_mixed_use_property_types_v1';

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

    // Keep the long-standing `plots` table and foreign keys stable while
    // allowing mixed-use Sites to identify what each inventory row represents.
    // Existing rows are plots; new clients explicitly choose a type.
    await client.query(`
      ALTER TABLE plots
        ADD COLUMN IF NOT EXISTS property_type VARCHAR(24) NOT NULL DEFAULT 'PLOT'
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname='plots_property_type_chk'
             AND conrelid='plots'::regclass
        ) THEN
          ALTER TABLE plots
            ADD CONSTRAINT plots_property_type_chk
            CHECK (property_type IN ('PLOT','APARTMENT','SHOP','OFFICE','VILLA','OTHER'));
        END IF;
      END;
      $$
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plots_site_property_type
        ON plots(site_id, property_type, UPPER(plot_no))
    `);
    await client.query(`
      COMMENT ON COLUMN plots.property_type IS
        'Inventory classification used by profile-aware property, payment and registry workspaces.'
    `);
    await client.query(
      'INSERT INTO public.app_schema_migrations(version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: mixed-use property inventory types');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 126_mixed_use_property_types failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
