import pool from '../config/db.js';

const MIGRATION_KEY = '115_compliance_categories_v1';

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
      CREATE TABLE IF NOT EXISTS compliance_categories (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        code VARCHAR(80) NOT NULL,
        name VARCHAR(160) NOT NULL,
        description TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_categories_org_code
        ON compliance_categories (organization_id, UPPER(code))
        WHERE deleted_at IS NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_categories_org_name
        ON compliance_categories (organization_id, UPPER(name))
        WHERE deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_compliance_categories_org_active
        ON compliance_categories (organization_id, is_active, sort_order, name)
        WHERE deleted_at IS NULL
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION seed_default_compliance_categories(target_organization_id INTEGER)
      RETURNS VOID
      LANGUAGE plpgsql
      AS $$
      BEGIN
        INSERT INTO compliance_categories (organization_id, code, name, description, sort_order)
        VALUES
          (target_organization_id, 'GENERAL_COMPLIANCE', 'General compliance', 'General statutory or internal obligations.', 10),
          (target_organization_id, 'PROJECT_APPROVALS', 'Project approvals', 'Planning, development and project-level approvals.', 20),
          (target_organization_id, 'LICENCES_REGISTRATIONS', 'Licences & registrations', 'Licences, registrations, renewals and certificates.', 30),
          (target_organization_id, 'RERA_REAL_ESTATE', 'RERA & real estate', 'Real-estate regulation and project disclosure obligations.', 40),
          (target_organization_id, 'TAX_FINANCE', 'Tax & finance', 'Direct tax, indirect tax and finance-linked compliance.', 50),
          (target_organization_id, 'LABOUR_EMPLOYMENT', 'Labour & employment', 'Workforce, labour law and employee-related obligations.', 60),
          (target_organization_id, 'ENVIRONMENT_POLLUTION', 'Environment & pollution', 'Environmental, pollution and sustainability clearances.', 70),
          (target_organization_id, 'FIRE_SAFETY', 'Fire, health & safety', 'Fire, electrical, workplace and public safety obligations.', 80),
          (target_organization_id, 'LOCAL_AUTHORITY', 'Local authority', 'Municipal, panchayat and other local authority obligations.', 90),
          (target_organization_id, 'LEGAL_CONTRACTS', 'Legal & contracts', 'Legal notices, agreements and contractual obligations.', 100),
          (target_organization_id, 'INSURANCE', 'Insurance', 'Policy issuance, renewal and insurance evidence.', 110),
          (target_organization_id, 'VENDOR_THIRD_PARTY', 'Vendor & third party', 'Supplier, consultant and third-party compliance.', 120)
        ON CONFLICT (organization_id, UPPER(code)) WHERE deleted_at IS NULL DO NOTHING;
      END;
      $$
    `);

    await client.query(`SELECT seed_default_compliance_categories(id) FROM organizations`);
    await client.query(`
      CREATE OR REPLACE FUNCTION seed_compliance_categories_for_new_organization()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM seed_default_compliance_categories(NEW.id);
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_seed_compliance_categories ON organizations');
    await client.query(`
      CREATE TRIGGER trg_seed_compliance_categories
      AFTER INSERT ON organizations
      FOR EACH ROW EXECUTE FUNCTION seed_compliance_categories_for_new_organization()
    `);

    await client.query(
      'INSERT INTO public.app_schema_migrations (version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: organization-managed compliance categories');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 115_compliance_categories failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
