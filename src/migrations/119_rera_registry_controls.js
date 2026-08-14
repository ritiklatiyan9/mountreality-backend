import pool from '../config/db.js';

const MIGRATION_KEY = '119_rera_registry_controls_v1';

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
      'SELECT 1 FROM public.app_schema_migrations WHERE version=$1',
      [MIGRATION_KEY],
    );
    if (applied.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    // Structured registration details stay queryable and auditable instead of
    // being hidden in a notes blob. Amounts are nullable because stamp duty and
    // fee rules vary by state, instrument and exemption.
    await client.query(`
      ALTER TABLE plot_registries
        ADD COLUMN IF NOT EXISTS deed_number VARCHAR(160),
        ADD COLUMN IF NOT EXISTS registration_number VARCHAR(160),
        ADD COLUMN IF NOT EXISTS sub_registrar_office VARCHAR(240),
        ADD COLUMN IF NOT EXISTS registrar_district VARCHAR(160),
        ADD COLUMN IF NOT EXISTS deed_execution_date DATE,
        ADD COLUMN IF NOT EXISTS registration_date DATE,
        ADD COLUMN IF NOT EXISTS stamp_duty_amount NUMERIC(15,2),
        ADD COLUMN IF NOT EXISTS registration_fee_amount NUMERIC(15,2)
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname='plot_registry_registration_money_chk'
             AND conrelid='plot_registries'::regclass
        ) THEN
          ALTER TABLE plot_registries
            ADD CONSTRAINT plot_registry_registration_money_chk CHECK (
              (stamp_duty_amount IS NULL OR stamp_duty_amount>=0)
              AND (registration_fee_amount IS NULL OR registration_fee_amount>=0)
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname='plot_registry_registration_dates_chk'
             AND conrelid='plot_registries'::regclass
        ) THEN
          ALTER TABLE plot_registries
            ADD CONSTRAINT plot_registry_registration_dates_chk CHECK (
              deed_execution_date IS NULL OR registration_date IS NULL
              OR registration_date>=deed_execution_date
            );
        END IF;
      END;
      $$
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_plot_registry_site_registration_number
        ON plot_registries(site_id,UPPER(registration_number))
        WHERE NULLIF(BTRIM(registration_number),'') IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plot_registry_execution_readiness
        ON plot_registries(site_id,lifecycle_status,agreement_id,plot_id)
        WHERE lifecycle_status IN ('DOCUMENTS_READY','EXECUTED','COMPLETE')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_registry_payment_canonical_lookup
        ON plot_registry_payments(registry_id,source_plot_payment_id)
        WHERE source_plot_payment_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_controlled_registry_deed
        ON documents(site_id,plot_id,created_at DESC)
        WHERE UPPER(COALESCE(category,''))='REGISTRY'
          AND uploaded_source='PLOT_REGISTRY'
    `);

    // Any write path, including a future integration, must use a canonical
    // Plot Payment when the current published profile is a RERA profile.
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_rera_registry_canonical_payment()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_site_id INTEGER;
        v_plot_id INTEGER;
        v_booking_id INTEGER;
        v_rera_enforced BOOLEAN;
      BEGIN
        SELECT site_id,plot_id,booking_id
          INTO v_site_id,v_plot_id,v_booking_id
          FROM plot_registries
         WHERE id=NEW.registry_id;
        IF v_site_id IS NULL THEN RETURN NEW; END IF;

        SELECT EXISTS (
          SELECT 1
            FROM sites s
            JOIN site_operating_profile_revisions profile
              ON profile.organization_id=s.organization_id
             AND profile.site_id=s.id
             AND profile.lifecycle_status='PUBLISHED'
             AND profile.effective_to IS NULL
             AND profile.deleted_at IS NULL
             AND profile.operating_model IN (
               'RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION'
             )
           WHERE s.id=v_site_id
        ) INTO v_rera_enforced;

        IF NOT v_rera_enforced THEN RETURN NEW; END IF;
        IF NEW.source_plot_payment_id IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE='23514',
            MESSAGE='RERA registry payments must link an approved canonical Plot Payment receipt',
            CONSTRAINT='rera_registry_canonical_payment_required';
        END IF;
        IF NOT EXISTS (
          SELECT 1
            FROM plot_payments receipt
           WHERE receipt.id=NEW.source_plot_payment_id
             AND receipt.site_id=v_site_id
             AND receipt.plot_id=v_plot_id
             AND receipt.booking_id=v_booking_id
             AND receipt.amount>0
             AND LOWER(COALESCE(receipt.status,'approved'))='approved'
             AND UPPER(COALESCE(receipt.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE='23514',
            MESSAGE='RERA registry receipt must be an approved Project Payment for the same booking and plot',
            CONSTRAINT='rera_registry_canonical_payment_required';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_rera_registry_canonical_payment ON plot_registry_payments');
    await client.query(`
      CREATE TRIGGER trg_rera_registry_canonical_payment
      BEFORE INSERT OR UPDATE OF registry_id,source_plot_payment_id
      ON plot_registry_payments
      FOR EACH ROW EXECUTE FUNCTION enforce_rera_registry_canonical_payment()
    `);

    // The controller returns a detailed checklist. This trigger is the final
    // concurrency-safe invariant: a parallel receipt/document change cannot
    // leave an executed RERA registry without its legal context or evidence.
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_rera_registry_execution_readiness()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_project_structure VARCHAR(32);
      BEGIN
        IF NEW.lifecycle_status NOT IN ('EXECUTED','COMPLETE') THEN
          RETURN NEW;
        END IF;
        IF TG_OP='UPDATE' AND NEW.lifecycle_status IS NOT DISTINCT FROM OLD.lifecycle_status THEN
          RETURN NEW;
        END IF;
        SELECT profile.project_structure
          INTO v_project_structure
            FROM sites s
            JOIN site_operating_profile_revisions profile
              ON profile.organization_id=s.organization_id
             AND profile.site_id=s.id
             AND profile.lifecycle_status='PUBLISHED'
             AND profile.effective_to IS NULL
             AND profile.deleted_at IS NULL
             AND profile.operating_model IN (
               'RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION'
             )
           WHERE s.id=NEW.site_id
           ORDER BY profile.revision_number DESC,profile.id DESC
           LIMIT 1;
        IF NOT FOUND THEN
          RETURN NEW;
        END IF;

        IF NEW.booking_id IS NULL OR NEW.agreement_id IS NULL
           OR NEW.rera_project_id IS NULL
           OR (v_project_structure='PHASE_WISE' AND NEW.rera_project_phase_id IS NULL) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE=CASE
              WHEN v_project_structure='PHASE_WISE'
                THEN 'RERA registry requires booking, agreement, project and phase context before execution'
              ELSE 'RERA registry requires booking, agreement and project context before execution'
            END,
            CONSTRAINT='rera_registry_context_required';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM booking_agreements agreement
           WHERE agreement.id=NEW.agreement_id
             AND agreement.booking_id=NEW.booking_id
             AND agreement.plot_id=NEW.plot_id
             AND agreement.site_id=NEW.site_id
             AND agreement.status='EXECUTED'
             AND agreement.execution_date IS NOT NULL
             AND agreement.registration_status='REGISTERED'
             AND NULLIF(BTRIM(agreement.registration_number),'') IS NOT NULL
             AND agreement.registration_date IS NOT NULL
        ) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='An executed and registered agreement for this booking is required before RERA registry execution',
            CONSTRAINT='rera_registry_registered_agreement_required';
        END IF;
        IF NOT EXISTS (
          SELECT 1
            FROM plot_registry_payments mapping
            JOIN plot_payments receipt ON receipt.id=mapping.source_plot_payment_id
           WHERE mapping.registry_id=NEW.id
             AND receipt.site_id=NEW.site_id
             AND receipt.plot_id=NEW.plot_id
             AND receipt.booking_id=NEW.booking_id
             AND receipt.amount>0
             AND LOWER(COALESCE(receipt.status,'approved'))='approved'
             AND UPPER(COALESCE(receipt.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
        ) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='At least one approved canonical Plot Payment receipt is required before RERA registry execution',
            CONSTRAINT='rera_registry_canonical_receipt_required';
        END IF;
        IF NULLIF(BTRIM(NEW.deed_number),'') IS NULL
           OR NULLIF(BTRIM(NEW.registration_number),'') IS NULL
           OR NULLIF(BTRIM(NEW.sub_registrar_office),'') IS NULL
           OR NEW.deed_execution_date IS NULL
           OR NEW.registration_date IS NULL THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='Complete deed and Sub-Registrar metadata before RERA registry execution',
            CONSTRAINT='rera_registry_professional_metadata_required';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM documents deed
           WHERE deed.site_id=NEW.site_id
             AND deed.plot_id=NEW.plot_id
             AND UPPER(COALESCE(deed.category,''))='REGISTRY'
             AND deed.uploaded_source='PLOT_REGISTRY'
             AND NULLIF(BTRIM(deed.file_path),'') IS NOT NULL
             AND NULLIF(BTRIM(deed.file_hash),'') IS NOT NULL
             AND deed.uploaded_by IS NOT NULL
        ) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='Upload a controlled registry deed before RERA registry execution',
            CONSTRAINT='rera_registry_controlled_deed_required';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_rera_registry_execution_readiness ON plot_registries');
    await client.query(`
      CREATE TRIGGER trg_rera_registry_execution_readiness
      BEFORE INSERT OR UPDATE OF lifecycle_status
      ON plot_registries
      FOR EACH ROW EXECUTE FUNCTION enforce_rera_registry_execution_readiness()
    `);

    // Once an RERA registry is executed, its last controlled deed is retained.
    // Supporting documents remain fully manageable, and an additional deed can
    // be uploaded before replacing an older scan.
    await client.query(`
      CREATE OR REPLACE FUNCTION protect_executed_rera_registry_deed()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF UPPER(COALESCE(OLD.category,''))<>'REGISTRY'
           OR OLD.uploaded_source<>'PLOT_REGISTRY' THEN
          IF TG_OP='DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;
        IF TG_OP='UPDATE'
           AND NEW.plot_id IS NOT DISTINCT FROM OLD.plot_id
           AND NEW.site_id IS NOT DISTINCT FROM OLD.site_id
           AND UPPER(COALESCE(NEW.category,''))='REGISTRY'
           AND NEW.uploaded_source='PLOT_REGISTRY'
           AND NULLIF(BTRIM(NEW.file_path),'') IS NOT NULL
           AND NULLIF(BTRIM(NEW.file_hash),'') IS NOT NULL
           AND NEW.uploaded_by IS NOT NULL THEN
          RETURN NEW;
        END IF;

        IF EXISTS (
          SELECT 1
            FROM plot_registries registry
            JOIN sites s ON s.id=registry.site_id
            JOIN site_operating_profile_revisions profile
              ON profile.organization_id=s.organization_id
             AND profile.site_id=s.id
             AND profile.lifecycle_status='PUBLISHED'
             AND profile.effective_to IS NULL
             AND profile.deleted_at IS NULL
             AND profile.operating_model IN (
               'RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION'
             )
           WHERE registry.site_id=OLD.site_id
             AND registry.plot_id=OLD.plot_id
             AND registry.lifecycle_status IN ('EXECUTED','COMPLETE')
        ) AND NOT EXISTS (
          SELECT 1 FROM documents replacement
           WHERE replacement.id<>OLD.id
             AND replacement.site_id=OLD.site_id
             AND replacement.plot_id=OLD.plot_id
             AND UPPER(COALESCE(replacement.category,''))='REGISTRY'
             AND replacement.uploaded_source='PLOT_REGISTRY'
             AND NULLIF(BTRIM(replacement.file_path),'') IS NOT NULL
             AND NULLIF(BTRIM(replacement.file_hash),'') IS NOT NULL
             AND replacement.uploaded_by IS NOT NULL
        ) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='The final controlled deed for an executed RERA registry cannot be removed',
            CONSTRAINT='executed_rera_registry_deed_retention';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_executed_rera_registry_deed ON documents');
    await client.query(`
      CREATE TRIGGER trg_protect_executed_rera_registry_deed
      BEFORE DELETE OR UPDATE OF plot_id,site_id,category,uploaded_source,file_path,file_hash,uploaded_by
      ON documents
      FOR EACH ROW EXECUTE FUNCTION protect_executed_rera_registry_deed()
    `);

    await client.query(`
      COMMENT ON COLUMN plot_registries.registration_number IS
        'Registered conveyance/deed identifier recorded by the Sub-Registrar.'
    `);
    await client.query(`
      COMMENT ON COLUMN plot_registries.sub_registrar_office IS
        'Sub-Registrar office shown on the registered instrument.'
    `);
    await client.query(
      'INSERT INTO public.app_schema_migrations(version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: RERA registry controls and execution evidence');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 119_rera_registry_controls failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
