import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 095 — Land Acquisition workspace.
 *
 * The existing `farmers` row is already the Site-scoped commercial commitment
 * behind farmer_payments.  This migration promotes that record into an
 * acquisition aggregate instead of introducing a second monetary source of
 * truth.  Existing rows are intentionally left without an acquisition
 * reference/lifecycle and surface as REVIEW_REQUIRED until a user explicitly
 * adopts them in the new workspace.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('095_land_acquisition_workspace'))`);

    await client.query(`
      ALTER TABLE farmers
        ADD COLUMN IF NOT EXISTS acquisition_reference VARCHAR(40),
        ADD COLUMN IF NOT EXISTS acquisition_type VARCHAR(40),
        ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR(40),
        ADD COLUMN IF NOT EXISTS legacy_mapping_status VARCHAR(24) NOT NULL DEFAULT 'REVIEW_REQUIRED',
        ADD COLUMN IF NOT EXISTS rera_project_id BIGINT,
        ADD COLUMN IF NOT EXISTS responsible_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS village VARCHAR(160),
        ADD COLUMN IF NOT EXISTS tehsil VARCHAR(160),
        ADD COLUMN IF NOT EXISTS district VARCHAR(160),
        ADD COLUMN IF NOT EXISTS state VARCHAR(160),
        ADD COLUMN IF NOT EXISTS khasra_number VARCHAR(200),
        ADD COLUMN IF NOT EXISTS survey_number VARCHAR(200),
        ADD COLUMN IF NOT EXISTS parcel_number VARCHAR(200),
        ADD COLUMN IF NOT EXISTS land_type VARCHAR(80),
        ADD COLUMN IF NOT EXISTS ownership_share NUMERIC(7,4),
        ADD COLUMN IF NOT EXISTS land_notes TEXT,
        ADD COLUMN IF NOT EXISTS financial_terms_status VARCHAR(24),
        ADD COLUMN IF NOT EXISTS financial_terms_confirmed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS financial_terms_confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS completion_notes TEXT,
        ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reopened_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS workflow_version INTEGER NOT NULL DEFAULT 1
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='farmers_acquisition_type_chk') THEN
          ALTER TABLE farmers ADD CONSTRAINT farmers_acquisition_type_chk CHECK (
            acquisition_type IS NULL OR acquisition_type IN (
              'DIRECT_PURCHASE','DEVELOPMENT_RIGHTS','JOINT_DEVELOPMENT',
              'COLLABORATION','LEASE','OTHER'
            )
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='farmers_acquisition_lifecycle_chk') THEN
          ALTER TABLE farmers ADD CONSTRAINT farmers_acquisition_lifecycle_chk CHECK (
            lifecycle_status IS NULL OR lifecycle_status IN (
              'DRAFT','LAND_DETAILS','AGREEMENT_PENDING','AGREEMENT_COMPLETED',
              'FINANCIAL_TERMS_CONFIRMED','PAYMENT_IN_PROGRESS','FULLY_PAID','COMPLETED'
            )
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='farmers_legacy_mapping_status_chk') THEN
          ALTER TABLE farmers ADD CONSTRAINT farmers_legacy_mapping_status_chk CHECK (
            legacy_mapping_status IN ('LEGACY','MAPPED','REVIEW_REQUIRED')
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='farmers_financial_terms_status_chk') THEN
          ALTER TABLE farmers ADD CONSTRAINT farmers_financial_terms_status_chk CHECK (
            financial_terms_status IS NULL OR financial_terms_status IN ('DRAFT','CONFIRMED')
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='farmers_ownership_share_chk') THEN
          ALTER TABLE farmers ADD CONSTRAINT farmers_ownership_share_chk CHECK (
            ownership_share IS NULL OR (ownership_share > 0 AND ownership_share <= 100)
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='farmers_completion_actor_chk') THEN
          ALTER TABLE farmers ADD CONSTRAINT farmers_completion_actor_chk CHECK (
            completed_at IS NULL OR completed_by IS NOT NULL
          );
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_farmers_rera_project') THEN
          ALTER TABLE farmers ADD CONSTRAINT fk_farmers_rera_project
            FOREIGN KEY (rera_project_id) REFERENCES rera_projects(id) ON DELETE RESTRICT;
        END IF;
      END $$
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_farmers_acquisition_reference ON farmers (acquisition_reference) WHERE acquisition_reference IS NOT NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_farmers_site_id_id ON farmers (site_id,id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_farmers_acquisition_workspace ON farmers (site_id,lifecycle_status,created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_farmers_landowner_acquisitions ON farmers (member_id,created_at DESC) WHERE member_id IS NOT NULL`);

    await client.query(`
      CREATE OR REPLACE FUNCTION validate_land_acquisition_scope()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_organization_id INTEGER;
      BEGIN
        IF NEW.acquisition_reference IS NULL AND NEW.lifecycle_status IS NULL THEN
          RETURN NEW;
        END IF;
        IF NEW.site_id IS NULL OR NEW.member_id IS NULL THEN
          RAISE EXCEPTION 'A Land Acquisition requires a Site and registered landowner';
        END IF;
        SELECT organization_id INTO v_organization_id FROM sites WHERE id=NEW.site_id;
        IF v_organization_id IS NULL THEN
          RAISE EXCEPTION 'Land Acquisition Site was not found';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM members WHERE id=NEW.member_id AND site_id=NEW.site_id) THEN
          RAISE EXCEPTION 'Landowner must belong to the acquisition Site';
        END IF;
        IF NEW.rera_project_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM rera_projects p
           WHERE p.id=NEW.rera_project_id AND p.organization_id=v_organization_id
             AND p.site_id=NEW.site_id AND p.deleted_at IS NULL
        ) THEN
          RAISE EXCEPTION 'Project must belong to the acquisition Site and organization';
        END IF;
        IF NEW.responsible_user_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM users u
           WHERE u.id=NEW.responsible_user_id AND u.organization_id=v_organization_id
             AND u.is_active=TRUE AND (
               u.role IN ('admin','super_admin') OR EXISTS (
                 SELECT 1 FROM user_sites us
                  WHERE us.user_id=u.id AND us.site_id=NEW.site_id
               )
             )
        ) THEN
          RAISE EXCEPTION 'Responsible employee is not available for the acquisition Site';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_validate_land_acquisition_scope ON farmers`);
    await client.query(`
      CREATE TRIGGER trg_validate_land_acquisition_scope
      BEFORE INSERT OR UPDATE OF site_id,member_id,rera_project_id,responsible_user_id,
        acquisition_reference,lifecycle_status ON farmers
      FOR EACH ROW EXECUTE FUNCTION validate_land_acquisition_scope()
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS land_acquisition_agreements (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        acquisition_id INTEGER NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        agreement_type VARCHAR(80) NOT NULL CHECK (BTRIM(agreement_type) <> ''),
        agreement_date DATE,
        agreement_number VARCHAR(160),
        agreement_status VARCHAR(24) NOT NULL DEFAULT 'DRAFT'
          CHECK (agreement_status IN ('NOT_STARTED','DRAFT','UNDER_REVIEW','EXECUTED','CANCELLED','SUPERSEDED')),
        agreement_value NUMERIC(15,2) CHECK (agreement_value IS NULL OR agreement_value >= 0),
        witness_parties JSONB NOT NULL DEFAULT '[]'::jsonb,
        remarks TEXT,
        supersedes_agreement_id BIGINT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_land_agreement_site FOREIGN KEY (organization_id,site_id)
          REFERENCES sites(organization_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_land_agreement_acquisition FOREIGN KEY (site_id,acquisition_id)
          REFERENCES farmers(site_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_land_agreement_supersedes FOREIGN KEY (supersedes_agreement_id)
          REFERENCES land_acquisition_agreements(id) ON DELETE RESTRICT,
        CONSTRAINT land_agreement_executed_chk CHECK (
          agreement_status <> 'EXECUTED' OR agreement_date IS NOT NULL
        ),
        CONSTRAINT land_agreement_review_chk CHECK (
          reviewed_at IS NULL OR reviewed_by IS NOT NULL
        ),
        UNIQUE (acquisition_id,revision_number)
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_land_agreement_id_scope ON land_acquisition_agreements (organization_id,site_id,acquisition_id,id)`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_land_agreement_supersedes_scope') THEN
          ALTER TABLE land_acquisition_agreements
            ADD CONSTRAINT fk_land_agreement_supersedes_scope
            FOREIGN KEY (organization_id,site_id,acquisition_id,supersedes_agreement_id)
            REFERENCES land_acquisition_agreements(organization_id,site_id,acquisition_id,id)
            ON DELETE RESTRICT;
        END IF;
      END $$
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_land_agreement_latest ON land_acquisition_agreements (acquisition_id,revision_number DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS land_acquisition_payment_schedules (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        acquisition_id INTEGER NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
        description VARCHAR(240) NOT NULL CHECK (BTRIM(description) <> ''),
        due_date DATE,
        expected_amount NUMERIC(15,2) NOT NULL CHECK (expected_amount > 0),
        preferred_mode VARCHAR(20) CHECK (preferred_mode IS NULL OR preferred_mode IN ('CASH','BANK','CHEQUE','SPLIT')),
        schedule_status VARCHAR(24) NOT NULL DEFAULT 'PENDING'
          CHECK (schedule_status IN ('PENDING','PARTIALLY_PAID','PAID','CANCELLED','SUPERSEDED')),
        superseded_at TIMESTAMPTZ,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_land_schedule_site FOREIGN KEY (organization_id,site_id)
          REFERENCES sites(organization_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_land_schedule_acquisition FOREIGN KEY (site_id,acquisition_id)
          REFERENCES farmers(site_id,id) ON DELETE RESTRICT,
        UNIQUE (acquisition_id,revision_number,sequence_no)
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_land_schedule_acquisition_id ON land_acquisition_payment_schedules (acquisition_id,id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_land_schedule_due ON land_acquisition_payment_schedules (site_id,due_date) WHERE superseded_at IS NULL`);

    await client.query(`
      ALTER TABLE farmer_payments
        ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120),
        ADD COLUMN IF NOT EXISTS reverses_payment_id INTEGER,
        ADD COLUMN IF NOT EXISTS reversal_reason TEXT
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_farmer_payment_reverses') THEN
          ALTER TABLE farmer_payments ADD CONSTRAINT fk_farmer_payment_reverses
            FOREIGN KEY (reverses_payment_id) REFERENCES farmer_payments(id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='farmer_payment_reversal_reason_chk') THEN
          ALTER TABLE farmer_payments ADD CONSTRAINT farmer_payment_reversal_reason_chk CHECK (
            reverses_payment_id IS NULL OR NULLIF(BTRIM(reversal_reason),'') IS NOT NULL
          );
        END IF;
      END $$
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_farmer_payment_idempotency ON farmer_payments (farmer_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_farmer_payment_reversal ON farmer_payments (reverses_payment_id) WHERE reverses_payment_id IS NOT NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_farmer_payments_farmer_id_id ON farmer_payments (farmer_id,id)`);

    // A reversal retains the original Cash/Bank partition with signed legs.
    await client.query(`ALTER TABLE farmer_payments DROP CONSTRAINT IF EXISTS farmer_payments_split_partition_check`);
    await client.query(`
      ALTER TABLE farmer_payments ADD CONSTRAINT farmer_payments_split_partition_check CHECK (
        UPPER(TRIM(COALESCE(payment_mode,''))) <> 'SPLIT'
        OR (
          COALESCE(cash_amount,0) + COALESCE(bank_amount,0) = COALESCE(amount,0)
          AND (
            (COALESCE(amount,0) >= 0 AND COALESCE(cash_amount,0) >= 0 AND COALESCE(bank_amount,0) >= 0)
            OR
            (COALESCE(amount,0) < 0 AND COALESCE(cash_amount,0) <= 0 AND COALESCE(bank_amount,0) <= 0)
          )
        )
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS land_acquisition_payment_allocations (
        id BIGSERIAL PRIMARY KEY,
        acquisition_id INTEGER NOT NULL,
        schedule_item_id BIGINT NOT NULL,
        farmer_payment_id INTEGER NOT NULL,
        allocated_amount NUMERIC(15,2) NOT NULL CHECK (allocated_amount <> 0),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_land_allocation_schedule FOREIGN KEY (acquisition_id,schedule_item_id)
          REFERENCES land_acquisition_payment_schedules(acquisition_id,id) ON DELETE RESTRICT,
        CONSTRAINT fk_land_allocation_payment FOREIGN KEY (acquisition_id,farmer_payment_id)
          REFERENCES farmer_payments(farmer_id,id) ON DELETE RESTRICT,
        UNIQUE (schedule_item_id,farmer_payment_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_land_allocation_payment ON land_acquisition_payment_allocations (farmer_payment_id)`);

    await client.query(`
      COMMENT ON COLUMN farmers.acquisition_reference IS
        'Human-readable Land Acquisition identity. NULL on untouched legacy Farmer records.'
    `);
    await client.query(`
      COMMENT ON TABLE land_acquisition_payment_allocations IS
        'Allocation only. farmer_payments remains the monetary source of truth.'
    `);

    await client.query('COMMIT');
    console.log('Migration 095_land_acquisition_workspace complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 095_land_acquisition_workspace failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function rollback() {
  console.warn('Migration 095 is forward-only; --down made no database changes.');
}

const action = process.argv.includes('--down') ? rollback : migrate;
action()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
