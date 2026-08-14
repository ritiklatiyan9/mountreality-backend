import pool from '../config/db.js';

const MIGRATION_KEY = '118_rera_project_payment_controls_v3';

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

    // Execution and registration are deliberately distinct. An executed but
    // unregistered agreement must not unlock the RERA collection baseline.
    await client.query(`
      ALTER TABLE booking_agreements
        ADD COLUMN IF NOT EXISTS registration_status VARCHAR(24) NOT NULL DEFAULT 'NOT_REGISTERED',
        ADD COLUMN IF NOT EXISTS registration_number VARCHAR(160),
        ADD COLUMN IF NOT EXISTS registration_date DATE,
        ADD COLUMN IF NOT EXISTS registration_office VARCHAR(240),
        ADD COLUMN IF NOT EXISTS registration_recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS registration_recorded_at TIMESTAMPTZ
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname='booking_agreement_registration_status_chk'
        ) THEN
          ALTER TABLE booking_agreements
            ADD CONSTRAINT booking_agreement_registration_status_chk
            CHECK (registration_status IN ('NOT_REGISTERED','PENDING','REGISTERED'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname='booking_agreement_registered_metadata_chk'
        ) THEN
          ALTER TABLE booking_agreements
            ADD CONSTRAINT booking_agreement_registered_metadata_chk
            CHECK (
              registration_status<>'REGISTERED'
              OR (
                status='EXECUTED'
                AND NULLIF(BTRIM(registration_number),'') IS NOT NULL
                AND registration_date IS NOT NULL
                AND registration_recorded_by IS NOT NULL
                AND registration_recorded_at IS NOT NULL
              )
            );
        END IF;
      END $$
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_booking_agreement_registered_lookup
        ON booking_agreements(booking_id,version_number DESC,id DESC)
        WHERE status='EXECUTED' AND registration_status='REGISTERED'
    `);

    // Database backstop for every payment writer (Project Payments, Day Book,
    // installment APIs and future integrations). API policy evaluation still
    // layers reviewed state/tenant rules over this central ten-percent floor.
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_rera_pre_agreement_collection_limit()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_row JSONB := to_jsonb(NEW);
        v_plot_id INTEGER;
        v_site_id INTEGER;
        v_booking_id INTEGER;
        v_organization_id INTEGER;
        v_operating_model VARCHAR(80);
        v_consideration NUMERIC(15,2);
        v_registered BOOLEAN := FALSE;
        v_existing NUMERIC(15,2) := 0;
        v_contribution NUMERIC(15,2) := 0;
        v_limit NUMERIC(15,2);
      BEGIN
        v_plot_id := NULLIF(v_row->>'plot_id','')::INTEGER;
        IF v_plot_id IS NULL THEN RETURN NEW; END IF;

        SELECT p.site_id,p.current_booking_id,s.organization_id
          INTO v_site_id,v_booking_id,v_organization_id
          FROM plots p
          JOIN sites s ON s.id=p.site_id
         WHERE p.id=v_plot_id;
        IF NOT FOUND THEN RETURN NEW; END IF;

        IF TG_TABLE_NAME='plot_payments' THEN
          IF NULLIF(v_row->>'site_id','')::INTEGER IS DISTINCT FROM v_site_id THEN
            RAISE EXCEPTION 'Payment property is outside the Site';
          END IF;
          v_booking_id := COALESCE(NULLIF(v_row->>'booking_id','')::INTEGER,v_booking_id);
        ELSE
          SELECT COALESCE(pi.booking_id,v_booking_id)
            INTO v_booking_id
            FROM plot_installments pi
           WHERE pi.id=NULLIF(v_row->>'installment_id','')::INTEGER
             AND pi.plot_id=v_plot_id;
          IF NOT FOUND THEN RETURN NEW; END IF;
        END IF;

        SELECT p.operating_model
          INTO v_operating_model
          FROM site_operating_profile_revisions p
         WHERE p.organization_id=v_organization_id AND p.site_id=v_site_id
           AND p.lifecycle_status='PUBLISHED' AND p.effective_to IS NULL
           AND p.deleted_at IS NULL
         ORDER BY p.revision_number DESC,p.id DESC
         LIMIT 1;
        IF COALESCE(v_operating_model,'') NOT IN (
          'RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION'
        ) THEN RETURN NEW; END IF;

        IF v_booking_id IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE='P0001',
            MESSAGE='Select a confirmed booking before recording a RERA customer collection',
            DETAIL='RERA_BOOKING_REQUIRED_FOR_COLLECTION';
        END IF;

        SELECT b.final_consideration
          INTO v_consideration
          FROM bookings b
         WHERE b.id=v_booking_id AND b.plot_id=v_plot_id
           AND b.site_id=v_site_id AND b.organization_id=v_organization_id;
        IF NOT FOUND OR COALESCE(v_consideration,0)<=0 THEN
          RAISE EXCEPTION USING
            ERRCODE='P0001',
            MESSAGE='A confirmed booking consideration is required before recording a RERA customer collection',
            DETAIL='RERA_CONSIDERATION_REQUIRED';
        END IF;

        SELECT EXISTS (
          SELECT 1 FROM booking_agreements ba
           WHERE ba.booking_id=v_booking_id AND ba.site_id=v_site_id
             AND ba.status='EXECUTED' AND ba.registration_status='REGISTERED'
             AND NULLIF(BTRIM(ba.registration_number),'') IS NOT NULL
             AND ba.registration_date IS NOT NULL
             AND ba.status NOT IN ('SUPERSEDED','CANCELLED')
        ) INTO v_registered;
        IF v_registered THEN RETURN NEW; END IF;

        -- All writers share the same lock key, preventing concurrent pending
        -- receipts from each independently passing the ten-percent check.
        PERFORM pg_advisory_xact_lock(96096,v_plot_id);

        SELECT COALESCE(SUM(receipt.amount),0)
          INTO v_existing
          FROM (
            SELECT pp.amount
              FROM plot_payments pp
             WHERE pp.booking_id=v_booking_id
               AND (TG_TABLE_NAME<>'plot_payments'
                    OR pp.id IS DISTINCT FROM NULLIF(v_row->>'id','')::INTEGER)
               AND LOWER(COALESCE(pp.status,'approved')) NOT IN ('rejected','cancelled','void')
               AND UPPER(COALESCE(pp.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
               AND pp.reversal_of_payment_id IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM plot_payments reversal
                  WHERE reversal.reversal_of_payment_id=pp.id
                    AND LOWER(COALESCE(reversal.status,'approved')) NOT IN ('rejected','cancelled','void')
               )
            UNION ALL
            SELECT pip.amount
             FROM plot_installment_payments pip
              JOIN plot_installments pi ON pi.id=pip.installment_id
             WHERE pi.booking_id=v_booking_id
               AND (TG_TABLE_NAME<>'plot_installment_payments'
                    OR pip.id IS DISTINCT FROM NULLIF(v_row->>'id','')::INTEGER)
               AND UPPER(COALESCE(pip.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
          ) receipt;

        IF TG_TABLE_NAME='plot_payments' THEN
          IF LOWER(COALESCE(v_row->>'status','approved')) NOT IN ('rejected','cancelled','void')
             AND UPPER(COALESCE(v_row->>'cheque_status','')) NOT IN ('BOUNCED','RETURNED')
             AND NULLIF(v_row->>'reversal_of_payment_id','') IS NULL THEN
            v_contribution := COALESCE(NULLIF(v_row->>'amount','')::NUMERIC,0);
          END IF;
        ELSIF UPPER(COALESCE(v_row->>'cheque_status','')) NOT IN ('BOUNCED','RETURNED') THEN
          v_contribution := COALESCE(NULLIF(v_row->>'amount','')::NUMERIC,0);
        END IF;

        v_limit := TRUNC(v_consideration * 0.10,2);
        IF ROUND(v_existing + v_contribution,2) > v_limit THEN
          RAISE EXCEPTION USING
            ERRCODE='P0001',
            MESSAGE='This receipt would take pre-registration collections above 10% of the booking consideration',
            DETAIL='RERA_PRE_AGREEMENT_COLLECTION_LIMIT',
            HINT=FORMAT('Current collection %s; proposed %s; limit %s',v_existing,v_contribution,v_limit);
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_rera_collection_limit_plot_payments ON plot_payments');
    await client.query(`
      CREATE TRIGGER trg_rera_collection_limit_plot_payments
      BEFORE INSERT OR UPDATE OF amount,status,cheque_status,booking_id,plot_id,site_id,reversal_of_payment_id
      ON plot_payments FOR EACH ROW
      EXECUTE FUNCTION enforce_rera_pre_agreement_collection_limit()
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_rera_collection_limit_installment_payments ON plot_installment_payments');
    await client.query(`
      CREATE TRIGGER trg_rera_collection_limit_installment_payments
      BEFORE INSERT OR UPDATE OF amount,cheque_status,installment_id,plot_id
      ON plot_installment_payments FOR EACH ROW
      EXECUTE FUNCTION enforce_rera_pre_agreement_collection_limit()
    `);

    // Keep schedule balances correct even when an installment receipt is
    // edited, bounced or deleted from another supported financial surface.
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_installment_payment_balance()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_installment_amount NUMERIC(15,2);
        v_existing NUMERIC(15,2);
        v_contribution NUMERIC(15,2) := 0;
      BEGIN
        SELECT amount INTO v_installment_amount
          FROM plot_installments
         WHERE id=NEW.installment_id AND plot_id=NEW.plot_id
         FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Installment payment is outside the selected property schedule';
        END IF;
        SELECT COALESCE(SUM(pip.amount),0) INTO v_existing
          FROM plot_installment_payments pip
         WHERE pip.installment_id=NEW.installment_id
           AND pip.id IS DISTINCT FROM NEW.id
           AND UPPER(COALESCE(pip.cheque_status,'')) NOT IN ('BOUNCED','RETURNED');
        IF UPPER(COALESCE(NEW.cheque_status,'')) NOT IN ('BOUNCED','RETURNED') THEN
          v_contribution := NEW.amount;
        END IF;
        IF ROUND(v_existing+v_contribution,2)>ROUND(v_installment_amount,2) THEN
          RAISE EXCEPTION USING
            ERRCODE='P0001',
            MESSAGE='Payment exceeds the remaining amount for this installment',
            DETAIL='INSTALLMENT_PAYMENT_EXCEEDS_DUE';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_z_installment_payment_balance ON plot_installment_payments');
    await client.query(`
      CREATE TRIGGER trg_z_installment_payment_balance
      BEFORE INSERT OR UPDATE OF amount,cheque_status,installment_id,plot_id
      ON plot_installment_payments FOR EACH ROW
      EXECUTE FUNCTION enforce_installment_payment_balance()
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION sync_installment_paid_amount()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_installment_id INTEGER;
      BEGIN
        FOR v_installment_id IN
          SELECT DISTINCT id FROM (VALUES
            (CASE WHEN TG_OP<>'DELETE' THEN NEW.installment_id ELSE NULL END),
            (CASE WHEN TG_OP<>'INSERT' THEN OLD.installment_id ELSE NULL END)
          ) changed(id) WHERE id IS NOT NULL
        LOOP
          UPDATE plot_installments pi
             SET paid_amount=LEAST(pi.amount,COALESCE(receipts.total,0)),
                 status=CASE
                   WHEN COALESCE(receipts.total,0)>=pi.amount THEN 'paid'
                   WHEN pi.due_date<CURRENT_DATE THEN 'overdue'
                   WHEN COALESCE(receipts.total,0)>0 THEN 'partially_paid'
                   ELSE 'pending'
                 END,
                 updated_at=NOW()
            FROM LATERAL (
              SELECT COALESCE(SUM(pip.amount),0) AS total
                FROM plot_installment_payments pip
               WHERE pip.installment_id=v_installment_id
                 AND UPPER(COALESCE(pip.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
            ) receipts
           WHERE pi.id=v_installment_id;
        END LOOP;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_sync_installment_paid_amount ON plot_installment_payments');
    await client.query(`
      CREATE TRIGGER trg_sync_installment_paid_amount
      AFTER INSERT OR UPDATE OF amount,cheque_status,installment_id,plot_id OR DELETE
      ON plot_installment_payments FOR EACH ROW
      EXECUTE FUNCTION sync_installment_paid_amount()
    `);

    await client.query(
      'INSERT INTO public.app_schema_migrations(version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('Migration 118 (RERA project payment controls) completed successfully');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error('Migration 118_rera_project_payment_controls failed:', error.message);
  process.exit(1);
});
