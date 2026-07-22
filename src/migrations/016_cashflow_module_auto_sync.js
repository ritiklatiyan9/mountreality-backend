import pool from '../config/db.js';

export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE cash_flow_entries
      ADD COLUMN IF NOT EXISTS source_module VARCHAR(50),
      ADD COLUMN IF NOT EXISTS source_id INTEGER
    `);

    await client.query(`
      DROP INDEX IF EXISTS uq_cfe_source_module_source_id
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cfe_source_module_source_id
      ON cash_flow_entries(source_module, source_id)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION ensure_site_cashflow_month(
        p_site_id INTEGER,
        p_entry_date DATE,
        p_created_by INTEGER
      )
      RETURNS INTEGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_month INTEGER;
        v_year INTEGER;
        v_month_id INTEGER;
        v_prev_id INTEGER;
        v_opening NUMERIC(15,2) := 0;
      BEGIN
        v_month := EXTRACT(MONTH FROM p_entry_date)::INTEGER;
        v_year := EXTRACT(YEAR FROM p_entry_date)::INTEGER;

        SELECT id INTO v_month_id
        FROM cash_flow_months
        WHERE site_id = p_site_id
          AND month = v_month
          AND year = v_year
          AND COALESCE(ledger_name, '') = ''
          AND COALESCE(ledger_type, 'site') = 'site'
        LIMIT 1;

        IF v_month_id IS NOT NULL THEN
          RETURN v_month_id;
        END IF;

        SELECT cfm.id INTO v_prev_id
        FROM cash_flow_months cfm
        WHERE cfm.site_id = p_site_id
          AND COALESCE(cfm.ledger_name, '') = ''
          AND COALESCE(cfm.ledger_type, 'site') = 'site'
          AND (cfm.year < v_year OR (cfm.year = v_year AND cfm.month < v_month))
        ORDER BY cfm.year DESC, cfm.month DESC
        LIMIT 1;

        IF v_prev_id IS NOT NULL THEN
          SELECT
            COALESCE(cfm.opening_balance, 0)
              + COALESCE(SUM(cfe.credit), 0)
              - COALESCE(SUM(cfe.debit), 0)
          INTO v_opening
          FROM cash_flow_months cfm
          LEFT JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = cfm.id
          WHERE cfm.id = v_prev_id
          GROUP BY cfm.opening_balance;
        END IF;

        INSERT INTO cash_flow_months (
          site_id, month, year, ledger_name, ledger_type, opening_balance, created_by
        ) VALUES (
          p_site_id, v_month, v_year, '', 'site', COALESCE(v_opening, 0), p_created_by
        )
        ON CONFLICT (site_id, month, year, ledger_name)
        DO NOTHING;

        SELECT id INTO v_month_id
        FROM cash_flow_months
        WHERE site_id = p_site_id
          AND month = v_month
          AND year = v_year
          AND COALESCE(ledger_name, '') = ''
          AND COALESCE(ledger_type, 'site') = 'site'
        LIMIT 1;

        RETURN v_month_id;
      END;
      $$
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
        v_cash_type VARCHAR(20) := 'cash';
        v_remarks TEXT;
        v_created_by INTEGER;
        v_month_id INTEGER;
        v_source_module VARCHAR(50);
        v_source_id INTEGER;
        v_assigned_admin_id INTEGER;
      BEGIN
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
          v_source_module := 'farmer_payments';
          v_source_id := NEW.id;
          v_assigned_admin_id := NEW.assigned_admin_id;

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
          v_source_module := 'plot_commissions';
          v_source_id := NEW.id;
          v_assigned_admin_id := NEW.assigned_admin_id;

        ELSIF TG_TABLE_NAME = 'day_book' THEN
          IF UPPER(COALESCE(NEW.entry_type, 'GENERAL')) IN ('CASH FLOW', 'FARMER PAYMENT', 'PLOT COMMISSION', 'FIRM TRANSACTION', 'PLOT PAYMENT') THEN
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
          v_source_module := 'day_book';
          v_source_id := NEW.id;
          v_assigned_admin_id := NEW.assigned_admin_id;

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
          v_source_module := 'firm_transactions';
          v_source_id := NEW.id;
          v_assigned_admin_id := NEW.assigned_admin_id;

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
          v_source_module := 'plot_payments';
          v_source_id := NEW.id;
          v_assigned_admin_id := NEW.assigned_admin_id;

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
          v_source_module := 'expenses';
          v_source_id := NEW.id;
          v_assigned_admin_id := NEW.assigned_admin_id;
        ELSE
          RETURN NEW;
        END IF;

        IF v_site_id IS NULL THEN
          RETURN NEW;
        END IF;

        IF COALESCE(v_debit, 0) = 0 AND COALESCE(v_credit, 0) = 0 THEN
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
          source_id
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
          v_source_id
        )
        ON CONFLICT (source_module, source_id) DO NOTHING;

        RETURN NEW;
      END;
      $$
    `);

    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_farmer_payments ON farmer_payments`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_plot_commissions ON plot_commissions`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_day_book ON day_book`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_firm_transactions ON firm_transactions`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_plot_payments ON plot_payments`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_expenses ON expenses`);

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

    await client.query('COMMIT');
    console.log('✅ Migration 016 complete: cashflow auto-sync + site-month auto-create enabled.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 016 failed:', error);
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
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_day_book ON day_book`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_firm_transactions ON firm_transactions`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_plot_payments ON plot_payments`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_expenses ON expenses`);

    await client.query(`DROP FUNCTION IF EXISTS sync_cashflow_from_modules()`);
    await client.query(`DROP FUNCTION IF EXISTS ensure_site_cashflow_month(INTEGER, DATE, INTEGER)`);

    await client.query(`DROP INDEX IF EXISTS uq_cfe_source_module_source_id`);

    await client.query(`
      ALTER TABLE cash_flow_entries
      DROP COLUMN IF EXISTS source_id,
      DROP COLUMN IF EXISTS source_module
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 016 rollback complete.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 016 rollback failed:', error);
    throw error;
  } finally {
    client.release();
  }
};
