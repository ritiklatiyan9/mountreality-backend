import pool from '../config/db.js';

/**
 * Migration 033: Fix CHEQUE → bank mapping in sync_cashflow_from_modules()
 *
 * Bugs fixed:
 * 1. plot_payments: CHEQUE was mapped to 'cash' instead of 'bank'
 * 2. plot_commissions: CHEQUE in by_note was not mapped to 'bank'
 *
 * Also re-syncs existing CHEQUE entries in cash_flow_entries.
 */
export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Recreate trigger function with fixed CHEQUE mapping ──
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
        v_cash_type VARCHAR(20) := 'cash';
        v_remarks TEXT;
        v_created_by INTEGER;
        v_month_id INTEGER;
        v_source_module VARCHAR(50);
        v_source_id INTEGER;
        v_assigned_admin_id INTEGER;
        v_voucher_url TEXT;
        v_status VARCHAR(20) := 'pending';
        v_approved_by INTEGER;
        v_approved_at TIMESTAMPTZ;
        v_cheque_status VARCHAR(20);
        v_cheque_no VARCHAR(50);
      BEGIN
        v_source_module := TG_TABLE_NAME;

        IF TG_OP = 'DELETE' THEN
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_source_module
            AND cfe.source_id = OLD.id;
          RETURN OLD;
        END IF;

        v_source_id := NEW.id;
        v_cheque_status := NEW.cheque_status;
        v_cheque_no := NEW.cheque_no;

        IF TG_TABLE_NAME = 'farmer_payments' THEN
          SELECT f.site_id, f.name INTO v_site_id, v_particular
          FROM farmers f
          WHERE f.id = NEW.farmer_id;

          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('FARMER PAYMENT - ' || COALESCE(v_particular, 'FARMER'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) IN ('BANK', 'CHEQUE') THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NULL;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'plot_commissions' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT COMMISSION - ' || COALESCE(NEW.particular, 'COMMISSION'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.by_note, 'CASH')) LIKE '%BANK%' THEN 'bank'
            WHEN UPPER(COALESCE(NEW.by_note, 'CASH')) LIKE '%CHEQUE%' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

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
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) IN ('BANK', 'CHEQUE') THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'day_book' THEN
          IF UPPER(COALESCE(NEW.entry_type, 'GENERAL')) IN ('CASH FLOW', 'FARMER PAYMENT', 'PLOT COMMISSION', 'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT') THEN
            DELETE FROM cash_flow_entries cfe
            WHERE cfe.source_module = v_source_module
              AND cfe.source_id = v_source_id;
            RETURN NEW;
          END IF;

          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.particular, 'DAY BOOK ENTRY');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) IN ('BANK', 'CHEQUE') THEN 'bank'
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) LIKE '%BANK%' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'firm_transactions' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.description, 'FIRM TRANSACTION');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE
            WHEN LOWER(COALESCE(NEW.payment_mode, 'cash')) IN ('bank', 'cheque') THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remark;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'plot_payments' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT PAYMENT - ' || COALESCE(NEW.payment_from, 'PLOT'))::VARCHAR(500);
          v_debit := 0;
          v_credit := COALESCE(NEW.amount, 0);
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_type, 'CASH')) IN ('BANK', 'CHEQUE') THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.narration;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'expenses' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.remark, 'EXPENSE ENTRY');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) IN ('BANK', 'CHEQUE') THEN 'bank'
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) LIKE '%BANK%' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := CONCAT_WS(' | ', NEW.from_entity, NEW.to_entity, NEW.category);
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'vendor_payments' THEN
          SELECT COALESCE(vc.vendor_name, 'VENDOR') INTO v_particular
          FROM vendor_commitments vc
          WHERE vc.id = NEW.commitment_id;

          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.payment_date, CURRENT_DATE);
          v_particular := ('VENDOR PAYMENT - ' || COALESCE(v_particular, 'VENDOR'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN LOWER(COALESCE(NEW.payment_mode, 'cash')) IN ('bank', 'cheque') THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.note;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
        ELSE
          RETURN NEW;
        END IF;

        -- If cheque is bounced/returned, nullify the amounts
        IF v_cheque_status IS NOT NULL AND UPPER(v_cheque_status) IN ('BOUNCED', 'RETURNED') THEN
          v_debit := 0;
          v_credit := 0;
        END IF;

        IF v_site_id IS NULL THEN
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_source_module
            AND cfe.source_id = v_source_id;
          RETURN NEW;
        END IF;

        -- If both debit and credit are 0 (e.g. bounced cheque), still keep entry but with 0 amounts
        v_month_id := ensure_site_cashflow_month(v_site_id, v_entry_date, v_created_by);

        INSERT INTO cash_flow_entries (
          cash_flow_month_id,
          site_id,
          date,
          particular,
          debit,
          credit,
          cash_type,
          remarks,
          created_by,
          assigned_admin_id,
          source_module,
          source_id,
          voucher_url,
          status,
          approved_by,
          approved_at,
          cheque_status,
          cheque_no
        ) VALUES (
          v_month_id,
          v_site_id,
          v_entry_date,
          v_particular,
          v_debit,
          v_credit,
          v_cash_type,
          v_remarks,
          v_created_by,
          v_assigned_admin_id,
          v_source_module,
          v_source_id,
          v_voucher_url,
          v_status,
          v_approved_by,
          v_approved_at,
          v_cheque_status,
          v_cheque_no
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

        RETURN NEW;
      END;
      $$
    `);

    console.log('  ✓ Trigger function updated: CHEQUE now maps to bank for plot_payments and plot_commissions');

    // ── 2. Re-sync existing CHEQUE plot_payments in cash_flow_entries ──
    const fixPlotPayments = await client.query(`
      UPDATE cash_flow_entries
      SET cash_type = 'bank'
      WHERE source_module = 'plot_payments'
        AND cash_type = 'cash'
        AND source_id IN (
          SELECT id FROM plot_payments WHERE UPPER(payment_type) = 'CHEQUE'
        )
    `);
    if (fixPlotPayments.rowCount > 0) {
      console.log(`  ✓ Fixed ${fixPlotPayments.rowCount} plot_payments CHEQUE entries: cash → bank`);
    }

    // ── 3. Re-sync existing CHEQUE plot_commissions in cash_flow_entries ──
    const fixPlotCommissions = await client.query(`
      UPDATE cash_flow_entries
      SET cash_type = 'bank'
      WHERE source_module = 'plot_commissions'
        AND cash_type = 'cash'
        AND source_id IN (
          SELECT id FROM plot_commissions WHERE UPPER(by_note) LIKE '%CHEQUE%'
        )
    `);
    if (fixPlotCommissions.rowCount > 0) {
      console.log(`  ✓ Fixed ${fixPlotCommissions.rowCount} plot_commissions CHEQUE entries: cash → bank`);
    }

    await client.query('COMMIT');
    console.log('Migration 033 complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 033 failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

export const down = async () => {
  console.log('No revert needed for migration 033 — trigger function is always latest');
};
