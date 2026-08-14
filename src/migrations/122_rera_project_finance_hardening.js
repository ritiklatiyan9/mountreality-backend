import pool from '../config/db.js';

const MIGRATION_KEY = '122_rera_project_finance_hardening_v1';

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

    // A digest makes an idempotency key replayable only for the exact request,
    // while retaining compatibility with rows created before this migration.
    await client.query(`
      ALTER TABLE rera_collection_deposit_allocations
        ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64)
    `);
    await client.query(`
      ALTER TABLE rera_fund_withdrawals
        ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64)
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname='rera_deposit_request_fingerprint_chk'
             AND conrelid='rera_collection_deposit_allocations'::regclass
        ) THEN
          ALTER TABLE rera_collection_deposit_allocations
            ADD CONSTRAINT rera_deposit_request_fingerprint_chk
            CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$');
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname='rera_withdrawal_request_fingerprint_chk'
             AND conrelid='rera_fund_withdrawals'::regclass
        ) THEN
          ALTER TABLE rera_fund_withdrawals
            ADD CONSTRAINT rera_withdrawal_request_fingerprint_chk
            CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$');
        END IF;
      END;
      $$
    `);

    // This is the single database predicate used by API choices, control rows,
    // and canonical-source mutation guards.
    await client.query(`
      CREATE OR REPLACE FUNCTION rera_bank_entry_is_eligible(
        entry_status TEXT,
        entry_payment_mode TEXT,
        entry_cheque_status TEXT
      ) RETURNS BOOLEAN
      LANGUAGE sql
      IMMUTABLE
      AS $fn$
        SELECT LOWER(COALESCE(entry_status,''))='approved'
          AND ledger_bucket(entry_payment_mode)<>'cash'
          AND UPPER(COALESCE(entry_cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
      $fn$
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_firm_transactions_rera_choices
        ON firm_transactions(site_id,firm_id,date DESC,id DESC)
        INCLUDE (credit,debit,status,payment_mode,cheque_status)
        WHERE LOWER(COALESCE(status,''))='approved'
          AND ledger_bucket(payment_mode)<>'cash'
          AND UPPER(COALESCE(cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
          AND (credit>0 OR debit>0)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_account_rera_choices
        ON project_account_mappings(
          organization_id,site_id,rera_project_id,rera_project_phase_id,firm_id,effective_from DESC
        ) INCLUDE (effective_to,evidence_document_id)
        WHERE review_status='REVIEWED'
          AND UPPER(purpose) IN (
            'RERA_SEPARATE_ACCOUNT','SEPARATE_ACCOUNT','DESIGNATED_COLLECTION_ACCOUNT'
          )
    `);

    // Preserve the legal state machine and the evidence payload after create.
    // Review/post metadata remains editable only through the allowed transition.
    await client.query(`
      CREATE OR REPLACE FUNCTION protect_rera_finance_control_lifecycle()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME='rera_collection_deposit_allocations' THEN
          IF ROW(
            OLD.organization_id,OLD.site_id,OLD.rera_project_id,OLD.rera_project_phase_id,
            OLD.plot_payment_id,OLD.project_account_mapping_id,OLD.firm_transaction_id,
            OLD.amount,OLD.deposit_date,OLD.deposit_reference,OLD.evidence_document_id,
            OLD.idempotency_key,OLD.request_fingerprint,OLD.created_by,OLD.created_at
          ) IS DISTINCT FROM ROW(
            NEW.organization_id,NEW.site_id,NEW.rera_project_id,NEW.rera_project_phase_id,
            NEW.plot_payment_id,NEW.project_account_mapping_id,NEW.firm_transaction_id,
            NEW.amount,NEW.deposit_date,NEW.deposit_reference,NEW.evidence_document_id,
            NEW.idempotency_key,NEW.request_fingerprint,NEW.created_by,NEW.created_at
          ) THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='RERA deposit evidence is immutable; reject it and record a corrected allocation';
          END IF;
          IF OLD.status IS DISTINCT FROM NEW.status
             AND NOT (OLD.status='RECORDED' AND NEW.status IN ('VERIFIED','REJECTED')) THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='Invalid RERA collection-deposit lifecycle transition';
          END IF;
        ELSE
          IF ROW(
            OLD.organization_id,OLD.site_id,OLD.rera_project_id,OLD.rera_project_phase_id,
            OLD.project_account_mapping_id,OLD.amount,OLD.certified_eligible_amount,
            OLD.completion_percentage,OLD.requested_date,OLD.purpose,
            OLD.engineer_document_id,OLD.architect_document_id,OLD.ca_document_id,
            OLD.idempotency_key,OLD.request_fingerprint,OLD.created_by,OLD.created_at
          ) IS DISTINCT FROM ROW(
            NEW.organization_id,NEW.site_id,NEW.rera_project_id,NEW.rera_project_phase_id,
            NEW.project_account_mapping_id,NEW.amount,NEW.certified_eligible_amount,
            NEW.completion_percentage,NEW.requested_date,NEW.purpose,
            NEW.engineer_document_id,NEW.architect_document_id,NEW.ca_document_id,
            NEW.idempotency_key,NEW.request_fingerprint,NEW.created_by,NEW.created_at
          ) THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='RERA withdrawal evidence is immutable; reject it and record a corrected request';
          END IF;
          IF OLD.status IS DISTINCT FROM NEW.status
             AND NOT (
               (OLD.status='PENDING' AND NEW.status IN ('APPROVED','REJECTED'))
               OR (OLD.status='APPROVED' AND NEW.status='POSTED')
             ) THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='Invalid RERA fund-withdrawal lifecycle transition';
          END IF;
          IF OLD.firm_transaction_id IS DISTINCT FROM NEW.firm_transaction_id
             AND NOT (OLD.status='APPROVED' AND NEW.status='POSTED') THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='A withdrawal bank entry may be assigned only while posting an approved request';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_rera_deposit_lifecycle ON rera_collection_deposit_allocations');
    await client.query(`
      CREATE TRIGGER trg_protect_rera_deposit_lifecycle
      BEFORE UPDATE ON rera_collection_deposit_allocations
      FOR EACH ROW EXECUTE FUNCTION protect_rera_finance_control_lifecycle()
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_rera_withdrawal_lifecycle ON rera_fund_withdrawals');
    await client.query(`
      CREATE TRIGGER trg_protect_rera_withdrawal_lifecycle
      BEFORE UPDATE ON rera_fund_withdrawals
      FOR EACH ROW EXECUTE FUNCTION protect_rera_finance_control_lifecycle()
    `);

    // Replace the v120 validator so every writer uses the same effective-date,
    // bank-book and phase-overlap rules as the HTTP controller.
    await client.query(`
      CREATE OR REPLACE FUNCTION validate_rera_finance_control_scope()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        control_date DATE;
        mapped_project_id BIGINT;
        mapped_phase_id BIGINT;
        mapped_site_id INTEGER;
        mapped_organization_id INTEGER;
        mapped_firm_id INTEGER;
        mapped_status VARCHAR(24);
        mapped_purpose VARCHAR(80);
        mapped_effective_from DATE;
        mapped_effective_to DATE;
        mapped_evidence_valid BOOLEAN;
        mapped_bank_name TEXT;
        mapped_account_number TEXT;
        transaction_site_id INTEGER;
        transaction_firm_id INTEGER;
        transaction_credit NUMERIC(15,2);
        transaction_debit NUMERIC(15,2);
        transaction_status TEXT;
        transaction_payment_mode TEXT;
        transaction_cheque_status TEXT;
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
        project_has_phases BOOLEAN;
        document_count INTEGER;
      BEGIN
        PERFORM pg_advisory_xact_lock(
          120120,
          hashtext(NEW.organization_id::text||':'||NEW.site_id::text||':'||NEW.rera_project_id::text)
        );

        -- Rejection is the recovery path when a canonical source, mapping, or
        -- evidence document has become invalid. FK and lifecycle checks remain.
        IF NEW.status='REJECTED' THEN RETURN NEW; END IF;

        SELECT EXISTS (
          SELECT 1 FROM site_operating_profile_revisions profile
           WHERE profile.organization_id=NEW.organization_id AND profile.site_id=NEW.site_id
             AND profile.lifecycle_status='PUBLISHED' AND profile.effective_to IS NULL
             AND profile.deleted_at IS NULL
             AND profile.operating_model IN (
               'RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION'
             )
        ) INTO profile_is_rera;
        IF NOT profile_is_rera THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='RERA finance controls require a published RERA operating profile';
        END IF;

        control_date := CASE
          WHEN TG_TABLE_NAME='rera_collection_deposit_allocations' THEN NEW.deposit_date
          ELSE NEW.requested_date
        END;
        IF control_date IS NULL THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='RERA finance effective date is required';
        END IF;

        SELECT pam.rera_project_id,pam.rera_project_phase_id,pam.site_id,pam.organization_id,
               pam.firm_id,pam.review_status,pam.purpose,pam.effective_from,pam.effective_to,
               EXISTS (
                 SELECT 1 FROM documents evidence
                  WHERE evidence.id=pam.evidence_document_id
                    AND evidence.organization_id=pam.organization_id
                    AND evidence.site_id=pam.site_id
               ),NULLIF(BTRIM(f.bank_name),''),NULLIF(BTRIM(f.account_number),'')
          INTO mapped_project_id,mapped_phase_id,mapped_site_id,mapped_organization_id,
               mapped_firm_id,mapped_status,mapped_purpose,mapped_effective_from,mapped_effective_to,
               mapped_evidence_valid,mapped_bank_name,mapped_account_number
          FROM project_account_mappings pam
          JOIN firms f ON f.id=pam.firm_id AND f.site_id=pam.site_id
         WHERE pam.id=NEW.project_account_mapping_id
         FOR UPDATE OF pam;
        IF mapped_project_id IS NULL
           OR mapped_site_id<>NEW.site_id OR mapped_organization_id<>NEW.organization_id
           OR mapped_project_id<>NEW.rera_project_id
           OR (mapped_phase_id IS NOT NULL
               AND mapped_phase_id IS DISTINCT FROM NEW.rera_project_phase_id) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='RERA finance control is outside the mapped project-account scope';
        END IF;
        IF mapped_status<>'REVIEWED'
           OR UPPER(mapped_purpose) NOT IN (
             'RERA_SEPARATE_ACCOUNT','SEPARATE_ACCOUNT','DESIGNATED_COLLECTION_ACCOUNT'
           ) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='Use a reviewed RERA separate-account mapping for this control';
        END IF;
        IF control_date<mapped_effective_from
           OR (mapped_effective_to IS NOT NULL AND control_date>mapped_effective_to) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='The designated project account is not effective on this finance date';
        END IF;
        IF NOT COALESCE(mapped_evidence_valid,FALSE)
           OR mapped_bank_name IS NULL OR mapped_account_number IS NULL THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='The RERA separate account needs bank details and Site-scoped evidence';
        END IF;

        SELECT EXISTS (
          SELECT 1 FROM rera_project_phases phase
           WHERE phase.rera_project_id=NEW.rera_project_id
             AND phase.organization_id=NEW.organization_id AND phase.site_id=NEW.site_id
             AND phase.deleted_at IS NULL
        ) INTO project_has_phases;
        IF project_has_phases AND NEW.rera_project_phase_id IS NULL THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='Select the project phase that owns this RERA finance control';
        END IF;
        IF NEW.rera_project_phase_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM rera_project_phases phase
           WHERE phase.id=NEW.rera_project_phase_id
             AND phase.rera_project_id=NEW.rera_project_id
             AND phase.organization_id=NEW.organization_id AND phase.site_id=NEW.site_id
             AND phase.deleted_at IS NULL
        ) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='RERA finance phase does not belong to this project and Site';
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
            FROM plot_payments pp WHERE pp.id=NEW.plot_payment_id
            FOR UPDATE OF pp;
          IF payment_site_id IS NULL OR payment_site_id<>NEW.site_id
             OR payment_project_id IS DISTINCT FROM NEW.rera_project_id
             OR payment_phase_id IS DISTINCT FROM NEW.rera_project_phase_id THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='Collection and separate-account allocation must share one project phase';
          END IF;
          IF payment_status<>'approved' OR payment_cheque_status IN ('BOUNCED','RETURNED')
             OR payment_is_reversal OR payment_was_reversed THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='Only an approved, unreversed collection can fund the RERA separate account';
          END IF;
          SELECT COALESCE(SUM(amount),0) INTO allocated_amount
            FROM rera_collection_deposit_allocations
           WHERE plot_payment_id=NEW.plot_payment_id AND status<>'REJECTED'
             AND id<>COALESCE(NEW.id,0);
          IF allocated_amount+NEW.amount>payment_amount THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='Separate-account allocations exceed the canonical collection';
          END IF;
          IF NEW.evidence_document_id IS NOT NULL THEN
            SELECT COUNT(*) INTO document_count FROM documents document
             WHERE document.id=NEW.evidence_document_id
               AND document.site_id=NEW.site_id AND document.organization_id=NEW.organization_id;
            IF document_count<>1 THEN
              RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Deposit evidence is outside the Site';
            END IF;
          END IF;
        ELSE
          SELECT COUNT(*) INTO document_count FROM documents document
           WHERE document.id IN (
             NEW.engineer_document_id,NEW.architect_document_id,NEW.ca_document_id
           ) AND document.site_id=NEW.site_id AND document.organization_id=NEW.organization_id;
          IF document_count<>3 THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='All three withdrawal certificates must belong to this Site';
          END IF;
          IF NEW.status IN ('PENDING','APPROVED','POSTED') THEN
            SELECT COALESCE(SUM(amount),0) INTO verified_reserve
              FROM rera_collection_deposit_allocations
             WHERE organization_id=NEW.organization_id AND site_id=NEW.site_id
               AND rera_project_id=NEW.rera_project_id
               AND (NEW.rera_project_phase_id IS NULL
                    OR rera_project_phase_id=NEW.rera_project_phase_id)
               AND status='VERIFIED';
            SELECT COALESCE(SUM(amount),0) INTO committed_withdrawals
              FROM rera_fund_withdrawals
             WHERE organization_id=NEW.organization_id AND site_id=NEW.site_id
               AND rera_project_id=NEW.rera_project_id
               AND (NEW.rera_project_phase_id IS NULL
                    OR rera_project_phase_id IS NULL
                    OR rera_project_phase_id=NEW.rera_project_phase_id)
               AND status IN ('PENDING','APPROVED','POSTED')
               AND id<>COALESCE(NEW.id,0);
            IF committed_withdrawals+NEW.amount>verified_reserve THEN
              RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='Withdrawal exceeds the verified, unreserved separate-account balance';
            END IF;
          END IF;
        END IF;

        IF NEW.firm_transaction_id IS NOT NULL THEN
          SELECT ft.site_id,ft.firm_id,COALESCE(ft.credit,0),COALESCE(ft.debit,0),
                 ft.status,ft.payment_mode,ft.cheque_status
            INTO transaction_site_id,transaction_firm_id,transaction_credit,transaction_debit,
                 transaction_status,transaction_payment_mode,transaction_cheque_status
            FROM firm_transactions ft WHERE ft.id=NEW.firm_transaction_id
            FOR UPDATE OF ft;
          IF transaction_site_id IS NULL OR transaction_site_id<>NEW.site_id
             OR transaction_firm_id<>mapped_firm_id THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='Bank transaction is outside the designated project account';
          END IF;
          IF NOT rera_bank_entry_is_eligible(
            transaction_status,transaction_payment_mode,transaction_cheque_status
          ) THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='RERA controls require an approved, non-cash and unbounced bank entry';
          END IF;
          IF TG_TABLE_NAME='rera_collection_deposit_allocations' THEN
            SELECT COALESCE(SUM(amount),0) INTO allocated_amount
              FROM rera_collection_deposit_allocations
             WHERE firm_transaction_id=NEW.firm_transaction_id AND status<>'REJECTED'
               AND id<>COALESCE(NEW.id,0);
            IF transaction_credit<=0 OR allocated_amount+NEW.amount>transaction_credit THEN
              RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='Deposit allocations exceed the designated-account bank credit';
            END IF;
          ELSIF transaction_debit<NEW.amount THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='Withdrawal exceeds the designated-account bank debit';
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
        plot_payment_id,project_account_mapping_id,firm_transaction_id,evidence_document_id,
        amount,deposit_date,status
      ON rera_collection_deposit_allocations
      FOR EACH ROW EXECUTE FUNCTION validate_rera_finance_control_scope()
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_validate_rera_withdrawal_scope ON rera_fund_withdrawals');
    await client.query(`
      CREATE TRIGGER trg_validate_rera_withdrawal_scope
      BEFORE INSERT OR UPDATE OF organization_id,site_id,rera_project_id,rera_project_phase_id,
        project_account_mapping_id,firm_transaction_id,engineer_document_id,architect_document_id,
        ca_document_id,amount,requested_date,status
      ON rera_fund_withdrawals
      FOR EACH ROW EXECUTE FUNCTION validate_rera_finance_control_scope()
    `);

    // Canonical bank rows cannot be edited into cash/pending/bounced rows (or
    // have their amount/evidence rewritten) while a live RERA control cites them.
    await client.query(`
      CREATE OR REPLACE FUNCTION protect_rera_firm_transaction_source()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE source_id INTEGER; source_is_linked BOOLEAN;
      BEGIN
        source_id := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
        SELECT EXISTS (
          SELECT 1 FROM rera_collection_deposit_allocations deposit
           WHERE deposit.firm_transaction_id=source_id AND deposit.status<>'REJECTED'
          UNION ALL
          SELECT 1 FROM rera_fund_withdrawals withdrawal
           WHERE withdrawal.firm_transaction_id=source_id AND withdrawal.status<>'REJECTED'
        ) INTO source_is_linked;
        IF NOT source_is_linked THEN
          RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
        END IF;
        IF TG_OP='DELETE' THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='Reject linked RERA finance controls before deleting this bank entry';
        END IF;
        IF ROW(
          OLD.firm_id,OLD.site_id,OLD.date,OLD.description,OLD.debit,OLD.credit,
          OLD.status,OLD.payment_mode,OLD.cheque_status,OLD.cheque_no,
          OLD.transaction_no,OLD.remark
        ) IS DISTINCT FROM ROW(
          NEW.firm_id,NEW.site_id,NEW.date,NEW.description,NEW.debit,NEW.credit,
          NEW.status,NEW.payment_mode,NEW.cheque_status,NEW.cheque_no,
          NEW.transaction_no,NEW.remark
        ) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='Reject linked RERA finance controls before changing this bank-entry evidence';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_rera_firm_transaction_update ON firm_transactions');
    await client.query(`
      CREATE TRIGGER trg_protect_rera_firm_transaction_update
      BEFORE UPDATE OF firm_id,site_id,date,description,debit,credit,status,payment_mode,
        cheque_status,cheque_no,transaction_no,remark
      ON firm_transactions
      FOR EACH ROW EXECUTE FUNCTION protect_rera_firm_transaction_source()
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_rera_firm_transaction_delete ON firm_transactions');
    await client.query(`
      CREATE TRIGGER trg_protect_rera_firm_transaction_delete
      BEFORE DELETE ON firm_transactions
      FOR EACH ROW EXECUTE FUNCTION protect_rera_firm_transaction_source()
    `);

    // The customer receipt stays canonical. A reversal or mutation must not
    // silently invalidate a deposit-control row that still counts as evidence.
    await client.query(`
      CREATE OR REPLACE FUNCTION protect_rera_plot_payment_source()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE source_is_linked BOOLEAN;
      BEGIN
        IF TG_OP='INSERT' THEN
          IF NEW.reversal_of_payment_id IS NOT NULL
             AND LOWER(COALESCE(NEW.status,'approved'))='approved'
             AND UPPER(COALESCE(NEW.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
             AND EXISTS (
               SELECT 1 FROM rera_collection_deposit_allocations deposit
                WHERE deposit.plot_payment_id=NEW.reversal_of_payment_id
                  AND deposit.status<>'REJECTED'
             ) THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='Reject linked RERA deposit controls before reversing this collection';
          END IF;
          RETURN NEW;
        END IF;

        SELECT EXISTS (
          SELECT 1 FROM rera_collection_deposit_allocations deposit
           WHERE deposit.plot_payment_id=OLD.id AND deposit.status<>'REJECTED'
        ) INTO source_is_linked;
        IF TG_OP='DELETE' THEN
          IF source_is_linked THEN
            RAISE EXCEPTION USING ERRCODE='23514',
              MESSAGE='Reject linked RERA deposit controls before deleting this collection';
          END IF;
          RETURN OLD;
        END IF;

        IF source_is_linked AND ROW(
          OLD.site_id,OLD.plot_id,OLD.booking_id,OLD.rera_project_id,
          OLD.rera_project_phase_id,OLD.amount,OLD.date,OLD.status,
          OLD.cheque_status,OLD.reversal_of_payment_id,OLD.receipt_no
        ) IS DISTINCT FROM ROW(
          NEW.site_id,NEW.plot_id,NEW.booking_id,NEW.rera_project_id,
          NEW.rera_project_phase_id,NEW.amount,NEW.date,NEW.status,
          NEW.cheque_status,NEW.reversal_of_payment_id,NEW.receipt_no
        ) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='Reject linked RERA deposit controls before changing this collection evidence';
        END IF;
        IF NEW.reversal_of_payment_id IS NOT NULL
           AND NEW.reversal_of_payment_id IS DISTINCT FROM OLD.reversal_of_payment_id
           AND LOWER(COALESCE(NEW.status,'approved'))='approved'
           AND UPPER(COALESCE(NEW.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
           AND EXISTS (
             SELECT 1 FROM rera_collection_deposit_allocations deposit
              WHERE deposit.plot_payment_id=NEW.reversal_of_payment_id
                AND deposit.status<>'REJECTED'
           ) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='Reject linked RERA deposit controls before reversing this collection';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_rera_plot_payment_insert ON plot_payments');
    await client.query(`
      CREATE TRIGGER trg_protect_rera_plot_payment_insert
      BEFORE INSERT ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION protect_rera_plot_payment_source()
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_rera_plot_payment_update ON plot_payments');
    await client.query(`
      CREATE TRIGGER trg_protect_rera_plot_payment_update
      BEFORE UPDATE OF site_id,plot_id,booking_id,rera_project_id,rera_project_phase_id,
        amount,date,status,cheque_status,reversal_of_payment_id,receipt_no
      ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION protect_rera_plot_payment_source()
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_rera_plot_payment_delete ON plot_payments');
    await client.query(`
      CREATE TRIGGER trg_protect_rera_plot_payment_delete
      BEFORE DELETE ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION protect_rera_plot_payment_source()
    `);

    // v121 validated only three update columns. Recreate it so changing tenant,
    // project, phase, evidence, or effective dates cannot bypass review checks.
    await client.query('DROP TRIGGER IF EXISTS trg_validate_reviewed_rera_designated_account ON project_account_mappings');
    await client.query(`
      CREATE TRIGGER trg_validate_reviewed_rera_designated_account
      BEFORE INSERT OR UPDATE OF organization_id,site_id,firm_id,rera_project_id,
        rera_project_phase_id,purpose,effective_from,effective_to,evidence_document_id,review_status
      ON project_account_mappings
      FOR EACH ROW EXECUTE FUNCTION validate_reviewed_rera_designated_account()
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION protect_reviewed_rera_mapping_identity()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE identity_is_protected BOOLEAN; live_controls_exist BOOLEAN;
      BEGIN
        SELECT EXISTS (
          SELECT 1 FROM rera_collection_deposit_allocations deposit
           WHERE deposit.project_account_mapping_id=OLD.id AND deposit.status<>'REJECTED'
          UNION ALL
          SELECT 1 FROM rera_fund_withdrawals withdrawal
           WHERE withdrawal.project_account_mapping_id=OLD.id AND withdrawal.status<>'REJECTED'
        ) INTO live_controls_exist;
        IF live_controls_exist
           AND OLD.review_status='REVIEWED'
           AND NEW.review_status IS DISTINCT FROM OLD.review_status THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='Close or reject the reviewed RERA mapping and its live controls before changing review status';
        END IF;
        IF live_controls_exist
           AND ROW(OLD.effective_from,OLD.effective_to)
               IS DISTINCT FROM ROW(NEW.effective_from,NEW.effective_to)
           AND EXISTS (
             SELECT 1 FROM rera_collection_deposit_allocations deposit
              WHERE deposit.project_account_mapping_id=OLD.id AND deposit.status<>'REJECTED'
                AND (deposit.deposit_date<NEW.effective_from
                     OR (NEW.effective_to IS NOT NULL AND deposit.deposit_date>NEW.effective_to))
             UNION ALL
             SELECT 1 FROM rera_fund_withdrawals withdrawal
              WHERE withdrawal.project_account_mapping_id=OLD.id AND withdrawal.status<>'REJECTED'
                AND (withdrawal.requested_date<NEW.effective_from
                     OR (NEW.effective_to IS NOT NULL AND withdrawal.requested_date>NEW.effective_to))
           ) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='Close or reject the reviewed RERA mapping and its live controls before excluding their effective dates';
        END IF;
        IF ROW(
          OLD.organization_id,OLD.site_id,OLD.firm_id,OLD.rera_project_id,
          OLD.rera_project_phase_id,OLD.purpose,OLD.evidence_document_id
        ) IS NOT DISTINCT FROM ROW(
          NEW.organization_id,NEW.site_id,NEW.firm_id,NEW.rera_project_id,
          NEW.rera_project_phase_id,NEW.purpose,NEW.evidence_document_id
        ) THEN
          RETURN NEW;
        END IF;
        SELECT (
          (
            OLD.review_status='REVIEWED'
            AND UPPER(OLD.purpose) IN (
              'RERA_SEPARATE_ACCOUNT','SEPARATE_ACCOUNT','DESIGNATED_COLLECTION_ACCOUNT'
            )
            AND (OLD.effective_to IS NULL OR OLD.effective_to>=CURRENT_DATE)
            AND EXISTS (
              SELECT 1 FROM site_operating_profile_revisions profile
               WHERE profile.organization_id=OLD.organization_id AND profile.site_id=OLD.site_id
                 AND profile.lifecycle_status='PUBLISHED' AND profile.effective_to IS NULL
                 AND profile.deleted_at IS NULL
                 AND profile.operating_model IN (
                   'RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION'
                 )
            )
          ) OR live_controls_exist
        ) INTO identity_is_protected;
        IF identity_is_protected THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='Close or reject the reviewed RERA mapping and its live controls before changing account evidence';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_reviewed_rera_mapping_identity ON project_account_mappings');
    await client.query(`
      CREATE TRIGGER trg_protect_reviewed_rera_mapping_identity
      BEFORE UPDATE OF organization_id,site_id,firm_id,rera_project_id,rera_project_phase_id,
        purpose,effective_from,effective_to,evidence_document_id,review_status
      ON project_account_mappings
      FOR EACH ROW EXECUTE FUNCTION protect_reviewed_rera_mapping_identity()
    `);

    // Without account snapshots on historical controls, changing either bank
    // field would rewrite their meaning. Close the mapping/reject controls first.
    await client.query(`
      CREATE OR REPLACE FUNCTION protect_active_rera_account_bank_details()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.bank_name IS NOT DISTINCT FROM OLD.bank_name
           AND NEW.account_number IS NOT DISTINCT FROM OLD.account_number THEN
          RETURN NEW;
        END IF;
        IF EXISTS (
          SELECT 1 FROM project_account_mappings mapping
           WHERE mapping.firm_id=OLD.id
             AND (
               (
                 mapping.review_status='REVIEWED'
                 AND (mapping.effective_to IS NULL OR mapping.effective_to>=CURRENT_DATE)
                 AND UPPER(mapping.purpose) IN (
                   'RERA_SEPARATE_ACCOUNT','SEPARATE_ACCOUNT','DESIGNATED_COLLECTION_ACCOUNT'
                 )
                 AND EXISTS (
                   SELECT 1 FROM site_operating_profile_revisions profile
                    WHERE profile.organization_id=mapping.organization_id
                      AND profile.site_id=mapping.site_id
                      AND profile.lifecycle_status='PUBLISHED' AND profile.effective_to IS NULL
                      AND profile.deleted_at IS NULL
                      AND profile.operating_model IN (
                        'RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION'
                      )
                 )
               ) OR EXISTS (
                 SELECT 1 FROM rera_collection_deposit_allocations deposit
                  WHERE deposit.project_account_mapping_id=mapping.id AND deposit.status<>'REJECTED'
                 UNION ALL
                 SELECT 1 FROM rera_fund_withdrawals withdrawal
                  WHERE withdrawal.project_account_mapping_id=mapping.id AND withdrawal.status<>'REJECTED'
               )
             )
        ) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='Bank details cannot change while this account has active RERA mappings or controls';
        END IF;
        RETURN NEW;
      END;
      $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION protect_rera_evidence_document()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE document_is_linked BOOLEAN;
      BEGIN
        IF TG_OP='UPDATE'
           AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
           AND NEW.site_id IS NOT DISTINCT FROM OLD.site_id THEN
          RETURN NEW;
        END IF;
        SELECT EXISTS (
          SELECT 1 FROM project_account_mappings mapping
           WHERE mapping.evidence_document_id=OLD.id
             AND mapping.review_status='REVIEWED'
             AND UPPER(mapping.purpose) IN (
               'RERA_SEPARATE_ACCOUNT','SEPARATE_ACCOUNT','DESIGNATED_COLLECTION_ACCOUNT'
             )
          UNION ALL
          SELECT 1 FROM rera_collection_deposit_allocations deposit
           WHERE deposit.evidence_document_id=OLD.id AND deposit.status<>'REJECTED'
          UNION ALL
          SELECT 1 FROM rera_fund_withdrawals withdrawal
           WHERE OLD.id IN (
             withdrawal.engineer_document_id,
             withdrawal.architect_document_id,
             withdrawal.ca_document_id
           ) AND withdrawal.status<>'REJECTED'
        ) INTO document_is_linked;
        IF document_is_linked THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='RERA evidence cannot be moved or deleted while a reviewed mapping or live control cites it';
        END IF;
        RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_rera_evidence_document_update ON documents');
    await client.query(`
      CREATE TRIGGER trg_protect_rera_evidence_document_update
      BEFORE UPDATE OF organization_id,site_id ON documents
      FOR EACH ROW EXECUTE FUNCTION protect_rera_evidence_document()
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_rera_evidence_document_delete ON documents');
    await client.query(`
      CREATE TRIGGER trg_protect_rera_evidence_document_delete
      BEFORE DELETE ON documents
      FOR EACH ROW EXECUTE FUNCTION protect_rera_evidence_document()
    `);

    await client.query(
      'INSERT INTO public.app_schema_migrations(version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: RERA project-finance source and lifecycle hardening');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 122_rera_project_finance_hardening failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
