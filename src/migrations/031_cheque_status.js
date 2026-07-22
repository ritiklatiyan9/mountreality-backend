import pool from '../config/db.js';

/**
 * Migration: Add cheque_status to all payment tables
 * - cheque_status: 'pending' | 'cleared' | 'bounced' | 'returned'
 * - When cheque_status is 'bounced' or 'returned', amounts are nullified (set to 0 in cashflow)
 * - Also updates CHECK constraints to allow 'cheque' payment_mode where missing
 */
export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Add cheque_status + cheque_no to all payment tables ──

    // farmer_payments
    await client.query(`ALTER TABLE farmer_payments ADD COLUMN IF NOT EXISTS cheque_status VARCHAR(20) DEFAULT NULL`);
    await client.query(`ALTER TABLE farmer_payments ADD COLUMN IF NOT EXISTS cheque_no VARCHAR(50) DEFAULT NULL`);

    // plot_commission_payments
    await client.query(`ALTER TABLE plot_commission_payments ADD COLUMN IF NOT EXISTS cheque_status VARCHAR(20) DEFAULT NULL`);
    await client.query(`ALTER TABLE plot_commission_payments ADD COLUMN IF NOT EXISTS cheque_no VARCHAR(50) DEFAULT NULL`);

    // firm_transactions (already has cheque_no)
    await client.query(`ALTER TABLE firm_transactions ADD COLUMN IF NOT EXISTS cheque_status VARCHAR(20) DEFAULT NULL`);
    // Update CHECK constraint to allow 'cheque'
    await client.query(`ALTER TABLE firm_transactions DROP CONSTRAINT IF EXISTS firm_transactions_payment_mode_check`);
    await client.query(`ALTER TABLE firm_transactions ADD CONSTRAINT firm_transactions_payment_mode_check CHECK (payment_mode IN ('cash', 'bank', 'cheque'))`);

    // vendor_payments (already has 'cheque' in CHECK)
    await client.query(`ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS cheque_status VARCHAR(20) DEFAULT NULL`);
    await client.query(`ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS cheque_no VARCHAR(50) DEFAULT NULL`);

    // plot_payments
    await client.query(`ALTER TABLE plot_payments ADD COLUMN IF NOT EXISTS cheque_status VARCHAR(20) DEFAULT NULL`);
    await client.query(`ALTER TABLE plot_payments ADD COLUMN IF NOT EXISTS cheque_no VARCHAR(50) DEFAULT NULL`);

    // expenses
    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS cheque_status VARCHAR(20) DEFAULT NULL`);
    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS cheque_no VARCHAR(50) DEFAULT NULL`);

    // plot_registry_payments
    await client.query(`ALTER TABLE plot_registry_payments ADD COLUMN IF NOT EXISTS cheque_status VARCHAR(20) DEFAULT NULL`);
    await client.query(`ALTER TABLE plot_registry_payments ADD COLUMN IF NOT EXISTS cheque_no VARCHAR(50) DEFAULT NULL`);

    // cash_flow_entries
    await client.query(`ALTER TABLE cash_flow_entries ADD COLUMN IF NOT EXISTS cheque_status VARCHAR(20) DEFAULT NULL`);
    await client.query(`ALTER TABLE cash_flow_entries ADD COLUMN IF NOT EXISTS cheque_no VARCHAR(50) DEFAULT NULL`);
    // Update cash_type CHECK to allow 'cheque'
    await client.query(`ALTER TABLE cash_flow_entries DROP CONSTRAINT IF EXISTS cash_flow_entries_cash_type_check`);
    await client.query(`ALTER TABLE cash_flow_entries ADD CONSTRAINT cash_flow_entries_cash_type_check CHECK (cash_type IN ('cash', 'bank', 'cheque'))`);

    // day_book
    await client.query(`ALTER TABLE day_book ADD COLUMN IF NOT EXISTS cheque_status VARCHAR(20) DEFAULT NULL`);
    await client.query(`ALTER TABLE day_book ADD COLUMN IF NOT EXISTS cheque_no VARCHAR(50) DEFAULT NULL`);

    // ── 2. Update the sync trigger to handle cheque ──
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
            WHEN UPPER(COALESCE(NEW.payment_type, 'CASH')) = 'BANK' THEN 'bank'
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

    await client.query('COMMIT');
    console.log('Migration 031: cheque_status columns and updated trigger applied successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 031 failed:', err);
    throw err;
  } finally {
    client.release();
  }
};
