import pool from '../config/db.js';

export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE vendor_payments
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'vendor_payments_status_check'
            AND conrelid = 'vendor_payments'::regclass
        ) THEN
          ALTER TABLE vendor_payments
          ADD CONSTRAINT vendor_payments_status_check
          CHECK (status IN ('pending', 'approved', 'rejected'));
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_status
      ON vendor_payments(status)
    `);

    await client.query(`
      ALTER TABLE day_book
      ADD COLUMN IF NOT EXISTS vendor_payment_id INTEGER REFERENCES vendor_payments(id) ON DELETE SET NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_day_book_vendor_payment_id
      ON day_book(vendor_payment_id)
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'day_book_entry_type_check'
            AND conrelid = 'day_book'::regclass
        ) THEN
          ALTER TABLE day_book DROP CONSTRAINT day_book_entry_type_check;
        END IF;

        ALTER TABLE day_book
        ADD CONSTRAINT day_book_entry_type_check
        CHECK (
          entry_type IN (
            'GENERAL','EXPENSE','INCOME','PAYMENT','RECEIPT','TRANSFER','ADJUSTMENT','OTHER',
            'FARMER PAYMENT','PLOT COMMISSION','CASH FLOW','FIRM TRANSACTION','PLOT PAYMENT',
            'IMPREST','VENDOR PAYMENT'
          )
        );
      END $$;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_daybook_from_vendor_payments()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_vendor_name VARCHAR(255);
      BEGIN
        SELECT COALESCE(vc.vendor_name, 'VENDOR') INTO v_vendor_name
        FROM vendor_commitments vc
        WHERE vc.id = NEW.commitment_id;

        IF TG_OP = 'INSERT' THEN
          INSERT INTO day_book (
            site_id, date, particular, entry_type,
            debit, credit, remarks, payment_mode,
            category, from_entity, to_entity,
            status, approved_by, approved_at,
            vendor_payment_id, created_by
          ) VALUES (
            NEW.site_id,
            COALESCE(NEW.payment_date, CURRENT_DATE),
            ('VENDOR PAYMENT - ' || COALESCE(v_vendor_name, 'VENDOR'))::VARCHAR(500),
            'VENDOR PAYMENT',
            COALESCE(NEW.amount, 0),
            0,
            NEW.note,
            UPPER(COALESCE(NEW.payment_mode, 'CASH')),
            'VENDOR',
            'COMPANY',
            COALESCE(v_vendor_name, NEW.reference_no, 'VENDOR'),
            COALESCE(NEW.status, 'pending'),
            NEW.approved_by,
            NEW.approved_at,
            NEW.id,
            NEW.created_by
          )
          ON CONFLICT DO NOTHING;
        ELSE
          UPDATE day_book db
          SET
            site_id = NEW.site_id,
            date = COALESCE(NEW.payment_date, db.date),
            particular = ('VENDOR PAYMENT - ' || COALESCE(v_vendor_name, 'VENDOR'))::VARCHAR(500),
            debit = COALESCE(NEW.amount, 0),
            credit = 0,
            remarks = NEW.note,
            payment_mode = UPPER(COALESCE(NEW.payment_mode, db.payment_mode, 'CASH')),
            category = 'VENDOR',
            from_entity = 'COMPANY',
            to_entity = COALESCE(v_vendor_name, db.to_entity),
            status = COALESCE(NEW.status, db.status),
            approved_by = NEW.approved_by,
            approved_at = NEW.approved_at,
            updated_at = NOW()
          WHERE db.vendor_payment_id = NEW.id;
        END IF;

        RETURN NEW;
      END;
      $$
    `);

    await client.query(`DROP TRIGGER IF EXISTS trg_sync_daybook_vendor_payments ON vendor_payments`);
    await client.query(`
      CREATE TRIGGER trg_sync_daybook_vendor_payments
      AFTER INSERT OR UPDATE ON vendor_payments
      FOR EACH ROW EXECUTE FUNCTION sync_daybook_from_vendor_payments()
    `);

    await client.query(`
      INSERT INTO day_book (
        site_id, date, particular, entry_type,
        debit, credit, remarks, payment_mode,
        category, from_entity, to_entity,
        status, approved_by, approved_at,
        vendor_payment_id, created_by
      )
      SELECT
        vp.site_id,
        vp.payment_date,
        ('VENDOR PAYMENT - ' || COALESCE(vc.vendor_name, 'VENDOR'))::VARCHAR(500),
        'VENDOR PAYMENT',
        vp.amount,
        0,
        vp.note,
        UPPER(COALESCE(vp.payment_mode, 'CASH')),
        'VENDOR',
        'COMPANY',
        COALESCE(vc.vendor_name, vp.reference_no, 'VENDOR'),
        COALESCE(vp.status, 'pending'),
        vp.approved_by,
        vp.approved_at,
        vp.id,
        vp.created_by
      FROM vendor_payments vp
      JOIN vendor_commitments vc ON vc.id = vp.commitment_id
      LEFT JOIN day_book db ON db.vendor_payment_id = vp.id
      WHERE db.id IS NULL
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
        v_voucher_url TEXT;
        v_status VARCHAR(20) := 'pending';
        v_approved_by INTEGER;
        v_approved_at TIMESTAMPTZ;
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
          v_source_module := 'plot_commissions';
          v_source_id := NEW.id;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'day_book' THEN
          IF UPPER(COALESCE(NEW.entry_type, 'GENERAL')) IN ('CASH FLOW', 'FARMER PAYMENT', 'PLOT COMMISSION', 'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT') THEN
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
          v_source_module := 'firm_transactions';
          v_source_id := NEW.id;
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
          v_source_module := 'plot_payments';
          v_source_id := NEW.id;
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
          v_source_module := 'expenses';
          v_source_id := NEW.id;
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
          v_source_module := 'vendor_payments';
          v_source_id := NEW.id;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
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
        ON CONFLICT (source_module, source_id) DO NOTHING;

        RETURN NEW;
      END;
      $$
    `);

    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_vendor_payments ON vendor_payments`);
    await client.query(`
      CREATE TRIGGER trg_sync_cfe_vendor_payments
      AFTER INSERT ON vendor_payments
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()
    `);

    await client.query(`
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
        source_module,
        source_id,
        voucher_url,
        status,
        approved_by,
        approved_at
      )
      SELECT
        ensure_site_cashflow_month(vp.site_id, vp.payment_date, vp.created_by),
        vp.site_id,
        vp.payment_date,
        ('VENDOR PAYMENT - ' || COALESCE(vc.vendor_name, 'VENDOR'))::VARCHAR(500),
        vp.amount,
        0,
        CASE WHEN LOWER(COALESCE(vp.payment_mode, 'cash')) = 'bank' THEN 'bank' ELSE 'cash' END,
        vp.note,
        vp.created_by,
        'vendor_payments',
        vp.id,
        vp.voucher_url,
        COALESCE(vp.status, 'pending'),
        vp.approved_by,
        vp.approved_at
      FROM vendor_payments vp
      JOIN vendor_commitments vc ON vc.id = vp.commitment_id
      LEFT JOIN cash_flow_entries cfe
        ON cfe.source_module = 'vendor_payments' AND cfe.source_id = vp.id
      WHERE cfe.id IS NULL
    `);

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
            assigned_admin_id = NEW.assigned_admin_id,
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

        ELSIF TG_TABLE_NAME = 'vendor_payments' THEN
          UPDATE cash_flow_entries cfe
          SET
            status = COALESCE(NEW.status, cfe.status),
            approved_by = NEW.approved_by,
            approved_at = NEW.approved_at,
            voucher_url = COALESCE(NEW.voucher_url, cfe.voucher_url),
            updated_at = NOW()
          WHERE cfe.source_module = 'vendor_payments'
            AND cfe.source_id = NEW.id;
        END IF;

        RETURN NEW;
      END;
      $$
    `);

    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_status_vendor_payments ON vendor_payments`);
    await client.query(`
      CREATE TRIGGER trg_sync_cfe_status_vendor_payments
      AFTER INSERT OR UPDATE ON vendor_payments
      FOR EACH ROW EXECUTE FUNCTION sync_cashflow_status_from_source()
    `);

    await client.query(`
      UPDATE cash_flow_entries cfe
      SET
        status = vp.status,
        approved_by = vp.approved_by,
        approved_at = vp.approved_at,
        voucher_url = COALESCE(vp.voucher_url, cfe.voucher_url),
        updated_at = NOW()
      FROM vendor_payments vp
      WHERE cfe.source_module = 'vendor_payments'
        AND cfe.source_id = vp.id
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 019 complete: vendor payments now integrated with approval, daybook and cashflow sync.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 019 failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

export const down = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`DROP TRIGGER IF EXISTS trg_sync_daybook_vendor_payments ON vendor_payments`);
    await client.query(`DROP FUNCTION IF EXISTS sync_daybook_from_vendor_payments()`);

    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_vendor_payments ON vendor_payments`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_cfe_status_vendor_payments ON vendor_payments`);

    await client.query(`
      DELETE FROM cash_flow_entries
      WHERE source_module = 'vendor_payments'
    `);

    await client.query(`
      DELETE FROM day_book
      WHERE vendor_payment_id IS NOT NULL
    `);

    await client.query(`
      ALTER TABLE day_book
      DROP COLUMN IF EXISTS vendor_payment_id
    `);

    await client.query(`
      ALTER TABLE vendor_payments
      DROP COLUMN IF EXISTS approved_at,
      DROP COLUMN IF EXISTS approved_by,
      DROP COLUMN IF EXISTS status
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 019 rollback complete.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 019 rollback failed:', error);
    throw error;
  } finally {
    client.release();
  }
};
