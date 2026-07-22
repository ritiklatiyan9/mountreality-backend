import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 076 — map any money-module transaction to a person (a managed
 * user or a /clients member) and auto-mirror it into that person's Personal
 * Ledger, creating the ledger on first use.
 *
 * Additive and idempotent:
 *  - 7 nullable columns (mapped_member_id / mapped_user_id) added to the
 *    tables already wired into sync_cashflow_from_modules() (migration 030).
 *  - `ensure_person_cashflow_month()` is a new function, a straight copy of
 *    the existing `ensure_site_cashflow_month()` pattern but keyed on
 *    (site, month, year, linked_member_id/linked_user_id) instead of the
 *    fixed site ledger — Personal Ledgers are monthly too (see CashFlow.jsx).
 *  - `sync_cashflow_from_modules()` is CREATE OR REPLACE'd with the exact
 *    same site-ledger behavior plus a new person-mirror block. Existing
 *    triggers already call this function (AFTER INSERT/UPDATE/DELETE on all
 *    7 tables), so nothing needs to be re-created — every row with no
 *    mapped_member_id/mapped_user_id behaves exactly as before.
 */
const MAPPED_TABLES = [
  'farmer_payments',
  'plot_commission_payments',
  'day_book',
  'firm_transactions',
  'plot_payments',
  'expenses',
  'vendor_payments',
];

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Multiple app replicas may run startup migrations together — serialize.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('076_transaction_person_mapping'))`);

    for (const table of MAPPED_TABLES) {
      await client.query(`
        ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS mapped_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS mapped_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_${table}_mapped_member_id ON ${table}(mapped_member_id)
          WHERE mapped_member_id IS NOT NULL
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_${table}_mapped_user_id ON ${table}(mapped_user_id)
          WHERE mapped_user_id IS NOT NULL
      `);
    }

    // ── find-or-create a person's monthly ledger (mirrors ensure_site_cashflow_month) ──
    await client.query(`
      CREATE OR REPLACE FUNCTION ensure_person_cashflow_month(
        p_site_id INTEGER,
        p_entry_date DATE,
        p_mapped_member_id INTEGER,
        p_mapped_user_id INTEGER,
        p_display_name VARCHAR,
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
        v_name VARCHAR(255);
      BEGIN
        v_month := EXTRACT(MONTH FROM p_entry_date)::INTEGER;
        v_year := EXTRACT(YEAR FROM p_entry_date)::INTEGER;
        v_name := NULLIF(UPPER(TRIM(COALESCE(p_display_name, ''))), '');
        IF v_name IS NULL THEN
          v_name := 'PERSON #' || COALESCE(p_mapped_member_id, p_mapped_user_id)::text;
        END IF;

        SELECT id INTO v_month_id
        FROM cash_flow_months
        WHERE site_id = p_site_id AND month = v_month AND year = v_year AND ledger_type = 'person'
          AND ((p_mapped_member_id IS NOT NULL AND linked_member_id = p_mapped_member_id)
            OR (p_mapped_user_id IS NOT NULL AND linked_user_id = p_mapped_user_id))
        LIMIT 1;

        IF v_month_id IS NOT NULL THEN
          RETURN v_month_id;
        END IF;

        SELECT cfm.id INTO v_prev_id
        FROM cash_flow_months cfm
        WHERE cfm.site_id = p_site_id AND cfm.ledger_type = 'person'
          AND ((p_mapped_member_id IS NOT NULL AND cfm.linked_member_id = p_mapped_member_id)
            OR (p_mapped_user_id IS NOT NULL AND cfm.linked_user_id = p_mapped_user_id))
          AND (cfm.year < v_year OR (cfm.year = v_year AND cfm.month < v_month))
        ORDER BY cfm.year DESC, cfm.month DESC
        LIMIT 1;

        IF v_prev_id IS NOT NULL THEN
          SELECT COALESCE(cfm.opening_balance, 0) + COALESCE(SUM(cfe.credit), 0) - COALESCE(SUM(cfe.debit), 0)
            INTO v_opening
          FROM cash_flow_months cfm
          LEFT JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = cfm.id
          WHERE cfm.id = v_prev_id
          GROUP BY cfm.opening_balance;
        END IF;

        INSERT INTO cash_flow_months (
          site_id, month, year, ledger_name, ledger_type, opening_balance, created_by,
          linked_member_id, linked_user_id
        ) VALUES (
          p_site_id, v_month, v_year, v_name, 'person', COALESCE(v_opening, 0), p_created_by,
          p_mapped_member_id, p_mapped_user_id
        )
        ON CONFLICT (site_id, month, year, ledger_name) DO NOTHING
        RETURNING id INTO v_month_id;

        IF v_month_id IS NULL THEN
          -- ponytail: display name collided with an unrelated ledger already using
          -- it this period (two different people, same name) — disambiguate by id
          -- so the mapping never silently lands in someone else's ledger.
          INSERT INTO cash_flow_months (
            site_id, month, year, ledger_name, ledger_type, opening_balance, created_by,
            linked_member_id, linked_user_id
          ) VALUES (
            p_site_id, v_month, v_year,
            v_name || ' #' || COALESCE(p_mapped_member_id, p_mapped_user_id)::text,
            'person', COALESCE(v_opening, 0), p_created_by, p_mapped_member_id, p_mapped_user_id
          )
          RETURNING id INTO v_month_id;
        END IF;

        RETURN v_month_id;
      END;
      $$
    `);

    // ── sync_cashflow_from_modules(): same as migration 030 + person-mirror block ──
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
        v_person_source_module VARCHAR(60);
        v_source_id INTEGER;
        v_assigned_admin_id INTEGER;
        v_voucher_url TEXT;
        v_status VARCHAR(20) := 'pending';
        v_approved_by INTEGER;
        v_approved_at TIMESTAMPTZ;
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
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

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
          -- legacy table, no writer left — no mapped_* columns added for it.
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
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        ELSIF TG_TABLE_NAME = 'day_book' THEN
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
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) LIKE '%BANK%' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
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
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

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
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

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
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

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
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;
        ELSE
          RETURN NEW;
        END IF;

        IF v_site_id IS NULL OR (COALESCE(v_debit, 0) = 0 AND COALESCE(v_credit, 0) = 0) THEN
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_source_module AND cfe.source_id = v_source_id;
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;
          RETURN NEW;
        END IF;

        v_month_id := ensure_site_cashflow_month(v_site_id, v_entry_date, v_created_by);

        INSERT INTO cash_flow_entries (
          cash_flow_month_id, site_id, date, particular, debit, credit, cash_type, remarks,
          created_by, assigned_admin_id, source_module, source_id, voucher_url, status, approved_by, approved_at
        ) VALUES (
          v_month_id, v_site_id, v_entry_date, v_particular, v_debit, v_credit, v_cash_type, v_remarks,
          v_created_by, v_assigned_admin_id, v_source_module, v_source_id, v_voucher_url, v_status, v_approved_by, v_approved_at
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

        -- ── person-ledger mirror (new in migration 076) ──
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
            created_by, assigned_admin_id, source_module, source_id, voucher_url, status, approved_by, approved_at
          ) VALUES (
            v_person_month_id, v_site_id, v_entry_date, v_particular, v_debit, v_credit, v_cash_type, v_remarks,
            v_created_by, v_assigned_admin_id, v_person_source_module, v_source_id, v_voucher_url, v_status, v_approved_by, v_approved_at
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
        ELSE
          -- No person mapped (or mapping was cleared on UPDATE) — drop any stale mirror.
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;
        END IF;

        RETURN NEW;
      END;
      $$
    `);

    await client.query('COMMIT');
    console.log('Migration 076_transaction_person_mapping complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 076_transaction_person_mapping failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
