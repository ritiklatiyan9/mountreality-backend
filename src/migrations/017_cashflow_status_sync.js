import pool from '../config/db.js';

export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_cashflow_status_from_source()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_TABLE_NAME = 'day_book' THEN
          UPDATE cash_flow_entries cfe
          SET
            status = COALESCE(NEW.status, cfe.status),
            approved_by = NEW.approved_by,
            approved_at = NEW.approved_at,
            updated_at = NOW()
          WHERE cfe.source_module = 'day_book'
            AND cfe.source_id = NEW.id;

        ELSIF TG_TABLE_NAME = 'expenses' THEN
          UPDATE cash_flow_entries cfe
          SET
            status = COALESCE(NEW.status, cfe.status),
            approved_by = NEW.approved_by,
            approved_at = NEW.approved_at,
            voucher_url = COALESCE(NEW.voucher_url, cfe.voucher_url),
            updated_at = NOW()
          WHERE cfe.source_module = 'expenses'
            AND cfe.source_id = NEW.id;

        ELSIF TG_TABLE_NAME = 'firm_transactions' THEN
          UPDATE cash_flow_entries cfe
          SET
            status = COALESCE(NEW.status, cfe.status),
            voucher_url = COALESCE(NEW.voucher_url, cfe.voucher_url),
            updated_at = NOW()
          WHERE cfe.source_module = 'firm_transactions'
            AND cfe.source_id = NEW.id;

        ELSIF TG_TABLE_NAME = 'plot_payments' THEN
          UPDATE cash_flow_entries cfe
          SET
            status = COALESCE(NEW.status, cfe.status),
            voucher_url = COALESCE(NEW.voucher_url, cfe.voucher_url),
            updated_at = NOW()
          WHERE cfe.source_module = 'plot_payments'
            AND cfe.source_id = NEW.id;
        END IF;

        RETURN NEW;
      END;
      $$
    `);

    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_status_day_book ON day_book`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_status_expenses ON expenses`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_status_firm_transactions ON firm_transactions`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_status_plot_payments ON plot_payments`);

    await client.query(`
      CREATE TRIGGER trg_sync_cfe_status_day_book
      AFTER INSERT OR UPDATE ON day_book
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_status_from_source()
    `);

    await client.query(`
      CREATE TRIGGER trg_sync_cfe_status_expenses
      AFTER INSERT OR UPDATE ON expenses
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_status_from_source()
    `);

    await client.query(`
      CREATE TRIGGER trg_sync_cfe_status_firm_transactions
      AFTER INSERT OR UPDATE ON firm_transactions
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_status_from_source()
    `);

    await client.query(`
      CREATE TRIGGER trg_sync_cfe_status_plot_payments
      AFTER INSERT OR UPDATE ON plot_payments
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_status_from_source()
    `);

    // One-time backfill to fix already inserted rows.
    await client.query(`
      UPDATE cash_flow_entries cfe
      SET
        status = db.status,
        approved_by = db.approved_by,
        approved_at = db.approved_at,
        updated_at = NOW()
      FROM day_book db
      WHERE cfe.source_module = 'day_book'
        AND cfe.source_id = db.id
    `);

    await client.query(`
      UPDATE cash_flow_entries cfe
      SET
        status = e.status,
        approved_by = e.approved_by,
        approved_at = e.approved_at,
        voucher_url = COALESCE(e.voucher_url, cfe.voucher_url),
        updated_at = NOW()
      FROM expenses e
      WHERE cfe.source_module = 'expenses'
        AND cfe.source_id = e.id
    `);

    await client.query(`
      UPDATE cash_flow_entries cfe
      SET
        status = ft.status,
        voucher_url = COALESCE(ft.voucher_url, cfe.voucher_url),
        updated_at = NOW()
      FROM firm_transactions ft
      WHERE cfe.source_module = 'firm_transactions'
        AND cfe.source_id = ft.id
    `);

    await client.query(`
      UPDATE cash_flow_entries cfe
      SET
        status = pp.status,
        voucher_url = COALESCE(pp.voucher_url, cfe.voucher_url),
        updated_at = NOW()
      FROM plot_payments pp
      WHERE cfe.source_module = 'plot_payments'
        AND cfe.source_id = pp.id
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 017 complete: source status now syncs to cash flow entries.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 017 failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

export const down = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_status_day_book ON day_book`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_status_expenses ON expenses`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_status_firm_transactions ON firm_transactions`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_status_plot_payments ON plot_payments`);

    await client.query(`DROP FUNCTION IF EXISTS sync_cashflow_status_from_source()`);

    await client.query('COMMIT');
    console.log('✅ Migration 017 rollback complete.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 017 rollback failed:', error);
    throw error;
  } finally {
    client.release();
  }
};
