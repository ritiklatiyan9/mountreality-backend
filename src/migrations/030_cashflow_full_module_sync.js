import pool from '../config/db.js';

export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
      BEGIN
        v_source_module := TG_TABLE_NAME;

        IF TG_OP = 'DELETE' THEN
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_source_module
            AND cfe.source_id = OLD.id;
          RETURN OLD;
        END IF;

        v_source_id := NEW.id;

        IF TG_TABLE_NAME = 'farmer_payments' THEN
          SELECT f.site_id, f.name INTO v_site_id, v_particular
          FROM farmers f
          WHERE f.id = NEW.farmer_id;

          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('FARMER PAYMENT - ' || COALESCE(v_particular, 'FARMER'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'BANK' THEN 'bank'
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
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'BANK' THEN 'bank'
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
            WHEN LOWER(COALESCE(NEW.payment_mode, 'cash')) = 'bank' THEN 'bank'
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
            WHEN LOWER(COALESCE(NEW.payment_mode, 'cash')) = 'bank' THEN 'bank'
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

        IF v_site_id IS NULL OR (COALESCE(v_debit, 0) = 0 AND COALESCE(v_credit, 0) = 0) THEN
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_source_module
            AND cfe.source_id = v_source_id;
          RETURN NEW;
        END IF;

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
          approved_at
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
          v_approved_at
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
          updated_at = NOW();

        RETURN NEW;
      END;
      $$
    `);

    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_farmer_payments ON farmer_payments`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_plot_commissions ON plot_commissions`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_plot_commission_payments ON plot_commission_payments`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_day_book ON day_book`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_firm_transactions ON firm_transactions`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_plot_payments ON plot_payments`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_expenses ON expenses`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_vendor_payments ON vendor_payments`);

    await client.query(`
      CREATE TRIGGER trg_sync_cfe_farmer_payments
      AFTER INSERT OR UPDATE OR DELETE ON farmer_payments
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);

    await client.query(`
      CREATE TRIGGER trg_sync_cfe_plot_commissions
      AFTER INSERT OR UPDATE OR DELETE ON plot_commissions
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);

    await client.query(`
      CREATE TRIGGER trg_sync_cfe_plot_commission_payments
      AFTER INSERT OR UPDATE OR DELETE ON plot_commission_payments
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);

    await client.query(`
      CREATE TRIGGER trg_sync_cfe_day_book
      AFTER INSERT OR UPDATE OR DELETE ON day_book
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);

    await client.query(`
      CREATE TRIGGER trg_sync_cfe_firm_transactions
      AFTER INSERT OR UPDATE OR DELETE ON firm_transactions
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);

    await client.query(`
      CREATE TRIGGER trg_sync_cfe_plot_payments
      AFTER INSERT OR UPDATE OR DELETE ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);

    await client.query(`
      CREATE TRIGGER trg_sync_cfe_expenses
      AFTER INSERT OR UPDATE OR DELETE ON expenses
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);

    await client.query(`
      CREATE TRIGGER trg_sync_cfe_vendor_payments
      AFTER INSERT OR UPDATE OR DELETE ON vendor_payments
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);

    // Remove orphaned source-linked entries once.
    await client.query(`
      DELETE FROM cash_flow_entries cfe
      WHERE cfe.source_module = 'farmer_payments'
        AND NOT EXISTS (SELECT 1 FROM farmer_payments fp WHERE fp.id = cfe.source_id)
    `);
    await client.query(`
      DELETE FROM cash_flow_entries cfe
      WHERE cfe.source_module = 'plot_commissions'
        AND NOT EXISTS (SELECT 1 FROM plot_commissions pc WHERE pc.id = cfe.source_id)
    `);
    await client.query(`
      DELETE FROM cash_flow_entries cfe
      WHERE cfe.source_module = 'plot_commission_payments'
        AND NOT EXISTS (SELECT 1 FROM plot_commission_payments pcp WHERE pcp.id = cfe.source_id)
    `);
    await client.query(`
      DELETE FROM cash_flow_entries cfe
      WHERE cfe.source_module = 'day_book'
        AND NOT EXISTS (SELECT 1 FROM day_book db WHERE db.id = cfe.source_id)
    `);
    await client.query(`
      DELETE FROM cash_flow_entries cfe
      WHERE cfe.source_module = 'firm_transactions'
        AND NOT EXISTS (SELECT 1 FROM firm_transactions ft WHERE ft.id = cfe.source_id)
    `);
    await client.query(`
      DELETE FROM cash_flow_entries cfe
      WHERE cfe.source_module = 'plot_payments'
        AND NOT EXISTS (SELECT 1 FROM plot_payments pp WHERE pp.id = cfe.source_id)
    `);
    await client.query(`
      DELETE FROM cash_flow_entries cfe
      WHERE cfe.source_module = 'expenses'
        AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.id = cfe.source_id)
    `);
    await client.query(`
      DELETE FROM cash_flow_entries cfe
      WHERE cfe.source_module = 'vendor_payments'
        AND NOT EXISTS (SELECT 1 FROM vendor_payments vp WHERE vp.id = cfe.source_id)
    `);

    // One-time full re-sync (fires update triggers and upserts current values).
    await client.query(`UPDATE farmer_payments SET id = id`);
    await client.query(`UPDATE plot_commissions SET id = id`);
    await client.query(`UPDATE plot_commission_payments SET id = id`);
    await client.query(`UPDATE day_book SET id = id`);
    await client.query(`UPDATE firm_transactions SET id = id`);
    await client.query(`UPDATE plot_payments SET id = id`);
    await client.query(`UPDATE expenses SET id = id`);
    await client.query(`UPDATE vendor_payments SET id = id`);

    await client.query('COMMIT');
    console.log('✅ Migration 030 complete: cash flow sync now covers insert/update/delete across money modules.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 030 failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

export const down = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_farmer_payments ON farmer_payments`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_plot_commissions ON plot_commissions`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_plot_commission_payments ON plot_commission_payments`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_day_book ON day_book`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_firm_transactions ON firm_transactions`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_plot_payments ON plot_payments`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_expenses ON expenses`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_vendor_payments ON vendor_payments`);

    await client.query(`
      CREATE TRIGGER trg_sync_cfe_farmer_payments
      AFTER INSERT ON farmer_payments
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);
    await client.query(`
      CREATE TRIGGER trg_sync_cfe_plot_commissions
      AFTER INSERT ON plot_commissions
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);
    await client.query(`
      CREATE TRIGGER trg_sync_cfe_day_book
      AFTER INSERT ON day_book
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);
    await client.query(`
      CREATE TRIGGER trg_sync_cfe_firm_transactions
      AFTER INSERT ON firm_transactions
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);
    await client.query(`
      CREATE TRIGGER trg_sync_cfe_plot_payments
      AFTER INSERT ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);
    await client.query(`
      CREATE TRIGGER trg_sync_cfe_expenses
      AFTER INSERT ON expenses
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);
    await client.query(`
      CREATE TRIGGER trg_sync_cfe_vendor_payments
      AFTER INSERT ON vendor_payments
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 030 rollback complete.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 030 rollback failed:', error);
    throw error;
  } finally {
    client.release();
  }
};
