import pool from '../config/db.js';

const MIGRATION_KEY = '121_rera_designated_account_hardening_v1';

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

    await client.query(`
      CREATE OR REPLACE FUNCTION validate_reviewed_rera_designated_account()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        bank_name_value TEXT;
        account_number_value TEXT;
        evidence_is_scoped BOOLEAN;
        rera_profile_active BOOLEAN;
      BEGIN
        IF NEW.review_status<>'REVIEWED' OR UPPER(NEW.purpose) NOT IN (
          'RERA_SEPARATE_ACCOUNT','SEPARATE_ACCOUNT','DESIGNATED_COLLECTION_ACCOUNT'
        ) THEN
          RETURN NEW;
        END IF;
        SELECT EXISTS (
          SELECT 1 FROM site_operating_profile_revisions profile
           WHERE profile.organization_id=NEW.organization_id AND profile.site_id=NEW.site_id
             AND profile.lifecycle_status='PUBLISHED' AND profile.effective_to IS NULL
             AND profile.deleted_at IS NULL
             AND profile.operating_model IN ('RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION')
        ) INTO rera_profile_active;
        IF NOT rera_profile_active THEN RETURN NEW; END IF;

        SELECT NULLIF(BTRIM(f.bank_name),''),NULLIF(BTRIM(f.account_number),'')
          INTO bank_name_value,account_number_value
          FROM firms f WHERE f.id=NEW.firm_id AND f.site_id=NEW.site_id;
        SELECT EXISTS (
          SELECT 1 FROM documents document
           WHERE document.id=NEW.evidence_document_id AND document.site_id=NEW.site_id
             AND document.organization_id=NEW.organization_id
        ) INTO evidence_is_scoped;
        IF bank_name_value IS NULL OR account_number_value IS NULL OR NOT evidence_is_scoped THEN
          RAISE EXCEPTION USING
            ERRCODE='23514',
            MESSAGE='A reviewed RERA separate account requires bank details and Site-scoped account evidence',
            CONSTRAINT='reviewed_rera_designated_account_evidence';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_validate_reviewed_rera_designated_account ON project_account_mappings');
    await client.query(`
      CREATE TRIGGER trg_validate_reviewed_rera_designated_account
      BEFORE INSERT OR UPDATE OF review_status,purpose,firm_id
      ON project_account_mappings
      FOR EACH ROW EXECUTE FUNCTION validate_reviewed_rera_designated_account()
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION validate_rera_finance_account_evidence()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        account_is_evidenced BOOLEAN;
      BEGIN
        IF NEW.status='REJECTED' THEN RETURN NEW; END IF;
        SELECT EXISTS (
          SELECT 1
            FROM project_account_mappings mapping
            JOIN firms account ON account.id=mapping.firm_id AND account.site_id=mapping.site_id
            JOIN documents evidence ON evidence.id=mapping.evidence_document_id
             AND evidence.site_id=mapping.site_id AND evidence.organization_id=mapping.organization_id
           WHERE mapping.id=NEW.project_account_mapping_id
             AND mapping.organization_id=NEW.organization_id AND mapping.site_id=NEW.site_id
             AND mapping.review_status='REVIEWED'
             AND UPPER(mapping.purpose) IN (
               'RERA_SEPARATE_ACCOUNT','SEPARATE_ACCOUNT','DESIGNATED_COLLECTION_ACCOUNT'
             )
             AND NULLIF(BTRIM(account.bank_name),'') IS NOT NULL
             AND NULLIF(BTRIM(account.account_number),'') IS NOT NULL
        ) INTO account_is_evidenced;
        IF NOT account_is_evidenced THEN
          RAISE EXCEPTION USING
            ERRCODE='23514',
            MESSAGE='The RERA separate account needs bank details and reviewed account evidence',
            CONSTRAINT='rera_finance_designated_account_evidence';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_rera_deposit_account_evidence ON rera_collection_deposit_allocations');
    await client.query(`
      CREATE TRIGGER trg_rera_deposit_account_evidence
      BEFORE INSERT OR UPDATE OF project_account_mapping_id,status
      ON rera_collection_deposit_allocations
      FOR EACH ROW EXECUTE FUNCTION validate_rera_finance_account_evidence()
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_rera_withdrawal_account_evidence ON rera_fund_withdrawals');
    await client.query(`
      CREATE TRIGGER trg_rera_withdrawal_account_evidence
      BEFORE INSERT OR UPDATE OF project_account_mapping_id,status
      ON rera_fund_withdrawals
      FOR EACH ROW EXECUTE FUNCTION validate_rera_finance_account_evidence()
    `);

    // An account cannot be converted back into an unnamed/cash ledger while
    // it is an active, reviewed RERA separate-account mapping.
    await client.query(`
      CREATE OR REPLACE FUNCTION protect_active_rera_account_bank_details()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NULLIF(BTRIM(NEW.bank_name),'') IS NOT NULL
           AND NULLIF(BTRIM(NEW.account_number),'') IS NOT NULL THEN
          RETURN NEW;
        END IF;
        IF EXISTS (
          SELECT 1 FROM project_account_mappings mapping
          JOIN sites site ON site.id=mapping.site_id AND site.organization_id=mapping.organization_id
          JOIN site_operating_profile_revisions profile
            ON profile.organization_id=mapping.organization_id AND profile.site_id=mapping.site_id
           AND profile.lifecycle_status='PUBLISHED' AND profile.effective_to IS NULL
           AND profile.deleted_at IS NULL
           AND profile.operating_model IN ('RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION')
          WHERE mapping.firm_id=OLD.id AND mapping.review_status='REVIEWED'
            AND mapping.effective_to IS NULL
            AND UPPER(mapping.purpose) IN (
              'RERA_SEPARATE_ACCOUNT','SEPARATE_ACCOUNT','DESIGNATED_COLLECTION_ACCOUNT'
            )
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE='23514',
            MESSAGE='Bank details cannot be cleared while this is an active reviewed RERA separate account',
            CONSTRAINT='active_rera_account_bank_details';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_active_rera_account_bank_details ON firms');
    await client.query(`
      CREATE TRIGGER trg_protect_active_rera_account_bank_details
      BEFORE UPDATE OF bank_name,account_number ON firms
      FOR EACH ROW EXECUTE FUNCTION protect_active_rera_account_bank_details()
    `);

    await client.query(
      'INSERT INTO public.app_schema_migrations(version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: RERA designated-account evidence hardening');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 121_rera_designated_account_hardening failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
