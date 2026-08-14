import pool from '../config/db.js';

const MIGRATION_KEY = '120_rera_project_finance_controls_v1';

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

    // These are compliance-control records only. plot_payments and
    // firm_transactions remain the canonical customer and bank ledgers.
    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_collection_deposit_allocations (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        rera_project_id BIGINT NOT NULL REFERENCES rera_projects(id) ON DELETE RESTRICT,
        rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        plot_payment_id INTEGER NOT NULL REFERENCES plot_payments(id) ON DELETE RESTRICT,
        project_account_mapping_id BIGINT NOT NULL REFERENCES project_account_mappings(id) ON DELETE RESTRICT,
        firm_transaction_id INTEGER REFERENCES firm_transactions(id) ON DELETE RESTRICT,
        amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
        deposit_date DATE NOT NULL,
        deposit_reference VARCHAR(160),
        evidence_document_id INTEGER REFERENCES documents(id) ON DELETE RESTRICT,
        status VARCHAR(20) NOT NULL DEFAULT 'RECORDED'
          CHECK (status IN ('RECORDED','VERIFIED','REJECTED')),
        review_notes TEXT,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        idempotency_key VARCHAR(120),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_rera_deposit_site FOREIGN KEY (organization_id,site_id)
          REFERENCES sites(organization_id,id) ON DELETE RESTRICT,
        CONSTRAINT rera_deposit_review_state_chk CHECK (
          (status='RECORDED' AND reviewed_by IS NULL AND reviewed_at IS NULL)
          OR (status IN ('VERIFIED','REJECTED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
        ),
        CONSTRAINT rera_deposit_evidence_chk CHECK (
          firm_transaction_id IS NOT NULL OR evidence_document_id IS NOT NULL
          OR NULLIF(BTRIM(deposit_reference),'') IS NOT NULL
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_deposit_idempotency
        ON rera_collection_deposit_allocations(organization_id,site_id,idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_deposit_project_status
        ON rera_collection_deposit_allocations(
          organization_id,site_id,rera_project_id,rera_project_phase_id,status,deposit_date DESC
        ) INCLUDE (amount,plot_payment_id,project_account_mapping_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_deposit_payment
        ON rera_collection_deposit_allocations(plot_payment_id,status)
        INCLUDE (amount,firm_transaction_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_deposit_bank_transaction
        ON rera_collection_deposit_allocations(firm_transaction_id)
        WHERE firm_transaction_id IS NOT NULL AND status<>'REJECTED'
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rera_fund_withdrawals (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        rera_project_id BIGINT NOT NULL REFERENCES rera_projects(id) ON DELETE RESTRICT,
        rera_project_phase_id BIGINT REFERENCES rera_project_phases(id) ON DELETE RESTRICT,
        project_account_mapping_id BIGINT NOT NULL REFERENCES project_account_mappings(id) ON DELETE RESTRICT,
        amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
        certified_eligible_amount NUMERIC(15,2) NOT NULL CHECK (certified_eligible_amount > 0),
        completion_percentage NUMERIC(7,4) NOT NULL
          CHECK (completion_percentage > 0 AND completion_percentage <= 100),
        requested_date DATE NOT NULL,
        purpose TEXT NOT NULL CHECK (NULLIF(BTRIM(purpose),'') IS NOT NULL),
        engineer_document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
        architect_document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
        ca_document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
        firm_transaction_id INTEGER REFERENCES firm_transactions(id) ON DELETE RESTRICT,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING','APPROVED','REJECTED','POSTED')),
        review_notes TEXT,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        posted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        posted_at TIMESTAMPTZ,
        idempotency_key VARCHAR(120),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_rera_withdrawal_site FOREIGN KEY (organization_id,site_id)
          REFERENCES sites(organization_id,id) ON DELETE RESTRICT,
        CONSTRAINT rera_withdrawal_certified_amount_chk CHECK (amount <= certified_eligible_amount),
        CONSTRAINT rera_withdrawal_distinct_certificates_chk CHECK (
          engineer_document_id<>architect_document_id
          AND engineer_document_id<>ca_document_id
          AND architect_document_id<>ca_document_id
        ),
        CONSTRAINT rera_withdrawal_review_state_chk CHECK (
          (status='PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL AND posted_by IS NULL AND posted_at IS NULL)
          OR (status='REJECTED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND posted_by IS NULL AND posted_at IS NULL)
          OR (status='APPROVED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND posted_by IS NULL AND posted_at IS NULL)
          OR (status='POSTED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
              AND posted_by IS NOT NULL AND posted_at IS NOT NULL AND firm_transaction_id IS NOT NULL)
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_withdrawal_idempotency
        ON rera_fund_withdrawals(organization_id,site_id,idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rera_withdrawal_bank_transaction
        ON rera_fund_withdrawals(firm_transaction_id)
        WHERE firm_transaction_id IS NOT NULL AND status<>'REJECTED'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rera_withdrawal_project_status
        ON rera_fund_withdrawals(
          organization_id,site_id,rera_project_id,rera_project_phase_id,status,requested_date DESC
        ) INCLUDE (amount,completion_percentage,project_account_mapping_id)
    `);

    // Database-level tenant and project invariants protect future clients and
    // bulk processes from linking a control record to the wrong Site/account.
    await client.query(`
      CREATE OR REPLACE FUNCTION validate_rera_finance_control_scope()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        mapped_project_id BIGINT;
        mapped_phase_id BIGINT;
        mapped_site_id INTEGER;
        mapped_organization_id INTEGER;
        mapped_firm_id INTEGER;
        mapped_status VARCHAR(24);
        mapped_purpose VARCHAR(80);
        transaction_site_id INTEGER;
        transaction_firm_id INTEGER;
        transaction_credit NUMERIC(15,2);
        transaction_debit NUMERIC(15,2);
        payment_site_id INTEGER;
        payment_project_id BIGINT;
        payment_phase_id BIGINT;
        payment_amount NUMERIC(15,2);
        payment_status TEXT;
        payment_cheque_status TEXT;
        payment_is_reversal BOOLEAN;
        payment_was_reversed BOOLEAN;
        allocated_amount NUMERIC(15,2);
        verified_reserve NUMERIC(15,2);
        committed_withdrawals NUMERIC(15,2);
        profile_is_rera BOOLEAN;
        document_count INTEGER;
      BEGIN
        PERFORM pg_advisory_xact_lock(
          120120,
          hashtext(NEW.organization_id::text||':'||NEW.site_id::text||':'||NEW.rera_project_id::text)
        );
        SELECT EXISTS (
          SELECT 1 FROM site_operating_profile_revisions profile
           WHERE profile.organization_id=NEW.organization_id AND profile.site_id=NEW.site_id
             AND profile.lifecycle_status='PUBLISHED' AND profile.effective_to IS NULL
             AND profile.deleted_at IS NULL
             AND profile.operating_model IN ('RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION')
        ) INTO profile_is_rera;
        IF NEW.status<>'REJECTED' AND NOT profile_is_rera THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='RERA finance controls require a published RERA operating profile';
        END IF;
        SELECT pam.rera_project_id,pam.rera_project_phase_id,pam.site_id,pam.organization_id,
               pam.firm_id,pam.review_status,pam.purpose
          INTO mapped_project_id,mapped_phase_id,mapped_site_id,mapped_organization_id,
               mapped_firm_id,mapped_status,mapped_purpose
          FROM project_account_mappings pam
         WHERE pam.id=NEW.project_account_mapping_id;

        IF mapped_project_id IS NULL
           OR mapped_site_id<>NEW.site_id OR mapped_organization_id<>NEW.organization_id
           OR mapped_project_id<>NEW.rera_project_id
           OR (mapped_phase_id IS NOT NULL AND mapped_phase_id IS DISTINCT FROM NEW.rera_project_phase_id) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='RERA finance control is outside the mapped project account scope';
        END IF;
        IF NEW.status<>'REJECTED' AND mapped_status<>'REVIEWED' THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The designated project account must be reviewed first';
        END IF;
        IF NEW.status<>'REJECTED' AND UPPER(mapped_purpose) NOT IN (
          'RERA_SEPARATE_ACCOUNT','SEPARATE_ACCOUNT','DESIGNATED_COLLECTION_ACCOUNT'
        ) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Use a reviewed RERA separate-account mapping for this control';
        END IF;

        IF TG_TABLE_NAME='rera_collection_deposit_allocations' THEN
          SELECT pp.site_id,pp.rera_project_id,pp.rera_project_phase_id,pp.amount,
                 LOWER(COALESCE(pp.status,'approved')),UPPER(COALESCE(pp.cheque_status,'')),
                 pp.reversal_of_payment_id IS NOT NULL,
                 EXISTS (
                   SELECT 1 FROM plot_payments reversal
                    WHERE reversal.reversal_of_payment_id=pp.id
                      AND LOWER(COALESCE(reversal.status,'approved'))='approved'
                      AND UPPER(COALESCE(reversal.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
                 )
            INTO payment_site_id,payment_project_id,payment_phase_id,payment_amount,
                 payment_status,payment_cheque_status,payment_is_reversal,payment_was_reversed
            FROM plot_payments pp WHERE pp.id=NEW.plot_payment_id;
          IF payment_site_id IS NULL OR payment_site_id<>NEW.site_id
             OR payment_project_id IS DISTINCT FROM NEW.rera_project_id
             OR payment_phase_id IS DISTINCT FROM NEW.rera_project_phase_id THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Collection and separate-account allocation must share one project scope';
          END IF;
          IF NEW.status<>'REJECTED' AND (
             payment_status<>'approved' OR payment_cheque_status IN ('BOUNCED','RETURNED')
             OR payment_is_reversal OR payment_was_reversed) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Only an approved, unreversed collection can fund the RERA separate-account control';
          END IF;
          IF NEW.status<>'REJECTED' THEN
            SELECT COALESCE(SUM(amount),0) INTO allocated_amount
              FROM rera_collection_deposit_allocations
             WHERE plot_payment_id=NEW.plot_payment_id AND status<>'REJECTED'
               AND id<>COALESCE(NEW.id,0);
            IF allocated_amount+NEW.amount>payment_amount THEN
              RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Separate-account allocations exceed the canonical collection';
            END IF;
          END IF;
          IF NEW.evidence_document_id IS NOT NULL THEN
            SELECT COUNT(*) INTO document_count FROM documents d
             WHERE d.id=NEW.evidence_document_id AND d.site_id=NEW.site_id
               AND d.organization_id=NEW.organization_id;
            IF document_count<>1 THEN
              RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Deposit evidence is outside the Site';
            END IF;
          END IF;
        ELSE
          SELECT COUNT(*) INTO document_count FROM documents d
           WHERE d.id IN (NEW.engineer_document_id,NEW.architect_document_id,NEW.ca_document_id)
             AND d.site_id=NEW.site_id AND d.organization_id=NEW.organization_id;
          IF document_count<>3 THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='All three withdrawal certificates must belong to this Site';
          END IF;
          IF NEW.status IN ('PENDING','APPROVED','POSTED') THEN
            SELECT COALESCE(SUM(amount),0) INTO verified_reserve
              FROM rera_collection_deposit_allocations
             WHERE organization_id=NEW.organization_id AND site_id=NEW.site_id
               AND rera_project_id=NEW.rera_project_id
               AND (NEW.rera_project_phase_id IS NULL OR rera_project_phase_id=NEW.rera_project_phase_id)
               AND status='VERIFIED';
            SELECT COALESCE(SUM(amount),0) INTO committed_withdrawals
              FROM rera_fund_withdrawals
             WHERE organization_id=NEW.organization_id AND site_id=NEW.site_id
               AND rera_project_id=NEW.rera_project_id
               AND (NEW.rera_project_phase_id IS NULL OR rera_project_phase_id=NEW.rera_project_phase_id)
               AND status IN ('PENDING','APPROVED','POSTED')
               AND id<>COALESCE(NEW.id,0);
            IF committed_withdrawals+NEW.amount>verified_reserve THEN
              RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Withdrawal exceeds the verified separate-account reserve';
            END IF;
          END IF;
        END IF;

        IF NEW.firm_transaction_id IS NOT NULL THEN
          SELECT ft.site_id,ft.firm_id,COALESCE(ft.credit,0),COALESCE(ft.debit,0)
            INTO transaction_site_id,transaction_firm_id,transaction_credit,transaction_debit
            FROM firm_transactions ft WHERE ft.id=NEW.firm_transaction_id;
          IF transaction_site_id IS NULL OR transaction_site_id<>NEW.site_id
             OR transaction_firm_id<>mapped_firm_id THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Bank transaction is outside the designated project account';
          END IF;
          IF TG_TABLE_NAME='rera_collection_deposit_allocations' AND NEW.status<>'REJECTED' THEN
            SELECT COALESCE(SUM(amount),0) INTO allocated_amount
              FROM rera_collection_deposit_allocations
             WHERE firm_transaction_id=NEW.firm_transaction_id AND status<>'REJECTED'
               AND id<>COALESCE(NEW.id,0);
            IF transaction_credit<=0 OR allocated_amount+NEW.amount>transaction_credit THEN
              RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Deposit allocations exceed the designated-account bank credit';
            END IF;
          ELSIF TG_TABLE_NAME='rera_fund_withdrawals' AND NEW.status<>'REJECTED'
                AND transaction_debit<NEW.amount THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Withdrawal exceeds the designated-account bank debit';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_validate_rera_deposit_scope ON rera_collection_deposit_allocations');
    await client.query(`
      CREATE TRIGGER trg_validate_rera_deposit_scope
      BEFORE INSERT OR UPDATE OF organization_id,site_id,rera_project_id,rera_project_phase_id,
        plot_payment_id,project_account_mapping_id,firm_transaction_id,evidence_document_id,amount,status
      ON rera_collection_deposit_allocations
      FOR EACH ROW EXECUTE FUNCTION validate_rera_finance_control_scope()
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_validate_rera_withdrawal_scope ON rera_fund_withdrawals');
    await client.query(`
      CREATE TRIGGER trg_validate_rera_withdrawal_scope
      BEFORE INSERT OR UPDATE OF organization_id,site_id,rera_project_id,rera_project_phase_id,
        project_account_mapping_id,firm_transaction_id,engineer_document_id,architect_document_id,ca_document_id,
        amount,status
      ON rera_fund_withdrawals
      FOR EACH ROW EXECUTE FUNCTION validate_rera_finance_control_scope()
    `);

    await client.query(`
      COMMENT ON TABLE rera_collection_deposit_allocations IS
        'Evidence mapping only. plot_payments and firm_transactions remain the canonical monetary ledgers.'
    `);
    await client.query(`
      COMMENT ON TABLE rera_fund_withdrawals IS
        'RERA separate-account withdrawal control with engineer, architect and CA certificate evidence.'
    `);

    await client.query(
      'INSERT INTO public.app_schema_migrations(version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: RERA project-finance controls');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 120_rera_project_finance_controls failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
