import pool from '../config/db.js';

const MIGRATION_KEY = '123_rera_registry_legal_integrity_v1';

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

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plot_payment_active_reversal_lookup
        ON plot_payments(reversal_of_payment_id,status,cheque_status)
        WHERE reversal_of_payment_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_plot_registries_agreement_execution_guard
        ON plot_registries(agreement_id,site_id)
        WHERE lifecycle_status IN ('EXECUTED','COMPLETE')
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION rera_registry_site_is_controlled(p_site_id INTEGER)
      RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
          SELECT 1
            FROM sites site
            JOIN site_operating_profile_revisions profile
              ON profile.organization_id=site.organization_id
             AND profile.site_id=site.id
             AND profile.lifecycle_status='PUBLISHED'
             AND profile.effective_to IS NULL
             AND profile.deleted_at IS NULL
             AND profile.operating_model IN (
               'RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION'
             )
           WHERE site.id=p_site_id
        )
      $$
    `);

    // This is the single database definition of a canonical registry receipt.
    // Reversal audit rows are never receipts, and an active approved/unbounced
    // reversal invalidates its original without destroying either row.
    await client.query(`
      CREATE OR REPLACE FUNCTION rera_registry_source_receipt_is_eligible(
        p_registry_id BIGINT,
        p_receipt_id BIGINT
      ) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
          SELECT 1
            FROM plot_registries registry
            JOIN plot_payments receipt ON receipt.id=p_receipt_id
           WHERE registry.id=p_registry_id
             AND receipt.site_id=registry.site_id
             AND receipt.plot_id=registry.plot_id
             AND receipt.booking_id=registry.booking_id
             AND receipt.amount>0
             AND LOWER(COALESCE(receipt.status,'approved'))='approved'
             AND UPPER(COALESCE(receipt.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
             AND receipt.reversal_of_payment_id IS NULL
             AND NOT EXISTS (
               SELECT 1
                 FROM plot_payments reversal
                WHERE reversal.reversal_of_payment_id=receipt.id
                  AND LOWER(COALESCE(reversal.status,'approved'))='approved'
                  AND UPPER(COALESCE(reversal.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
             )
        )
      $$
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION rera_registry_has_eligible_receipt(
        p_registry_id BIGINT,
        p_excluded_receipt_id BIGINT DEFAULT NULL
      ) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
          SELECT 1
            FROM plot_registry_payments mapping
           WHERE mapping.registry_id=p_registry_id
             AND mapping.source_plot_payment_id IS NOT NULL
             AND (p_excluded_receipt_id IS NULL
                  OR mapping.source_plot_payment_id<>p_excluded_receipt_id)
             AND rera_registry_source_receipt_is_eligible(
               p_registry_id,
               mapping.source_plot_payment_id
             )
        )
      $$
    `);

    // The stored amounts are presentation snapshots, never client-authored
    // consideration in RERA mode. Canonical Project Payment receipts are the
    // source of truth and PostgreSQL performs the numeric aggregation.
    await client.query(`
      CREATE OR REPLACE FUNCTION refresh_rera_registry_derived_amounts(p_registry_id BIGINT)
      RETURNS VOID LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM plot_registries registry
           WHERE registry.id=p_registry_id
             AND rera_registry_site_is_controlled(registry.site_id)
        ) THEN
          RETURN;
        END IF;

        UPDATE plot_registries registry
           SET registry_payment=totals.total_amount,
               bank_amount=totals.bank_amount,
               updated_at=NOW()
          FROM (
            SELECT COALESCE(SUM(receipt.amount),0)::numeric AS total_amount,
                   COALESCE(SUM(receipt.amount) FILTER (
                     WHERE ledger_bucket(receipt.payment_type)<>'cash'
                   ),0)::numeric AS bank_amount
              FROM plot_registry_payments mapping
              JOIN plot_payments receipt ON receipt.id=mapping.source_plot_payment_id
             WHERE mapping.registry_id=p_registry_id
               AND rera_registry_source_receipt_is_eligible(p_registry_id,receipt.id)
          ) totals
         WHERE registry.id=p_registry_id;
      END;
      $$
    `);

    // Direct SQL writers receive the same rule as the HTTP controllers. This
    // trigger also makes a staged INSERT deterministic (zero until mappings
    // are added); mapping/source triggers then maintain the snapshot.
    await client.query(`
      CREATE OR REPLACE FUNCTION derive_rera_registry_monetary_fields()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_total NUMERIC := 0;
        v_bank NUMERIC := 0;
      BEGIN
        IF NOT rera_registry_site_is_controlled(NEW.site_id) THEN RETURN NEW; END IF;
        IF TG_OP='UPDATE' THEN
          SELECT COALESCE(SUM(receipt.amount),0)::numeric,
                 COALESCE(SUM(receipt.amount) FILTER (
                   WHERE ledger_bucket(receipt.payment_type)<>'cash'
                 ),0)::numeric
            INTO v_total,v_bank
            FROM plot_registry_payments mapping
            JOIN plot_payments receipt ON receipt.id=mapping.source_plot_payment_id
           WHERE mapping.registry_id=NEW.id
             AND receipt.site_id=NEW.site_id
             AND receipt.plot_id=NEW.plot_id
             AND receipt.booking_id=NEW.booking_id
             AND receipt.amount>0
             AND LOWER(COALESCE(receipt.status,'approved'))='approved'
             AND UPPER(COALESCE(receipt.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
             AND receipt.reversal_of_payment_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM plot_payments reversal
                WHERE reversal.reversal_of_payment_id=receipt.id
                  AND LOWER(COALESCE(reversal.status,'approved'))='approved'
                  AND UPPER(COALESCE(reversal.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
             );
        END IF;
        NEW.registry_payment := COALESCE(v_total,0);
        NEW.bank_amount := COALESCE(v_bank,0);
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_derive_rera_registry_monetary_fields ON plot_registries');
    await client.query(`
      CREATE TRIGGER trg_derive_rera_registry_monetary_fields
      BEFORE INSERT OR UPDATE OF registry_payment,bank_amount
      ON plot_registries
      FOR EACH ROW EXECUTE FUNCTION derive_rera_registry_monetary_fields()
    `);

    // Replace migration 119's guard so every linking surface applies reversal
    // semantics as well as exact Site/property/booking scope.
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_rera_registry_canonical_payment()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_site_id INTEGER;
      BEGIN
        SELECT site_id INTO v_site_id
          FROM plot_registries
         WHERE id=NEW.registry_id;
        IF v_site_id IS NULL OR NOT rera_registry_site_is_controlled(v_site_id) THEN
          RETURN NEW;
        END IF;
        IF NEW.source_plot_payment_id IS NULL
           OR NOT rera_registry_source_receipt_is_eligible(
             NEW.registry_id,
             NEW.source_plot_payment_id
           ) THEN
          RAISE EXCEPTION USING
            ERRCODE='23514',
            MESSAGE='RERA registry receipt must be an unreversed approved Project Payment for the exact booking and plot',
            CONSTRAINT='rera_registry_canonical_payment_required';
        END IF;
        RETURN NEW;
      END;
      $$
    `);

    // Keep staged creation and preparation possible. The strict legal context,
    // canonical receipt, deed and registration metadata are required only when
    // the registry crosses into EXECUTED/COMPLETE. Full collection is left to
    // an explicitly configured workflow-policy check.
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_rera_registry_execution_readiness()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_project_structure VARCHAR(32);
      BEGIN
        IF NEW.lifecycle_status NOT IN ('EXECUTED','COMPLETE') THEN RETURN NEW; END IF;
        IF TG_OP='UPDATE' AND NEW.lifecycle_status IS NOT DISTINCT FROM OLD.lifecycle_status THEN
          RETURN NEW;
        END IF;

        SELECT profile.project_structure
          INTO v_project_structure
          FROM sites site
          JOIN site_operating_profile_revisions profile
            ON profile.organization_id=site.organization_id
           AND profile.site_id=site.id
           AND profile.lifecycle_status='PUBLISHED'
           AND profile.effective_to IS NULL
           AND profile.deleted_at IS NULL
           AND profile.operating_model IN (
             'RERA_PROJECT_PROMOTER','RERA_ONGOING_PROJECT_REGULARISATION'
           )
         WHERE site.id=NEW.site_id
         ORDER BY profile.revision_number DESC,profile.id DESC
         LIMIT 1;
        IF NOT FOUND THEN RETURN NEW; END IF;

        IF NEW.booking_id IS NULL OR NEW.agreement_id IS NULL
           OR NEW.rera_project_id IS NULL
           OR (v_project_structure='PHASE_WISE' AND NEW.rera_project_phase_id IS NULL) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE=CASE WHEN v_project_structure='PHASE_WISE'
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
        IF NOT rera_registry_has_eligible_receipt(NEW.id,NULL) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='At least one unreversed canonical Project Payment receipt is required before RERA registry execution',
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

    // A mapping cannot be removed or pointed elsewhere if doing so would leave
    // an executed RERA registry without a canonical receipt.
    await client.query(`
      CREATE OR REPLACE FUNCTION protect_executed_rera_registry_receipt_mapping()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_registry plot_registries%ROWTYPE;
        v_replacement_eligible BOOLEAN := FALSE;
      BEGIN
        IF OLD.source_plot_payment_id IS NULL THEN
          IF TG_OP='DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;
        IF TG_OP='UPDATE'
           AND NEW.registry_id IS NOT DISTINCT FROM OLD.registry_id
           AND NEW.source_plot_payment_id IS NOT DISTINCT FROM OLD.source_plot_payment_id THEN
          RETURN NEW;
        END IF;

        SELECT * INTO v_registry
          FROM plot_registries registry
         WHERE registry.id=OLD.registry_id
         FOR UPDATE;
        IF NOT FOUND
           OR v_registry.lifecycle_status NOT IN ('EXECUTED','COMPLETE')
           OR NOT rera_registry_site_is_controlled(v_registry.site_id) THEN
          IF TG_OP='DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;

        IF TG_OP='UPDATE' AND NEW.registry_id=OLD.registry_id
           AND NEW.source_plot_payment_id IS NOT NULL THEN
          v_replacement_eligible := rera_registry_source_receipt_is_eligible(
            OLD.registry_id,
            NEW.source_plot_payment_id
          );
        END IF;
        IF NOT v_replacement_eligible
           AND NOT rera_registry_has_eligible_receipt(
             OLD.registry_id,
             OLD.source_plot_payment_id
           ) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='An executed RERA registry must retain at least one canonical Project Payment receipt',
            CONSTRAINT='executed_rera_registry_canonical_receipt_retention';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_executed_rera_registry_receipt_mapping ON plot_registry_payments');
    await client.query(`
      CREATE TRIGGER trg_protect_executed_rera_registry_receipt_mapping
      BEFORE DELETE OR UPDATE OF registry_id,source_plot_payment_id
      ON plot_registry_payments
      FOR EACH ROW EXECUTE FUNCTION protect_executed_rera_registry_receipt_mapping()
    `);

    // Source receipts remain authoritative after linking. Status/cheque/reversal
    // changes therefore cannot silently invalidate the final executed receipt.
    await client.query(`
      CREATE OR REPLACE FUNCTION protect_executed_rera_registry_receipt_source()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_registry RECORD;
        v_new_eligible BOOLEAN;
        v_reversal_target BIGINT;
      BEGIN
        IF TG_OP IN ('UPDATE','DELETE') THEN
          FOR v_registry IN
            SELECT registry.id,registry.site_id,registry.plot_id,registry.booking_id
              FROM plot_registry_payments mapping
              JOIN plot_registries registry ON registry.id=mapping.registry_id
             WHERE mapping.source_plot_payment_id=OLD.id
               AND registry.lifecycle_status IN ('EXECUTED','COMPLETE')
               AND rera_registry_site_is_controlled(registry.site_id)
             FOR UPDATE OF registry
          LOOP
            v_new_eligible := FALSE;
            IF TG_OP='UPDATE' THEN
              SELECT NEW.amount>0
                 AND NEW.site_id=v_registry.site_id
                 AND NEW.plot_id=v_registry.plot_id
                 AND NEW.booking_id=v_registry.booking_id
                 AND LOWER(COALESCE(NEW.status,'approved'))='approved'
                 AND UPPER(COALESCE(NEW.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
                 AND NEW.reversal_of_payment_id IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM plot_payments reversal
                    WHERE reversal.reversal_of_payment_id=OLD.id
                      AND reversal.id<>OLD.id
                      AND LOWER(COALESCE(reversal.status,'approved'))='approved'
                      AND UPPER(COALESCE(reversal.cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
                 )
                INTO v_new_eligible;
            END IF;
            IF NOT COALESCE(v_new_eligible,FALSE)
               AND NOT rera_registry_has_eligible_receipt(v_registry.id,OLD.id) THEN
              RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='A Project Payment change would remove the final canonical receipt from an executed RERA registry',
                CONSTRAINT='executed_rera_registry_canonical_receipt_retention';
            END IF;
          END LOOP;
        END IF;

        IF TG_OP IN ('INSERT','UPDATE')
           AND NEW.reversal_of_payment_id IS NOT NULL
           AND LOWER(COALESCE(NEW.status,'approved'))='approved'
           AND UPPER(COALESCE(NEW.cheque_status,'')) NOT IN ('BOUNCED','RETURNED') THEN
          v_reversal_target := NEW.reversal_of_payment_id;
          FOR v_registry IN
            SELECT registry.id,registry.site_id
              FROM plot_registry_payments mapping
              JOIN plot_registries registry ON registry.id=mapping.registry_id
             WHERE mapping.source_plot_payment_id=v_reversal_target
               AND registry.lifecycle_status IN ('EXECUTED','COMPLETE')
               AND rera_registry_site_is_controlled(registry.site_id)
             FOR UPDATE OF registry
          LOOP
            IF NOT rera_registry_has_eligible_receipt(v_registry.id,v_reversal_target) THEN
              RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='An approved reversal cannot invalidate the final canonical receipt of an executed RERA registry',
                CONSTRAINT='executed_rera_registry_canonical_receipt_retention';
            END IF;
          END LOOP;
        END IF;

        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_executed_rera_registry_receipt_source_write ON plot_payments');
    await client.query('DROP TRIGGER IF EXISTS trg_protect_executed_rera_registry_receipt_source_delete ON plot_payments');
    await client.query(`
      CREATE TRIGGER trg_protect_executed_rera_registry_receipt_source_write
      BEFORE INSERT OR UPDATE OF amount,status,cheque_status,reversal_of_payment_id,booking_id,plot_id,site_id
      ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION protect_executed_rera_registry_receipt_source()
    `);
    await client.query(`
      CREATE TRIGGER trg_protect_executed_rera_registry_receipt_source_delete
      BEFORE DELETE ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION protect_executed_rera_registry_receipt_source()
    `);

    // Executed registry instruments and their agreement registration context
    // are legal records. No implicit reopen exists, so legal fields are frozen.
    await client.query(`
      CREATE OR REPLACE FUNCTION protect_executed_rera_registry_legal_metadata()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.lifecycle_status NOT IN ('EXECUTED','COMPLETE')
           OR NOT rera_registry_site_is_controlled(OLD.site_id) THEN
          IF TG_OP='DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;
        IF TG_OP='DELETE' THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='An executed RERA registry is an immutable retained legal record',
            CONSTRAINT='executed_rera_registry_legal_metadata_immutable';
        END IF;
        IF NEW.site_id IS DISTINCT FROM OLD.site_id
           OR NEW.plot_id IS DISTINCT FROM OLD.plot_id
           OR NEW.plot_no IS DISTINCT FROM OLD.plot_no
           OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
           OR NEW.allottee_member_id IS DISTINCT FROM OLD.allottee_member_id
           OR NEW.rera_project_id IS DISTINCT FROM OLD.rera_project_id
           OR NEW.rera_project_phase_id IS DISTINCT FROM OLD.rera_project_phase_id
           OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id
           OR NEW.customer_name IS DISTINCT FROM OLD.customer_name
           OR NEW.size_meter IS DISTINCT FROM OLD.size_meter
           OR NEW.size_sqyard IS DISTINCT FROM OLD.size_sqyard
           OR NEW.registry_date IS DISTINCT FROM OLD.registry_date
           OR NEW.farmer_name IS DISTINCT FROM OLD.farmer_name
           OR NEW.circle_rate IS DISTINCT FROM OLD.circle_rate
           OR NEW.firm_name IS DISTINCT FROM OLD.firm_name
           OR NEW.seller_name IS DISTINCT FROM OLD.seller_name
           OR NEW.created_entry_date IS DISTINCT FROM OLD.created_entry_date
           OR NEW.deed_number IS DISTINCT FROM OLD.deed_number
           OR NEW.registration_number IS DISTINCT FROM OLD.registration_number
           OR NEW.sub_registrar_office IS DISTINCT FROM OLD.sub_registrar_office
           OR NEW.registrar_district IS DISTINCT FROM OLD.registrar_district
           OR NEW.deed_execution_date IS DISTINCT FROM OLD.deed_execution_date
           OR NEW.registration_date IS DISTINCT FROM OLD.registration_date
           OR NEW.stamp_duty_amount IS DISTINCT FROM OLD.stamp_duty_amount
           OR NEW.registration_fee_amount IS DISTINCT FROM OLD.registration_fee_amount THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='Executed RERA registry legal metadata cannot change without a controlled reopen workflow',
            CONSTRAINT='executed_rera_registry_legal_metadata_immutable';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_executed_rera_registry_legal_metadata ON plot_registries');
    await client.query(`
      CREATE TRIGGER trg_protect_executed_rera_registry_legal_metadata
      BEFORE DELETE OR UPDATE OF site_id,plot_id,plot_no,booking_id,allottee_member_id,
        rera_project_id,rera_project_phase_id,agreement_id,customer_name,size_meter,size_sqyard,
        registry_date,farmer_name,circle_rate,firm_name,seller_name,created_entry_date,deed_number,
        registration_number,sub_registrar_office,registrar_district,deed_execution_date,
        registration_date,stamp_duty_amount,registration_fee_amount
      ON plot_registries
      FOR EACH ROW EXECUTE FUNCTION protect_executed_rera_registry_legal_metadata()
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION protect_executed_rera_registry_agreement()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='UPDATE'
           AND NEW.status IS NOT DISTINCT FROM OLD.status
           AND NEW.execution_date IS NOT DISTINCT FROM OLD.execution_date
           AND NEW.registration_status IS NOT DISTINCT FROM OLD.registration_status
           AND NEW.registration_number IS NOT DISTINCT FROM OLD.registration_number
           AND NEW.registration_date IS NOT DISTINCT FROM OLD.registration_date
           AND NEW.registration_office IS NOT DISTINCT FROM OLD.registration_office THEN
          RETURN NEW;
        END IF;
        IF EXISTS (
          SELECT 1
            FROM plot_registries registry
           WHERE registry.agreement_id=OLD.id
             AND registry.lifecycle_status IN ('EXECUTED','COMPLETE')
             AND rera_registry_site_is_controlled(registry.site_id)
        ) THEN
          RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='The executed/registered agreement linked to an executed RERA registry is immutable',
            CONSTRAINT='executed_rera_registry_agreement_immutable';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_protect_executed_rera_registry_agreement ON booking_agreements');
    await client.query(`
      CREATE TRIGGER trg_protect_executed_rera_registry_agreement
      BEFORE DELETE OR UPDATE OF status,execution_date,registration_status,
        registration_number,registration_date,registration_office
      ON booking_agreements
      FOR EACH ROW EXECUTE FUNCTION protect_executed_rera_registry_agreement()
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_rera_registry_amounts_from_mapping()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP IN ('UPDATE','DELETE') THEN
          PERFORM refresh_rera_registry_derived_amounts(OLD.registry_id);
        END IF;
        IF TG_OP IN ('INSERT','UPDATE')
           AND (TG_OP='INSERT' OR NEW.registry_id IS DISTINCT FROM OLD.registry_id) THEN
          PERFORM refresh_rera_registry_derived_amounts(NEW.registry_id);
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_sync_rera_registry_amounts_from_mapping ON plot_registry_payments');
    await client.query(`
      CREATE TRIGGER trg_sync_rera_registry_amounts_from_mapping
      AFTER INSERT OR DELETE OR UPDATE OF registry_id,source_plot_payment_id
      ON plot_registry_payments
      FOR EACH ROW EXECUTE FUNCTION sync_rera_registry_amounts_from_mapping()
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_rera_registry_amounts_from_receipt()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_receipt_ids BIGINT[] := ARRAY[]::BIGINT[];
        v_registry_id BIGINT;
      BEGIN
        IF TG_OP IN ('UPDATE','DELETE') THEN
          v_receipt_ids := array_append(v_receipt_ids,OLD.id);
          IF OLD.reversal_of_payment_id IS NOT NULL THEN
            v_receipt_ids := array_append(v_receipt_ids,OLD.reversal_of_payment_id);
          END IF;
        END IF;
        IF TG_OP IN ('INSERT','UPDATE') THEN
          v_receipt_ids := array_append(v_receipt_ids,NEW.id);
          IF NEW.reversal_of_payment_id IS NOT NULL THEN
            v_receipt_ids := array_append(v_receipt_ids,NEW.reversal_of_payment_id);
          END IF;
        END IF;
        FOR v_registry_id IN
          SELECT DISTINCT mapping.registry_id
            FROM plot_registry_payments mapping
           WHERE mapping.source_plot_payment_id=ANY(v_receipt_ids)
        LOOP
          PERFORM refresh_rera_registry_derived_amounts(v_registry_id);
        END LOOP;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_sync_rera_registry_amounts_from_receipt_write ON plot_payments');
    await client.query('DROP TRIGGER IF EXISTS trg_sync_rera_registry_amounts_from_receipt_delete ON plot_payments');
    await client.query(`
      CREATE TRIGGER trg_sync_rera_registry_amounts_from_receipt_write
      AFTER INSERT OR UPDATE OF amount,status,cheque_status,reversal_of_payment_id,
        booking_id,plot_id,site_id,payment_type
      ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION sync_rera_registry_amounts_from_receipt()
    `);
    await client.query(`
      CREATE TRIGGER trg_sync_rera_registry_amounts_from_receipt_delete
      AFTER DELETE ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION sync_rera_registry_amounts_from_receipt()
    `);

    await client.query(`
      SELECT refresh_rera_registry_derived_amounts(registry.id)
        FROM plot_registries registry
       WHERE rera_registry_site_is_controlled(registry.site_id)
    `);

    await client.query(
      'INSERT INTO public.app_schema_migrations(version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: RERA registry legal and receipt integrity');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 123_rera_registry_legal_integrity failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
