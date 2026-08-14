import pool from '../config/db.js';

const MIGRATION_KEY = '116_finance_payment_mode_policy_v1';

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
      ALTER TABLE site_operating_profile_revisions
        ADD COLUMN IF NOT EXISTS finance_payment_mode VARCHAR(20) NOT NULL DEFAULT 'ALL_MODES'
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'site_operating_profile_finance_mode_chk'
            AND conrelid = 'site_operating_profile_revisions'::regclass
        ) THEN
          ALTER TABLE site_operating_profile_revisions
            ADD CONSTRAINT site_operating_profile_finance_mode_chk
            CHECK (finance_payment_mode IN ('ALL_MODES', 'BANK_ONLY'));
        END IF;
      END;
      $$
    `);
    await client.query(`
      COMMENT ON COLUMN site_operating_profile_revisions.finance_payment_mode IS
        'Published payment-entry policy. BANK_ONLY disallows new Cash entries while retaining historical records.'
    `);

    // Final database guards protect against stale clients and future endpoints.
    // Published-profile reads use the existing idx_site_profiles_tenant_status
    // index; indexing this two-value column separately would only add write cost.
    // Unchanged historical Cash rows remain editable; only new Cash selection is blocked.
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_site_finance_payment_mode()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        target_site_id INTEGER;
        effective_mode VARCHAR(20);
      BEGIN
        IF TG_TABLE_NAME = 'plot_payments' THEN
          target_site_id := NEW.site_id;
          IF TG_OP = 'UPDATE' AND NEW.payment_type IS NOT DISTINCT FROM OLD.payment_type THEN
            RETURN NEW;
          END IF;
          IF UPPER(COALESCE(NEW.payment_type, '')) <> 'CASH' THEN
            RETURN NEW;
          END IF;
        ELSIF TG_TABLE_NAME = 'booking_refunds' THEN
          IF TG_OP = 'UPDATE' AND NEW.payment_mode IS NOT DISTINCT FROM OLD.payment_mode THEN
            RETURN NEW;
          END IF;
          IF UPPER(COALESCE(NEW.payment_mode, '')) <> 'CASH' THEN
            RETURN NEW;
          END IF;
          SELECT cancellation.site_id
            INTO target_site_id
            FROM booking_cancellations cancellation
           WHERE cancellation.id = NEW.cancellation_id;
        ELSE
          RETURN NEW;
        END IF;

        SELECT profile.finance_payment_mode
          INTO effective_mode
          FROM site_operating_profile_revisions profile
         WHERE profile.site_id = target_site_id
           AND profile.lifecycle_status = 'PUBLISHED'
           AND profile.effective_to IS NULL
           AND profile.deleted_at IS NULL
         ORDER BY profile.revision_number DESC, profile.id DESC
         LIMIT 1;

        IF COALESCE(effective_mode, 'ALL_MODES') = 'BANK_ONLY' THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Cash is disabled by this Site''s published finance profile. Select a bank payment mode.',
            CONSTRAINT = 'site_finance_payment_mode_bank_only';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_plot_payments_finance_mode ON plot_payments');
    await client.query(`
      CREATE TRIGGER trg_plot_payments_finance_mode
      BEFORE INSERT OR UPDATE OF payment_type ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION enforce_site_finance_payment_mode()
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_booking_refunds_finance_mode ON booking_refunds');
    await client.query(`
      CREATE TRIGGER trg_booking_refunds_finance_mode
      BEFORE INSERT OR UPDATE OF payment_mode ON booking_refunds
      FOR EACH ROW EXECUTE FUNCTION enforce_site_finance_payment_mode()
    `);

    await client.query(
      'INSERT INTO public.app_schema_migrations (version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: published finance payment-mode policy');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 116_finance_payment_mode_policy failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
