import pool from '../config/db.js';

/**
 * Migration 041: Fix double-counting of farmer payments (and other module types) in cash_flow_entries
 *
 * Root Cause:
 *   When a day_book entry is created with entry_type='FARMER PAYMENT', the trigger
 *   `sync_cashflow_from_modules` should skip creating a cash_flow_entry because the
 *   farmer_payments table already created its own CFE via its own trigger.
 *
 *   Migration 040 accidentally added an extra condition:
 *     AND (cash_flow_entry_id IS NOT NULL OR firm_transaction_id IS NOT NULL OR plot_payment_id IS NOT NULL)
 *   This only covered CASH FLOW / FIRM TRANSACTION / PLOT PAYMENT types.
 *   FARMER PAYMENT entries use `farmer_payment_id`; PLOT COMMISSION use `commission_id`;
 *   VENDOR PAYMENT use `vendor_payment_id` — none checked by the old condition.
 *   Result: day_book CFEs were created alongside farmer_payments CFEs → double counting.
 *
 * Fix:
 *   1. Update trigger function to check all relevant linked-ID columns.
 *   2. Delete existing duplicate day_book CFEs for linked entries.
 */
export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Fix the trigger function ──
    // Read the full current body from the migration 040 version and patch the day_book section.
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

        -- Safe assignments from NEW (only if columns exist in the table)
        IF TG_TABLE_NAME IN ('farmer_payments', 'plot_commission_payments', 'firm_transactions', 'vendor_payments', 'plot_payments', 'expenses', 'plot_registry_payments', 'day_book', 'plot_commissions', 'plot_installment_payments') THEN
          BEGIN
            v_cheque_status := NEW.cheque_status;
            v_cheque_no := NEW.cheque_no;
          EXCEPTION WHEN OTHERS THEN
            v_cheque_status := NULL;
            v_cheque_no := NULL;
          END;
        END IF;

        -- ── CASE: farmer_payments ──
        IF TG_TABLE_NAME = 'farmer_payments' THEN
          SELECT f.site_id, f.name INTO v_site_id, v_particular FROM farmers f WHERE f.id = NEW.farmer_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('FARMER PAYMENT - ' || COALESCE(v_particular, 'FARMER'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_cash_type := CASE 
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CASH'   THEN 'cash' 
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CHEQUE' THEN 'cheque'
            ELSE 'bank' 
          END;
          v_status := COALESCE(NEW.status, 'pending');
          v_remarks := NEW.remarks;
          v_assigned_admin_id := NEW.assigned_admin_id;

        -- ── CASE: plot_commissions ──
        ELSIF TG_TABLE_NAME = 'plot_commissions' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT COMMISSION - ' || COALESCE(NEW.particular, 'COMMISSION'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_cash_type := CASE 
            WHEN UPPER(COALESCE(NEW.by_note, 'CASH')) LIKE '%CHEQUE%' THEN 'cheque'
            WHEN UPPER(COALESCE(NEW.by_note, 'CASH')) LIKE '%BANK%'   THEN 'bank'
            WHEN UPPER(COALESCE(NEW.by_note, 'CASH')) LIKE '%ONLINE%' THEN 'bank'
            ELSE 'cash' 
          END;
          v_status := COALESCE(NEW.status, 'pending');
          v_created_by := NEW.created_by;
          v_remarks := NEW.remarks;

        -- ── CASE: plot_commission_payments ──
        ELSIF TG_TABLE_NAME = 'plot_commission_payments' THEN
          SELECT COALESCE(m.full_name, 'AGENT') INTO v_particular FROM plot_commissions_v2 pcm LEFT JOIN members m ON m.id = pcm.agent_id WHERE pcm.id = NEW.plot_commission_id;
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT COMMISSION PAYMENT - ' || COALESCE(v_particular, 'AGENT'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_cash_type := CASE 
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CASH'   THEN 'cash' 
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CHEQUE' THEN 'cheque'
            ELSE 'bank' 
          END;
          v_status := COALESCE(NEW.status, 'pending');
          v_created_by := NEW.created_by;

        -- ── CASE: firm_transactions ──
        ELSIF TG_TABLE_NAME = 'firm_transactions' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('FIRM TRANSACTION - ' || COALESCE(NEW.description, 'TRANSACTION'))::VARCHAR(500);
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE 
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CASH'   THEN 'cash' 
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CHEQUE' THEN 'cheque'
            ELSE 'bank' 
          END;
          v_status := 'approved';
          v_created_by := NEW.created_by;
          v_remarks := NEW.remark;

        -- ── CASE: plot_payments ──
        ELSIF TG_TABLE_NAME = 'plot_payments' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT PAYMENT - ' || COALESCE(NEW.buyer_name, NEW.payment_from, 'PLOT'))::VARCHAR(500);
          v_credit := COALESCE(NEW.amount, 0);
          v_cash_type := CASE 
            WHEN UPPER(COALESCE(NEW.payment_type, 'CASH')) = 'CASH'   THEN 'cash' 
            WHEN UPPER(COALESCE(NEW.payment_type, 'CASH')) = 'CHEQUE' THEN 'cheque'
            ELSE 'bank' 
          END;
          v_status := COALESCE(NEW.status, 'pending');
          v_created_by := NEW.created_by;
          v_remarks := NEW.narration;

        -- ── CASE: expenses ──
        ELSIF TG_TABLE_NAME = 'expenses' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.remark, 'EXPENSE ENTRY')::VARCHAR(500);
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE 
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) LIKE '%CHEQUE%' THEN 'cheque'
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) LIKE '%BANK%'   THEN 'bank'
            ELSE 'cash' 
          END;
          v_status := COALESCE(NEW.status, 'pending');
          v_created_by := NEW.created_by;
          v_remarks := CONCAT_WS(' | ', NEW.from_entity, NEW.to_entity, NEW.category);

        -- ── CASE: vendor_payments ──
        ELSIF TG_TABLE_NAME = 'vendor_payments' THEN
          SELECT vc.vendor_name INTO v_particular FROM vendor_commitments vc WHERE vc.id = NEW.commitment_id;
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.payment_date, CURRENT_DATE);
          v_particular := ('VENDOR PAYMENT - ' || COALESCE(v_particular, 'VENDOR'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_cash_type := CASE 
            WHEN LOWER(COALESCE(NEW.payment_mode, 'cash')) = 'cheque' THEN 'cheque'
            WHEN LOWER(COALESCE(NEW.payment_mode, 'cash')) = 'bank'   THEN 'bank'
            ELSE 'cash' 
          END;
          v_status := COALESCE(NEW.status, 'pending');
          v_created_by := NEW.created_by;
          v_remarks := NEW.note;

        -- ── CASE: plot_installment_payments ──
        ELSIF TG_TABLE_NAME = 'plot_installment_payments' THEN
          SELECT plot_no, buyer_name, site_id INTO v_particular, v_remarks, v_site_id FROM plots WHERE id = NEW.plot_id;
          v_entry_date := COALESCE(NEW.payment_date, CURRENT_DATE);
          v_particular := ('INST. PAYMENT - ' || COALESCE(v_particular, 'PLOT') || ' (' || COALESCE(v_remarks, 'BUYER') || ')')::VARCHAR(500);
          v_credit := COALESCE(NEW.amount, 0);
          v_cash_type := CASE 
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CASH'   THEN 'cash' 
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CHEQUE' THEN 'cheque'
            ELSE 'bank' 
          END;
          v_status := 'approved';
          v_created_by := NEW.created_by;
          v_remarks := NEW.notes;

        -- ── CASE: plot_registry_payments ──
        ELSIF TG_TABLE_NAME = 'plot_registry_payments' THEN
          SELECT p.plot_no, p.buyer_name, p.site_id INTO v_particular, v_remarks, v_site_id FROM plot_registries pr JOIN plots p ON pr.plot_id = p.id WHERE pr.id = NEW.registry_id;
          v_entry_date := COALESCE(NEW.payment_date, CURRENT_DATE);
          v_particular := ('REGISTRY PAYMENT - ' || COALESCE(v_particular, 'PLOT') || ' (' || COALESCE(v_remarks, 'BUYER') || ')')::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_cash_type := CASE 
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CASH'   THEN 'cash' 
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CHEQUE' THEN 'cheque'
            ELSE 'bank' 
          END;
          v_status := 'approved';
          v_created_by := NEW.created_by;
          v_remarks := NEW.notes;

        -- ── CASE: day_book ──
        -- Day_book entries whose entry_type belongs to another module (FARMER PAYMENT,
        -- PLOT COMMISSION, VENDOR PAYMENT, FIRM TRANSACTION, PLOT PAYMENT, CASH FLOW)
        -- are always linked back to that module's own table via farmer_payment_id /
        -- commission_id / vendor_payment_id / firm_transaction_id / plot_payment_id /
        -- cash_flow_entry_id. The module table already has its own CFE via its own
        -- trigger, so the day_book entry must NOT create a duplicate CFE.
        ELSIF TG_TABLE_NAME = 'day_book' THEN
          IF UPPER(COALESCE(NEW.entry_type, 'GENERAL')) IN ('CASH FLOW', 'FARMER PAYMENT', 'PLOT COMMISSION', 'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT')
             AND (NEW.cash_flow_entry_id IS NOT NULL
                  OR NEW.firm_transaction_id IS NOT NULL
                  OR NEW.plot_payment_id IS NOT NULL
                  OR NEW.farmer_payment_id IS NOT NULL
                  OR NEW.commission_id IS NOT NULL
                  OR NEW.vendor_payment_id IS NOT NULL)
          THEN
            DELETE FROM cash_flow_entries WHERE source_module = 'day_book' AND source_id = NEW.id;
            RETURN NEW;
          END IF;
          v_site_id := NEW.site_id;
          v_entry_date := NEW.date;
          v_particular := COALESCE(NEW.particular, 'DAY BOOK ENTRY')::VARCHAR(500);
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE 
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CASH'   THEN 'cash' 
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CHEQUE' THEN 'cheque'
            ELSE 'bank' 
          END;
          v_status := COALESCE(NEW.status, 'pending');
          v_created_by := NEW.created_by;
          v_remarks := NEW.remarks;
        END IF;

        -- NOTE: Bounced/returned cheques keep their actual amounts here.
        -- All financial sum queries already exclude them via:
        --   (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
        -- Storing the amount allows the transaction history (e.g. Dashboard) to display it.

        IF v_site_id IS NULL OR (COALESCE(v_debit, 0) = 0 AND COALESCE(v_credit, 0) = 0 AND v_cheque_status IS NULL) THEN
          DELETE FROM cash_flow_entries cfe WHERE cfe.source_module = v_source_module AND cfe.source_id = v_source_id;
          RETURN NEW;
        END IF;

        v_month_id := ensure_site_cashflow_month(v_site_id, v_entry_date, v_created_by);

        INSERT INTO cash_flow_entries (
          cash_flow_month_id, site_id, date, particular, debit, credit, cash_type, remarks,
          status, source_module, source_id, created_by, created_at,
          assigned_admin_id, cheque_status, cheque_no
        ) VALUES (
          v_month_id, v_site_id, v_entry_date, v_particular, v_debit, v_credit, v_cash_type, v_remarks,
          v_status, v_source_module, v_source_id, v_created_by, NEW.created_at,
          NEW.assigned_admin_id, v_cheque_status, v_cheque_no
        )
        ON CONFLICT (source_module, source_id)
        DO UPDATE SET
          cash_flow_month_id = EXCLUDED.cash_flow_month_id, site_id = EXCLUDED.site_id, 
          date = EXCLUDED.date, particular = EXCLUDED.particular,
          debit = EXCLUDED.debit, credit = EXCLUDED.credit, cash_type = EXCLUDED.cash_type,
          remarks = EXCLUDED.remarks, status = EXCLUDED.status, created_by = EXCLUDED.created_by,
          assigned_admin_id = EXCLUDED.assigned_admin_id, 
          cheque_status = EXCLUDED.cheque_status, cheque_no = EXCLUDED.cheque_no, updated_at = NOW();

        RETURN NEW;
      END;
      $$;
    `);
    console.log('✅ Trigger function sync_cashflow_from_modules updated.');

    // ── 2. Delete existing duplicate day_book CFEs for module-linked entries ──
    // These are CFEs where the corresponding day_book entry is linked to another
    // module (farmer_payment_id / commission_id / vendor_payment_id IS NOT NULL),
    // meaning the module already has its own authoritative CFE.
    const cleanup = await client.query(`
      DELETE FROM cash_flow_entries cfe
      USING day_book db
      WHERE cfe.source_module = 'day_book'
        AND cfe.source_id = db.id
        AND UPPER(COALESCE(db.entry_type, 'GENERAL')) IN (
              'CASH FLOW', 'FARMER PAYMENT', 'PLOT COMMISSION',
              'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT'
            )
        AND (db.cash_flow_entry_id IS NOT NULL
             OR db.firm_transaction_id IS NOT NULL
             OR db.plot_payment_id IS NOT NULL
             OR db.farmer_payment_id IS NOT NULL
             OR db.commission_id IS NOT NULL
             OR db.vendor_payment_id IS NOT NULL)
    `);
    console.log(`✅ Deleted ${cleanup.rowCount} duplicate day_book cash_flow_entries.`);
    // Note: cash_flow_months has no stored totals — totals are always summed on the fly
    // from cash_flow_entries, so no recalculation needed here.

    await client.query('COMMIT');
    console.log('✅ Migration 041 complete: day_book CFE double-counting fixed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 041 failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

export const down = async () => {
  // Revert to trigger without the extra linked-ID fields check.
  // WARNING: This will re-introduce the double-counting bug.
  console.log('Migration 041 down: no automatic revert. Re-run migration 040 to restore previous trigger.');
};
