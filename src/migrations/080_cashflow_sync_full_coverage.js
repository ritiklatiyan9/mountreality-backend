import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 080 — restore full module coverage in sync_cashflow_from_modules().
 *
 * Migration 076 CREATE OR REPLACE'd the sync function to add the person-ledger
 * mirror, but its body was based on migration 030 rather than the then-current
 * 039/040/041 version. That silently dropped:
 *
 *  1. The plot_installment_payments case — its trigger still fires but falls
 *     through to `ELSE RETURN NEW`, so every installment payment created after
 *     076 never reaches cash_flow_entries and is missing from the Balance Sheet.
 *     Registry payments are intentionally NOT synced: they only map an already
 *     recorded plot payment to registry paperwork and have no ledger effect.
 *  2. Cheque handling — cash_type 'cheque', cheque_status/cheque_no sync, and
 *     zeroing of BOUNCED/RETURNED cheques. Bounced cheques were being counted
 *     again in Balance Sheet totals while Day Book correctly excluded them.
 *  3. Sane mode bucketing — 076 mapped only the literal 'BANK' to bank, so
 *     UPI/NEFT/RTGS/TRANSFER/CHEQUE rows all landed in the cash bucket,
 *     flipping the Cash vs Bank Day Book scopes.
 *
 * This migration re-issues the function with all 9 financial module cases +
 * cheque handling + 076's person-mirror block, re-creates the 9 triggers
 * idempotently, and forces a full resync so historical rows are corrected.
 */

const TABLES = [
  'farmer_payments', 'plot_commissions', 'plot_commission_payments', 'day_book',
  'firm_transactions', 'plot_payments', 'expenses', 'vendor_payments',
  'plot_installment_payments',
];

const MIGRATION_KEY = '080_cashflow_sync_full_coverage_v2';

// --dry-run: validate the function DDL against the live schema, then ROLLBACK.
// Never touches data or triggers.
const DRY_RUN = process.argv.includes('--dry-run');

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

    const marker = await client.query(
      'SELECT 1 FROM public.app_schema_migrations WHERE version = $1',
      [MIGRATION_KEY]
    );
    if (!DRY_RUN && marker.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    // Legacy plot_commissions used by_note (a free-form reference) as its
    // settlement mode. Keep the two concepts separate so a cheque/reference
    // edit cannot silently move money between Cash and Bank.
    await client.query(`
      ALTER TABLE plot_commissions
      ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(50)
    `);
    await client.query(`
      UPDATE plot_commissions pc
      SET payment_mode = COALESCE(
        (SELECT db.payment_mode FROM day_book db
         WHERE db.commission_id = pc.id
         ORDER BY db.id DESC LIMIT 1),
        NULLIF(TRIM(pc.by_note), '')
      )
      WHERE NULLIF(TRIM(COALESCE(pc.payment_mode, '')), '') IS NULL
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_cashflow_from_modules()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_site_id INTEGER;
        v_entry_date DATE;
        v_particular VARCHAR(500);
        v_debit NUMERIC(15,2) := 0;
        v_credit NUMERIC(15,2) := 0;
        v_cash_type VARCHAR(20) := 'bank';
        v_remarks TEXT;
        v_created_by INTEGER;
        v_month_id INTEGER;
        v_source_module VARCHAR(50);
        v_person_source_module VARCHAR(60);
        v_source_id INTEGER;
        v_assigned_admin_id INTEGER;
        v_voucher_url TEXT;
        v_status VARCHAR(20) := 'pending';
        v_approved_by INTEGER;
        v_approved_at TIMESTAMPTZ;
        v_cheque_status VARCHAR(20);
        v_cheque_no VARCHAR(50);
        v_mapped_member_id INTEGER;
        v_mapped_user_id INTEGER;
        v_person_month_id INTEGER;
        v_person_display_name VARCHAR(255);
      BEGIN
        v_source_module := TG_TABLE_NAME;
        v_person_source_module := TG_TABLE_NAME || '_person';

        IF TG_OP = 'DELETE' THEN
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_source_module AND cfe.source_id = OLD.id;
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_person_source_module AND cfe.source_id = OLD.id;
          RETURN OLD;
        END IF;

        v_source_id := NEW.id;

        -- Cheque columns exist on all synced tables (039); guard anyway so a
        -- schema drift never breaks the whole trigger.
        BEGIN
          v_cheque_status := NEW.cheque_status;
          v_cheque_no := NEW.cheque_no;
        EXCEPTION WHEN OTHERS THEN
          v_cheque_status := NULL;
          v_cheque_no := NULL;
        END;

        IF TG_TABLE_NAME = 'farmer_payments' THEN
          SELECT f.site_id, f.name INTO v_site_id, v_particular
          FROM farmers f WHERE f.id = NEW.farmer_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('FARMER PAYMENT - ' || COALESCE(v_particular, 'FARMER'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHEQUE%'
              OR UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHQ%' THEN 'cheque'
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) ~ '^CASH([[:space:]_-]|$)' THEN 'cash'
            ELSE 'bank'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NULL;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        ELSIF TG_TABLE_NAME = 'plot_commissions' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT COMMISSION - ' || COALESCE(NEW.particular, 'COMMISSION'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHEQUE%'
              OR UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHQ%' THEN 'cheque'
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) ~ '^CASH([[:space:]_-]|$)' THEN 'cash'
            ELSE 'bank'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NULL;
          v_mapped_user_id := NULL;

        ELSIF TG_TABLE_NAME = 'plot_commission_payments' THEN
          SELECT COALESCE(m.full_name, 'AGENT') INTO v_particular
          FROM plot_commissions_v2 pcm
          LEFT JOIN members m ON m.id = pcm.agent_id
          WHERE pcm.id = NEW.plot_commission_id;
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT COMMISSION PAYMENT - ' || COALESCE(v_particular, 'AGENT'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHEQUE%'
              OR UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHQ%' THEN 'cheque'
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) ~ '^CASH([[:space:]_-]|$)' THEN 'cash'
            ELSE 'bank'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        ELSIF TG_TABLE_NAME = 'day_book' THEN
          -- Specialized types dual-write into their own module tables, whose
          -- triggers sync them — syncing the day_book copy would double count.
          IF UPPER(COALESCE(NEW.entry_type, 'GENERAL')) IN ('CASH FLOW', 'FARMER PAYMENT', 'PLOT COMMISSION', 'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT') THEN
            DELETE FROM cash_flow_entries cfe
            WHERE cfe.source_module = v_source_module AND cfe.source_id = v_source_id;
            DELETE FROM cash_flow_entries cfe
            WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;
            RETURN NEW;
          END IF;
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.particular, 'DAY BOOK ENTRY');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHEQUE%'
              OR UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHQ%' THEN 'cheque'
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) ~ '^CASH([[:space:]_-]|$)' THEN 'cash'
            ELSE 'bank'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        ELSIF TG_TABLE_NAME = 'firm_transactions' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.description, 'FIRM TRANSACTION');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHEQUE%'
              OR UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHQ%' THEN 'cheque'
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) ~ '^CASH([[:space:]_-]|$)' THEN 'cash'
            ELSE 'bank'
          END;
          v_remarks := NEW.remark;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'approved');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        ELSIF TG_TABLE_NAME = 'plot_payments' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT PAYMENT - ' || COALESCE(NEW.buyer_name, NEW.payment_from, 'PLOT'))::VARCHAR(500);
          v_debit := 0;
          v_credit := COALESCE(NEW.amount, 0);
          v_cash_type := CASE
            WHEN UPPER(TRIM(COALESCE(NEW.payment_type, ''))) LIKE '%CHEQUE%'
              OR UPPER(TRIM(COALESCE(NEW.payment_type, ''))) LIKE '%CHQ%' THEN 'cheque'
            WHEN UPPER(TRIM(COALESCE(NEW.payment_type, ''))) ~ '^CASH([[:space:]_-]|$)' THEN 'cash'
            ELSE 'bank'
          END;
          v_remarks := NEW.narration;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        ELSIF TG_TABLE_NAME = 'expenses' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.remark, 'EXPENSE ENTRY');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHEQUE%'
              OR UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHQ%' THEN 'cheque'
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) ~ '^CASH([[:space:]_-]|$)' THEN 'cash'
            ELSE 'bank'
          END;
          v_remarks := CONCAT_WS(' | ', NEW.from_entity, NEW.to_entity, NEW.category);
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        ELSIF TG_TABLE_NAME = 'vendor_payments' THEN
          SELECT COALESCE(vc.vendor_name, 'VENDOR') INTO v_particular
          FROM vendor_commitments vc WHERE vc.id = NEW.commitment_id;
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.payment_date, CURRENT_DATE);
          v_particular := ('VENDOR PAYMENT - ' || COALESCE(v_particular, 'VENDOR'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHEQUE%'
              OR UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHQ%' THEN 'cheque'
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) ~ '^CASH([[:space:]_-]|$)' THEN 'cash'
            ELSE 'bank'
          END;
          v_remarks := NEW.note;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        -- ── Restored from migration 039 (dropped by 076) ──
        ELSIF TG_TABLE_NAME = 'plot_installment_payments' THEN
          SELECT p.plot_no, p.buyer_name, p.site_id INTO v_particular, v_remarks, v_site_id
          FROM plots p WHERE p.id = NEW.plot_id;
          v_entry_date := COALESCE(NEW.payment_date, CURRENT_DATE);
          v_particular := ('INST. PAYMENT - ' || COALESCE(v_particular, 'PLOT') || ' (' || COALESCE(v_remarks, 'BUYER') || ')')::VARCHAR(500);
          v_debit := 0;
          v_credit := COALESCE(NEW.amount, 0);
          v_cash_type := CASE
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHEQUE%'
              OR UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) LIKE '%CHQ%' THEN 'cheque'
            WHEN UPPER(TRIM(COALESCE(NEW.payment_mode, ''))) ~ '^CASH([[:space:]_-]|$)' THEN 'cash'
            ELSE 'bank'
          END;
          v_remarks := NEW.notes;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NULL;
          v_voucher_url := NULL;
          v_status := 'approved';
          v_approved_by := NULL;
          v_approved_at := NULL;
          v_mapped_member_id := NULL;
          v_mapped_user_id := NULL;

        ELSE
          RETURN NEW;
        END IF;

        -- Bounced/returned cheque: keep the row (visible with its status) but
        -- zero the amounts so no aggregate counts it.
        IF v_cheque_status IS NOT NULL AND UPPER(v_cheque_status) IN ('BOUNCED', 'RETURNED') THEN
          v_debit := 0;
          v_credit := 0;
        END IF;

        IF v_site_id IS NULL OR (COALESCE(v_debit, 0) = 0 AND COALESCE(v_credit, 0) = 0 AND v_cheque_status IS NULL) THEN
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_source_module AND cfe.source_id = v_source_id;
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;
          RETURN NEW;
        END IF;

        v_month_id := ensure_site_cashflow_month(v_site_id, v_entry_date, v_created_by);

        INSERT INTO cash_flow_entries (
          cash_flow_month_id, site_id, date, particular, debit, credit, cash_type, remarks,
          created_by, assigned_admin_id, source_module, source_id, voucher_url,
          status, approved_by, approved_at, cheque_status, cheque_no
        ) VALUES (
          v_month_id, v_site_id, v_entry_date, v_particular, v_debit, v_credit, v_cash_type, v_remarks,
          v_created_by, v_assigned_admin_id, v_source_module, v_source_id, v_voucher_url,
          v_status, v_approved_by, v_approved_at, v_cheque_status, v_cheque_no
        )
        ON CONFLICT (source_module, source_id)
        DO UPDATE SET
          cash_flow_month_id = EXCLUDED.cash_flow_month_id,
          site_id = EXCLUDED.site_id,
          date = EXCLUDED.date,
          particular = EXCLUDED.particular,
          debit = EXCLUDED.debit,
          credit = EXCLUDED.credit,
          cash_type = EXCLUDED.cash_type,
          remarks = EXCLUDED.remarks,
          created_by = EXCLUDED.created_by,
          assigned_admin_id = EXCLUDED.assigned_admin_id,
          voucher_url = EXCLUDED.voucher_url,
          status = EXCLUDED.status,
          approved_by = EXCLUDED.approved_by,
          approved_at = EXCLUDED.approved_at,
          cheque_status = EXCLUDED.cheque_status,
          cheque_no = EXCLUDED.cheque_no,
          updated_at = NOW();

        -- ── person-ledger mirror (migration 076) ──
        IF v_mapped_member_id IS NOT NULL OR v_mapped_user_id IS NOT NULL THEN
          IF v_mapped_member_id IS NOT NULL THEN
            SELECT full_name INTO v_person_display_name FROM members WHERE id = v_mapped_member_id;
          ELSE
            SELECT COALESCE(name, email) INTO v_person_display_name FROM users WHERE id = v_mapped_user_id;
          END IF;

          v_person_month_id := ensure_person_cashflow_month(
            v_site_id, v_entry_date, v_mapped_member_id, v_mapped_user_id, v_person_display_name, v_created_by
          );

          INSERT INTO cash_flow_entries (
            cash_flow_month_id, site_id, date, particular, debit, credit, cash_type, remarks,
            created_by, assigned_admin_id, source_module, source_id, voucher_url,
            status, approved_by, approved_at, cheque_status, cheque_no
          ) VALUES (
            v_person_month_id, v_site_id, v_entry_date, v_particular, v_debit, v_credit, v_cash_type, v_remarks,
            v_created_by, v_assigned_admin_id, v_person_source_module, v_source_id, v_voucher_url,
            v_status, v_approved_by, v_approved_at, v_cheque_status, v_cheque_no
          )
          ON CONFLICT (source_module, source_id)
          DO UPDATE SET
            cash_flow_month_id = EXCLUDED.cash_flow_month_id,
            site_id = EXCLUDED.site_id,
            date = EXCLUDED.date,
            particular = EXCLUDED.particular,
            debit = EXCLUDED.debit,
            credit = EXCLUDED.credit,
            cash_type = EXCLUDED.cash_type,
            remarks = EXCLUDED.remarks,
            created_by = EXCLUDED.created_by,
            assigned_admin_id = EXCLUDED.assigned_admin_id,
            voucher_url = EXCLUDED.voucher_url,
            status = EXCLUDED.status,
            approved_by = EXCLUDED.approved_by,
            approved_at = EXCLUDED.approved_at,
            cheque_status = EXCLUDED.cheque_status,
            cheque_no = EXCLUDED.cheque_no,
            updated_at = NOW();
        ELSE
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;
        END IF;

        RETURN NEW;
      END;
      $$
    `);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('Migration 080 dry-run OK — function DDL compiles against live schema (rolled back)');
      return;
    }

    // Registry payments are accounting-neutral mappings of money already
    // recorded by plot_payments. Remove the legacy trigger and any stale mirror
    // rows before rebuilding financial-module triggers.
    await client.query(
      'DROP TRIGGER IF EXISTS trg_sync_cfe_plot_registry_payments ON public.plot_registry_payments'
    );
    await client.query(`
      DELETE FROM cash_flow_entries
      WHERE source_module IN ('plot_registry_payments', 'plot_registry_payments_person')
    `);

    for (const table of TABLES) {
      await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_${table} ON ${table}`);
      await client.query(`
        CREATE TRIGGER trg_sync_cfe_${table}
        AFTER INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules();
      `);
    }

    // Full resync — corrects cash_type/cheque drift accumulated since 076 and
    // backfills installment payments that never synced.
    for (const table of TABLES) {
      await client.query(`UPDATE ${table} SET id = id`);
    }

    await client.query(
      `INSERT INTO public.app_schema_migrations (version)
       VALUES ($1)
       ON CONFLICT (version) DO NOTHING`,
      [MIGRATION_KEY]
    );

    await client.query('COMMIT');
    console.log('Migration 080_cashflow_sync_full_coverage complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 080_cashflow_sync_full_coverage failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
