import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 081 — one payment-mode classifier for every module.
 *
 * sync_cashflow_from_modules() carried NINE inline `v_cash_type := CASE` blocks,
 * in THREE mutually inconsistent shapes:
 *
 *   A  IN ('CHEQUE','CHQ') -> cheque / = 'CASH' -> cash / ELSE bank
 *      (plot_commission_payments, day_book, firm_transactions, plot_payments,
 *       vendor_payments, plot_installment_payments)
 *   A' same, plus LIKE 'CASH %' -> cash          (farmer_payments)
 *   B  LIKE '%CHEQUE%' -> cheque / LIKE '%BANK%' or IN (UPI,NEFT,RTGS,IMPS,
 *      TRANSFER,ONLINE) -> bank / ELSE cash      (plot_commissions, expenses)
 *
 * So the SAME raw string landed in DIFFERENT books depending only on which
 * module wrote it. Two concrete divergences this caused:
 *
 *   'CASH IN HAND'  -> shape A says BANK (it is not literally 'CASH'),
 *                      shapes A'/B say cash. Seven modules booked physical
 *                      cash as bank.
 *   '' / 'Other' /  -> shape A says bank, shape B says cash.
 *   any typo           Unlabelled entries split across two books at random.
 *
 * This is the same class of bug as 076 (which reduced bucketing to literal
 * 'BANK' only) and 080 (which restored it per-module but left the three shapes
 * in place). Inlining the rule nine times is what makes it keep coming back, so
 * it now lives in exactly one function: ledger_bucket().
 *
 * POLICY, agreed with the owner 2026-07-21:
 *
 *   There are two accounting books: Cash and Bank. Cheque remains a detail
 *   bucket but is part of the Bank book. Only an explicit CASH-prefixed value
 *   is physical cash; every other value, including blank/unrecognised modes,
 *   belongs to Bank. Therefore Cash + Bank exhaustively partitions the ledger.
 *
 * Registry-payment rows are mapping records only. Their sync trigger and any
 * historical cash_flow_entries mirrors are removed transactionally.
 */

const TABLES = [
  'farmer_payments', 'plot_commissions', 'plot_commission_payments', 'day_book',
  'firm_transactions', 'plot_payments', 'expenses', 'vendor_payments',
  'plot_installment_payments',
];

const MIGRATION_KEY = '081_unified_ledger_bucket_v3';

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
    if (marker.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    const coverageMarker = await client.query(
      'SELECT 1 FROM public.app_schema_migrations WHERE version = $1',
      ['080_cashflow_sync_full_coverage_v2']
    );

    // Cheque is retained as a detail bucket. A clear CASH prefix identifies
    // physical cash; the exhaustive fallback is Bank, so blank and unfamiliar
    // source values cannot disappear from either accounting book.
    await client.query(`
      CREATE OR REPLACE FUNCTION ledger_bucket(raw TEXT)
      RETURNS VARCHAR(20)
      LANGUAGE sql
      IMMUTABLE
      AS $fn$
        SELECT CASE
          WHEN u LIKE '%CHEQUE%' OR u LIKE '%CHQ%' THEN 'cheque'
          WHEN u ~ '^CASH([[:space:]_-]|$)' THEN 'cash'
          ELSE 'bank'
        END::VARCHAR(20)
        FROM (SELECT UPPER(TRIM(COALESCE(raw, ''))) AS u) s
      $fn$;
    `);

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

    // Same body as 080, with all nine CASE blocks replaced by ledger_bucket().
    // Nothing else in the function changed.
    await client.query(`
CREATE OR REPLACE FUNCTION public.sync_cashflow_from_modules()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
          v_cash_type := ledger_bucket(NEW.payment_mode);
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
          v_cash_type := ledger_bucket(NEW.payment_mode);
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
          v_cash_type := ledger_bucket(NEW.payment_mode);
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
          v_cash_type := ledger_bucket(NEW.payment_mode);
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
          v_cash_type := ledger_bucket(NEW.payment_mode);
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
          v_cash_type := ledger_bucket(NEW.payment_type);
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
          v_cash_type := ledger_bucket(NEW.payment_mode);
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
          v_cash_type := ledger_bucket(NEW.payment_mode);
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
          v_cash_type := ledger_bucket(NEW.payment_mode);
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
      $function$;
    `);

    // 081 owns this cleanup too: it must be safe to deploy even when 080 was
    // skipped. Registry rows map already-recorded plot money and never create a
    // second incoming/outgoing ledger movement.
    await client.query(
      'DROP TRIGGER IF EXISTS trg_sync_cfe_plot_registry_payments ON public.plot_registry_payments'
    );
    await client.query(`
      DELETE FROM cash_flow_entries
      WHERE source_module IN ('plot_registry_payments', 'plot_registry_payments_person')
    `);

    // Make this migration independently deployable. If 080 was not run first,
    // recreate the nine financial triggers before the fallback backfill.
    for (const table of TABLES) {
      await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_${table} ON ${table}`);
      await client.query(`
        CREATE TRIGGER trg_sync_cfe_${table}
        AFTER INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules();
      `);
    }

    // v3 separates the legacy commission reference (by_note) from its actual
    // settlement mode. Re-sync this one source after installing the v3 trigger
    // even when 080_v2 already performed the general backfill.
    await client.query('UPDATE plot_commissions SET id = id');

    const before = await client.query(
      `SELECT COALESCE(cash_type,'<null>') AS bucket, COUNT(*)::int AS rows,
              COALESCE(SUM(debit),0) AS debit, COALESCE(SUM(credit),0) AS credit
         FROM cash_flow_entries GROUP BY 1 ORDER BY 1`
    );

    // 080_v2 already performs a full source backfill using this exact policy.
    // Avoid locking/re-writing all source tables a second time during normal
    // startup. When 081 is run standalone, retain the one necessary backfill.
    if (coverageMarker.rowCount === 0) {
      for (const table of TABLES) {
        await client.query(`UPDATE ${table} SET id = id`);
      }
    } else {
      console.log('080_v2 source backfill already complete — skipping duplicate general resync');
    }

    const after = await client.query(
      `SELECT COALESCE(cash_type,'<null>') AS bucket, COUNT(*)::int AS rows,
              COALESCE(SUM(debit),0) AS debit, COALESCE(SUM(credit),0) AS credit
         FROM cash_flow_entries GROUP BY 1 ORDER BY 1`
    );

    // Print how much money moved between books, so a resync on live data is
    // never silent.
    console.log('\ncash_type distribution before -> after:');
    console.table(before.rows);
    console.table(after.rows);

    await client.query(
      `INSERT INTO public.app_schema_migrations (version)
       VALUES ($1)
       ON CONFLICT (version) DO NOTHING`,
      [MIGRATION_KEY]
    );

    await client.query('COMMIT');
    console.log('Migration 081_unified_ledger_bucket complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 081_unified_ledger_bucket failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
