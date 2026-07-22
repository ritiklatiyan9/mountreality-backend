-- ============================================================
-- DGAccount — Real Estate Accountancy SaaS
-- PostgreSQL Schema
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. USERS (admin / sub_admin)
-- ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS user_sites CASCADE;
DROP TABLE IF EXISTS sites CASCADE;
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  email           VARCHAR(255) UNIQUE NOT NULL,
  password        VARCHAR(255) NOT NULL,
  phone           VARCHAR(20),
  photo           VARCHAR(500),
  role            VARCHAR(20) NOT NULL DEFAULT 'sub_admin'
                    CHECK (role IN ('super_admin', 'admin', 'sub_admin')),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_active       BOOLEAN DEFAULT TRUE,
  refresh_token   VARCHAR(500),
  token_version   INTEGER DEFAULT 1,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role       ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_created_by ON users(created_by);

-- ──────────────────────────────────────────────────────────────
-- 2. SITES (real-estate projects / properties)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  code            VARCHAR(50) UNIQUE,
  address         TEXT,
  city            VARCHAR(100),
  state           VARCHAR(100),
  description     TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive', 'completed')),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sites_status     ON sites(status);
CREATE INDEX IF NOT EXISTS idx_sites_created_by ON sites(created_by);

-- ──────────────────────────────────────────────────────────────
-- 3. USER_SITES  (which sub-admins can access which sites)
--    Admins have access to ALL sites by default (checked in code)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_sites (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  assigned_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_user_sites_user ON user_sites(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sites_site ON user_sites(site_id);

-- ──────────────────────────────────────────────────────────────
-- Trigger: auto-update updated_at
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_sites_updated_at
  BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- 4. FARMERS (land owners who receive payments from admin)
-- ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS farmer_payments CASCADE;
DROP TABLE IF EXISTS farmers CASCADE;

CREATE TABLE IF NOT EXISTS farmers (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  phone           VARCHAR(20),
  address         TEXT,
  total_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
  interest_rate   NUMERIC(5,2) NOT NULL DEFAULT 0,
  site_id         INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes           TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'completed', 'inactive')),
  member_id       INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_farmers_site     ON farmers(site_id);
CREATE INDEX IF NOT EXISTS idx_farmers_status   ON farmers(status);
CREATE INDEX IF NOT EXISTS idx_farmers_created  ON farmers(created_by);

-- ──────────────────────────────────────────────────────────────
-- 5. FARMER_PAYMENTS (installments paid to farmers)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS farmer_payments (
  id              SERIAL PRIMARY KEY,
  farmer_id       INTEGER NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  particular      VARCHAR(255) NOT NULL,
  amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
  by_note         VARCHAR(500),
  interest_rate   NUMERIC(5,2) DEFAULT 0,
  interest_amount NUMERIC(15,2) DEFAULT 0,
  remarks         TEXT,
  payment_mode    VARCHAR(20) DEFAULT 'CASH',        -- CASH, BANK, SPLIT
  cash_amount     NUMERIC(15,2) DEFAULT 0,
  bank_amount     NUMERIC(15,2) DEFAULT 0,
  bank_name       VARCHAR(255),
  bank_account_no VARCHAR(100),
  bank_reference  VARCHAR(255),
  bank_ifsc       VARCHAR(20),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_farmer_payments_farmer ON farmer_payments(farmer_id);
CREATE INDEX IF NOT EXISTS idx_farmer_payments_date   ON farmer_payments(date);
-- Farmer module performance indexes (see migration 051_farmer_performance_indexes.js)
CREATE INDEX IF NOT EXISTS idx_farmers_site_status        ON farmers(site_id, status);
CREATE INDEX IF NOT EXISTS idx_farmers_site_created_at    ON farmers(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_farmer_payments_active     ON farmer_payments(farmer_id)
  WHERE cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED');
CREATE INDEX IF NOT EXISTS idx_farmer_payments_farmer_date ON farmer_payments(farmer_id, date);

CREATE TRIGGER trg_farmers_updated_at
  BEFORE UPDATE ON farmers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_farmer_payments_updated_at
  BEFORE UPDATE ON farmer_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- 6. PLOT_COMMISSIONS (commission payments per site)
-- ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS plot_commissions CASCADE;

CREATE TABLE IF NOT EXISTS plot_commissions (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  particular      VARCHAR(255) NOT NULL,
  father_name     VARCHAR(255),
  plot_no         VARCHAR(50),
  plot_size       VARCHAR(50),
  plot_rate       VARCHAR(50),
  amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
  by_note         VARCHAR(500),
  remarks         TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plot_commissions_site   ON plot_commissions(site_id);
CREATE INDEX IF NOT EXISTS idx_plot_commissions_date   ON plot_commissions(date);
CREATE INDEX IF NOT EXISTS idx_plot_commissions_plot   ON plot_commissions(plot_no);

CREATE TRIGGER trg_plot_commissions_updated_at
  BEFORE UPDATE ON plot_commissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- 7. CASH FLOW MONTHS (monthly periods per site)
-- ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS cash_flow_entries CASCADE;
DROP TABLE IF EXISTS cash_flow_months CASCADE;

CREATE TABLE IF NOT EXISTS cash_flow_months (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  month           INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year            INTEGER NOT NULL,
  ledger_name     VARCHAR(255) NOT NULL DEFAULT '',
  ledger_type     VARCHAR(20) NOT NULL DEFAULT 'site',
  opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  is_locked       BOOLEAN DEFAULT FALSE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(site_id, month, year, ledger_name)
);

CREATE INDEX IF NOT EXISTS idx_cfm_site   ON cash_flow_months(site_id);
CREATE INDEX IF NOT EXISTS idx_cfm_period ON cash_flow_months(year, month);

CREATE TRIGGER trg_cash_flow_months_updated_at
  BEFORE UPDATE ON cash_flow_months
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- 8. CASH FLOW ENTRIES (individual debit/credit rows)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cash_flow_entries (
  id                  SERIAL PRIMARY KEY,
  cash_flow_month_id  INTEGER NOT NULL REFERENCES cash_flow_months(id) ON DELETE CASCADE,
  site_id             INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date                DATE NOT NULL DEFAULT CURRENT_DATE,
  particular          VARCHAR(500) NOT NULL,
  debit               NUMERIC(15,2) NOT NULL DEFAULT 0,
  credit              NUMERIC(15,2) NOT NULL DEFAULT 0,
  cash_type           VARCHAR(20) NOT NULL DEFAULT 'bank' CHECK (cash_type IN ('cash', 'bank')),
  is_firm_transaction BOOLEAN NOT NULL DEFAULT FALSE,
  from_firm_id        INTEGER,
  to_firm_id          INTEGER,
  to_name             VARCHAR(255),
  source_module       VARCHAR(50),
  source_id           INTEGER,
  remarks             TEXT,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cfe_month ON cash_flow_entries(cash_flow_month_id);
CREATE INDEX IF NOT EXISTS idx_cfe_site  ON cash_flow_entries(site_id);
CREATE INDEX IF NOT EXISTS idx_cfe_date  ON cash_flow_entries(date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cfe_source_module_source_id ON cash_flow_entries(source_module, source_id);
CREATE INDEX IF NOT EXISTS idx_cfe_from_firm_id ON cash_flow_entries(from_firm_id);
CREATE INDEX IF NOT EXISTS idx_cfe_to_firm_id ON cash_flow_entries(to_firm_id);
CREATE INDEX IF NOT EXISTS idx_cfe_is_firm_transaction ON cash_flow_entries(is_firm_transaction);
-- Personal Ledger performance indexes (see migration 053_cashflow_performance_indexes.js)
CREATE INDEX IF NOT EXISTS idx_cfe_active_month
  ON cash_flow_entries(cash_flow_month_id)
  WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    AND (status IS NULL OR status != 'rejected');
CREATE INDEX IF NOT EXISTS idx_cfe_month_cash_type ON cash_flow_entries(cash_flow_month_id, cash_type);
CREATE INDEX IF NOT EXISTS idx_cfe_month_date      ON cash_flow_entries(cash_flow_month_id, date, created_at);
CREATE INDEX IF NOT EXISTS idx_cfe_site_particular ON cash_flow_entries(site_id, particular);
CREATE INDEX IF NOT EXISTS idx_cfm_site_ledger_period
  ON cash_flow_months(site_id, ledger_name, year DESC, month DESC);

CREATE TRIGGER trg_cash_flow_entries_updated_at
  BEFORE UPDATE ON cash_flow_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- 20. VENDOR MANAGEMENT (site-based commitments + deductions)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_heads (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name            VARCHAR(120) NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_heads_site_name
  ON vendor_heads(site_id, name);

CREATE TABLE IF NOT EXISTS vendor_commitments (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  vendor_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  vendor_name     VARCHAR(200) NOT NULL,
  head_id         INTEGER REFERENCES vendor_heads(id) ON DELETE SET NULL,
  head_name       VARCHAR(120),
  work_title      VARCHAR(220) NOT NULL,
  contract_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (contract_amount >= 0),
  start_date      DATE,
  due_date        DATE,
  note            TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_commitments_site_id ON vendor_commitments(site_id);
CREATE INDEX IF NOT EXISTS idx_vendor_commitments_vendor_member_id ON vendor_commitments(vendor_member_id);

CREATE TABLE IF NOT EXISTS vendor_payments (
  id              SERIAL PRIMARY KEY,
  commitment_id   INTEGER NOT NULL REFERENCES vendor_commitments(id) ON DELETE CASCADE,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  payment_date    DATE NOT NULL,
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payment_mode    VARCHAR(20) NOT NULL DEFAULT 'cash' CHECK (payment_mode IN ('cash', 'bank', 'upi', 'cheque', 'neft', 'rtgs', 'imps', 'other')),
  reference_no    VARCHAR(120),
  note            TEXT,
  voucher_url     TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_payments_commitment_id ON vendor_payments(commitment_id);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_site_id ON vendor_payments(site_id);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_date ON vendor_payments(payment_date);

-- Vendor module performance indexes (see migration 050_vendor_performance_indexes.js)
CREATE INDEX IF NOT EXISTS idx_vc_site_status        ON vendor_commitments(site_id, status);
CREATE INDEX IF NOT EXISTS idx_vc_site_head          ON vendor_commitments(site_id, head_id);
CREATE INDEX IF NOT EXISTS idx_vc_site_created_at    ON vendor_commitments(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vp_commitment_active  ON vendor_payments(commitment_id)
  WHERE cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED');
CREATE INDEX IF NOT EXISTS idx_vp_site_date          ON vendor_payments(site_id, payment_date DESC);

CREATE TRIGGER trg_vendor_heads_updated_at
  BEFORE UPDATE ON vendor_heads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_vendor_commitments_updated_at
  BEFORE UPDATE ON vendor_commitments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add cash_type column if it doesn't exist (for migration)
ALTER TABLE cash_flow_entries
ADD COLUMN IF NOT EXISTS cash_type VARCHAR(20) NOT NULL DEFAULT 'bank' CHECK (cash_type IN ('cash', 'bank'));

ALTER TABLE cash_flow_entries
ADD COLUMN IF NOT EXISTS is_firm_transaction BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS from_firm_id INTEGER,
ADD COLUMN IF NOT EXISTS to_firm_id INTEGER,
ADD COLUMN IF NOT EXISTS to_name VARCHAR(255);

-- ──────────────────────────────────────────────────────────────
-- 9. FIRMS (bank accounts / entities per site)
-- ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS firm_transactions CASCADE;
DROP TABLE IF EXISTS firms CASCADE;

CREATE TABLE IF NOT EXISTS firms (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  account_number  VARCHAR(50),
  bank_name       VARCHAR(255),
  ifsc_code       VARCHAR(20),
  opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(site_id, name)
);

CREATE INDEX IF NOT EXISTS idx_firms_site ON firms(site_id);

CREATE TRIGGER trg_firms_updated_at
  BEFORE UPDATE ON firms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- 10. FIRM TRANSACTIONS (bank statement rows)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS firm_transactions (
  id              SERIAL PRIMARY KEY,
  firm_id         INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  description     TEXT NOT NULL,
  payment_mode    VARCHAR(20) NOT NULL DEFAULT 'cash' CHECK (payment_mode IN ('cash', 'bank')),
  debit           NUMERIC(15,2) NOT NULL DEFAULT 0,
  credit          NUMERIC(15,2) NOT NULL DEFAULT 0,
  name            VARCHAR(255),
  purpose         VARCHAR(500),
  remark          VARCHAR(100),
  remark2         VARCHAR(255),
  cheque_no       VARCHAR(50),
  cash_flow_entry_id INTEGER REFERENCES cash_flow_entries(id) ON DELETE SET NULL,
  is_firm_to_firm_transfer BOOLEAN NOT NULL DEFAULT false,
  transfer_to_site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  transfer_to_firm_id INTEGER REFERENCES firms(id) ON DELETE SET NULL,
  transfer_group_id VARCHAR(80),
  transfer_direction VARCHAR(10) CHECK (transfer_direction IS NULL OR transfer_direction IN ('OUT', 'IN')),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ft_firm   ON firm_transactions(firm_id);
CREATE INDEX IF NOT EXISTS idx_ft_site   ON firm_transactions(site_id);
CREATE INDEX IF NOT EXISTS idx_ft_date   ON firm_transactions(date);
CREATE INDEX IF NOT EXISTS idx_ft_remark ON firm_transactions(remark);
CREATE INDEX IF NOT EXISTS idx_ft_payment_mode ON firm_transactions(payment_mode);
CREATE INDEX IF NOT EXISTS idx_ft_cash_flow_entry_id ON firm_transactions(cash_flow_entry_id);
CREATE INDEX IF NOT EXISTS idx_ft_transfer_group_id ON firm_transactions(transfer_group_id);
CREATE INDEX IF NOT EXISTS idx_ft_transfer_to_firm_id ON firm_transactions(transfer_to_firm_id);
CREATE INDEX IF NOT EXISTS idx_ft_is_firm_to_firm_transfer ON firm_transactions(is_firm_to_firm_transfer);
-- Firm Transactions performance indexes (see migration 054_firm_performance_indexes.js)
CREATE INDEX IF NOT EXISTS idx_ft_active_firm ON firm_transactions(firm_id)
  WHERE cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED');
CREATE INDEX IF NOT EXISTS idx_ft_firm_date  ON firm_transactions(firm_id, date, created_at);
CREATE INDEX IF NOT EXISTS idx_ft_site_date  ON firm_transactions(site_id, date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ft_site_name  ON firm_transactions(site_id, name)    WHERE name IS NOT NULL AND name != '';
CREATE INDEX IF NOT EXISTS idx_ft_site_purpose ON firm_transactions(site_id, purpose) WHERE purpose IS NOT NULL AND purpose != '';
CREATE INDEX IF NOT EXISTS idx_ft_site_remark  ON firm_transactions(site_id, remark)  WHERE remark IS NOT NULL AND remark != '';
CREATE INDEX IF NOT EXISTS idx_cfe_firm_active ON cash_flow_entries(from_firm_id, to_firm_id)
  WHERE is_firm_transaction = TRUE
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    AND (status IS NULL OR status != 'rejected');
CREATE INDEX IF NOT EXISTS idx_firms_site_name_upper ON firms(site_id, UPPER(name));

CREATE TRIGGER trg_firm_transactions_updated_at
  BEFORE UPDATE ON firm_transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- 11. PLOTS (plot sales / bookings per site)
-- ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS plot_payments CASCADE;
DROP TABLE IF EXISTS plots CASCADE;

CREATE TABLE IF NOT EXISTS plots (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  plot_no         VARCHAR(20) NOT NULL,
  block           VARCHAR(10),
  buyer_name      VARCHAR(255),
  plot_size       NUMERIC(10,2),
  plot_size_mtr   NUMERIC(10,2),
  plot_rate       NUMERIC(15,2),
  sale_price      NUMERIC(15,2) NOT NULL DEFAULT 0,
  commission_rate NUMERIC(15,2) DEFAULT 0,
  plot_commission NUMERIC(15,2) DEFAULT 0,
  original_plot_rate NUMERIC(15,2) DEFAULT 0,
  discount_rate   NUMERIC(15,2) DEFAULT 0,
  registry_area   NUMERIC(10,2) DEFAULT 0,
  circle_rate     NUMERIC(15,2) DEFAULT 0,
  to_receive_bank NUMERIC(15,2) DEFAULT 0,
  first_installment NUMERIC(15,2) DEFAULT 0,
  booking_by      VARCHAR(255),
  booking_date    DATE,
  status          VARCHAR(50) DEFAULT 'BOOKED',
  plot_tag        VARCHAR(20),
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plots_site ON plots(site_id);
CREATE INDEX IF NOT EXISTS idx_plots_status ON plots(status);
CREATE INDEX IF NOT EXISTS idx_plots_plot_no ON plots(plot_no);

CREATE TRIGGER trg_plots_updated_at
  BEFORE UPDATE ON plots
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- 12. PLOT PAYMENTS (payments received against plot sales)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plot_payments (
  id              SERIAL PRIMARY KEY,
  plot_id         INTEGER NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_from    VARCHAR(100),
  payment_type    VARCHAR(20) DEFAULT 'CASH'
                    CHECK (payment_type IN ('BANK', 'CASH')),
  bank_name       VARCHAR(150),
  branch          VARCHAR(150),
  bank_details    VARCHAR(255),
  narration       TEXT,
  received_by     VARCHAR(255),
  buyer_name      VARCHAR(255),
  booked_by       VARCHAR(255),
  amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pp_plot ON plot_payments(plot_id);
CREATE INDEX IF NOT EXISTS idx_pp_site ON plot_payments(site_id);
CREATE INDEX IF NOT EXISTS idx_pp_date ON plot_payments(date);
-- Plot Payments performance indexes (see migration 056_plot_performance_indexes.js)
CREATE INDEX IF NOT EXISTS idx_plots_site_plot_no_upper ON plots(site_id, UPPER(plot_no));
CREATE INDEX IF NOT EXISTS idx_plots_site_status        ON plots(site_id, status);
CREATE INDEX IF NOT EXISTS idx_pp_active_plot           ON plot_payments(plot_id)
  WHERE cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED');
CREATE INDEX IF NOT EXISTS idx_pp_plot_type             ON plot_payments(plot_id, payment_type);
CREATE INDEX IF NOT EXISTS idx_pp_plot_date             ON plot_payments(plot_id, date, created_at);
CREATE INDEX IF NOT EXISTS idx_pp_site_payment_from     ON plot_payments(site_id, payment_from)
  WHERE payment_from IS NOT NULL AND payment_from != '';
CREATE INDEX IF NOT EXISTS idx_pp_site_received_by      ON plot_payments(site_id, received_by)
  WHERE received_by IS NOT NULL AND received_by != '';
CREATE INDEX IF NOT EXISTS idx_pp_site_booked_by        ON plot_payments(site_id, booked_by)
  WHERE booked_by IS NOT NULL AND booked_by != '';

CREATE TRIGGER trg_plot_payments_updated_at
  BEFORE UPDATE ON plot_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- 13. EXPENSES (site-level payment/expense tracking)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  from_entity     VARCHAR(255),
  to_entity       VARCHAR(255),
  payment_mode    VARCHAR(50),
  debit           NUMERIC(15,2) NOT NULL DEFAULT 0,
  credit          NUMERIC(15,2) NOT NULL DEFAULT 0,
  remark          TEXT,
  account_no      VARCHAR(100),
  branch          VARCHAR(255),
  category        VARCHAR(100),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voucher_url     TEXT,
  bill_url        TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exp_site     ON expenses(site_id);
CREATE INDEX IF NOT EXISTS idx_exp_date     ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_exp_site_date ON expenses(site_id, date);
CREATE INDEX IF NOT EXISTS idx_exp_mode     ON expenses(payment_mode);
CREATE INDEX IF NOT EXISTS idx_exp_category ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_exp_status   ON expenses(status);
-- Expense module performance indexes (see migration 057_expense_performance_indexes.js)
CREATE INDEX IF NOT EXISTS idx_exp_active_site ON expenses(site_id, date DESC)
  WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    AND status != 'rejected';
CREATE INDEX IF NOT EXISTS idx_exp_site_status     ON expenses(site_id, status, date DESC);
CREATE INDEX IF NOT EXISTS idx_exp_site_to_entity   ON expenses(site_id, to_entity)
  WHERE to_entity IS NOT NULL AND to_entity != '';
CREATE INDEX IF NOT EXISTS idx_exp_site_from_entity ON expenses(site_id, from_entity)
  WHERE from_entity IS NOT NULL AND from_entity != '';
CREATE INDEX IF NOT EXISTS idx_exp_site_payment_mode ON expenses(site_id, payment_mode)
  WHERE payment_mode IS NOT NULL AND payment_mode != '';
CREATE INDEX IF NOT EXISTS idx_exp_site_category_active ON expenses(site_id, category)
  WHERE category IS NOT NULL AND category != '';

CREATE TRIGGER trg_expenses_updated_at
  BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- 14. PLOT REGISTRIES (registry / sale-deed tracking per site)
-- ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS plot_registry_payments CASCADE;
DROP TABLE IF EXISTS plot_registries CASCADE;

CREATE TABLE IF NOT EXISTS plot_registries (
  id                SERIAL PRIMARY KEY,
  site_id           INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  plot_id           INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  plot_no           VARCHAR(50) NOT NULL,
  customer_name     VARCHAR(255),
  size_meter        NUMERIC(10,2),
  size_sqyard       NUMERIC(10,2),
  circle_rate       NUMERIC(15,2),
  registry_date     DATE,
  created_entry_date DATE,
  farmer_name       VARCHAR(255),
  seller_name       VARCHAR(255),
  firm_name         VARCHAR(255),
  bank_amount       NUMERIC(15,2),
  registry_payment  NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes             TEXT,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(site_id, plot_no)
);

CREATE INDEX IF NOT EXISTS idx_pr_site ON plot_registries(site_id);
CREATE INDEX IF NOT EXISTS idx_pr_plot_id ON plot_registries(plot_id);
CREATE INDEX IF NOT EXISTS idx_pr_plot_no ON plot_registries(plot_no);

CREATE TRIGGER trg_plot_registries_updated_at
  BEFORE UPDATE ON plot_registries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- 15. PLOT REGISTRY PAYMENTS (individual payments against registry)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plot_registry_payments (
  id              SERIAL PRIMARY KEY,
  registry_id     INTEGER NOT NULL REFERENCES plot_registries(id) ON DELETE CASCADE,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source_plot_payment_id INTEGER REFERENCES plot_payments(id) ON DELETE SET NULL,
  payment_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
  payment_mode    VARCHAR(50),
  tally_date      DATE,
  tally_amount    NUMERIC(15,2),
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prp_registry ON plot_registry_payments(registry_id);
CREATE INDEX IF NOT EXISTS idx_prp_site ON plot_registry_payments(site_id);
CREATE INDEX IF NOT EXISTS idx_prp_date ON plot_registry_payments(payment_date);

-- Plot Registry performance indexes (see migration 055_registry_performance_indexes.js)
CREATE INDEX IF NOT EXISTS idx_pr_site_plot_no_upper      ON plot_registries(site_id, UPPER(plot_no));
CREATE INDEX IF NOT EXISTS idx_pr_site_created_entry_date ON plot_registries(site_id, created_entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_pr_site_customer           ON plot_registries(site_id, customer_name)
  WHERE customer_name IS NOT NULL AND customer_name != '';
CREATE INDEX IF NOT EXISTS idx_pr_site_farmer             ON plot_registries(site_id, farmer_name)
  WHERE farmer_name IS NOT NULL AND farmer_name != '';
CREATE INDEX IF NOT EXISTS idx_prp_registry_date          ON plot_registry_payments(registry_id, payment_date, created_at);
CREATE INDEX IF NOT EXISTS idx_prp_source_plot_payment    ON plot_registry_payments(source_plot_payment_id)
  WHERE source_plot_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prp_site_mode              ON plot_registry_payments(site_id, payment_mode)
  WHERE payment_mode IS NOT NULL AND payment_mode != '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_prp_source_plot_payment ON plot_registry_payments(source_plot_payment_id) WHERE source_plot_payment_id IS NOT NULL;

CREATE TRIGGER trg_plot_registry_payments_updated_at
  BEFORE UPDATE ON plot_registry_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- MEMBERS (clients / farmers / members records — NOT login users)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS members (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  member_type     VARCHAR(30) NOT NULL DEFAULT 'CLIENT'
                    CHECK (member_type IN ('CLIENT','FARMER','MEMBER','BROKER','PARTNER','VENDOR','EMPLOYEE','OTHER')),
  -- Personal
  full_name       VARCHAR(255) NOT NULL,
  father_name     VARCHAR(255),
  photo           VARCHAR(500),
  gender          VARCHAR(10) CHECK (gender IN ('MALE','FEMALE','OTHER')),
  date_of_birth   DATE,
  blood_group     VARCHAR(5),
  mother_name     VARCHAR(255),
  spouse_name     VARCHAR(255),
  nationality     VARCHAR(50) DEFAULT 'INDIAN',
  religion        VARCHAR(50),
  caste           VARCHAR(100),
  marital_status  VARCHAR(20),
  anniversary_date DATE,
  qualification   VARCHAR(100),
  -- Contact
  phone           VARCHAR(20),
  alt_phone       VARCHAR(20),
  email           VARCHAR(255),
  whatsapp        VARCHAR(20),
  -- Address
  address         TEXT,
  city            VARCHAR(100),
  state           VARCHAR(100),
  pincode         VARCHAR(10),
  -- Identity
  aadhar_no       VARCHAR(20),
  pan_no          VARCHAR(15),
  voter_id        VARCHAR(30),
  passport_no     VARCHAR(20),
  driving_license_no VARCHAR(30),
  gst_no          VARCHAR(20),
  tin_no          VARCHAR(20),
  -- Bank
  bank_name       VARCHAR(100),
  account_no      VARCHAR(30),
  ifsc_code       VARCHAR(15),
  branch          VARCHAR(100),
  -- Emergency Contact
  emergency_contact_name  VARCHAR(255),
  emergency_contact_phone VARCHAR(20),
  emergency_contact_relation VARCHAR(50),
  -- Nominee
  nominee_name    VARCHAR(255),
  nominee_relation VARCHAR(50),
  nominee_phone   VARCHAR(20),
  -- Employee-specific
  employee_id     VARCHAR(50),
  designation     VARCHAR(100),
  department      VARCHAR(100),
  date_of_joining DATE,
  salary          NUMERIC(15,2),
  employment_type VARCHAR(30),
  -- Employee Document URLs (Cloudinary)
  resume_url      VARCHAR(500),
  marksheet_10th_url VARCHAR(500),
  marksheet_12th_url VARCHAR(500),
  degree_certificate_url VARCHAR(500),
  experience_certificate_url VARCHAR(500),
  offer_letter_url VARCHAR(500),
  other_certificate_url VARCHAR(500),
  -- KYC Document Photo URLs (Cloudinary)
  aadhar_front_url VARCHAR(500),
  aadhar_back_url VARCHAR(500),
  pan_card_url    VARCHAR(500),
  voter_id_url    VARCHAR(500),
  passport_url    VARCHAR(500),
  driving_license_url VARCHAR(500),
  cheque_url      VARCHAR(500),
  other_kyc_url   VARCHAR(500),
  -- Extra
  occupation      VARCHAR(100),
  company_name    VARCHAR(255),
  reference       VARCHAR(255),
  notes           TEXT,
  team            VARCHAR(50),
  status          VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED')),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_members_site ON members(site_id);
CREATE INDEX IF NOT EXISTS idx_members_type ON members(member_type);
CREATE INDEX IF NOT EXISTS idx_members_name ON members(site_id, full_name);
CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);
-- User Management performance indexes (see migration 049_member_performance_indexes.js)
-- Non-unique partial index — application code enforces uniqueness so legacy
-- duplicates are preserved.
CREATE INDEX IF NOT EXISTS idx_members_site_phone_lookup
  ON members(site_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_members_site_type_status
  ON members(site_id, member_type, status);
CREATE INDEX IF NOT EXISTS idx_members_site_status
  ON members(site_id, status);
CREATE INDEX IF NOT EXISTS idx_members_site_created_at
  ON members(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_members_site_full_name_upper
  ON members(site_id, UPPER(full_name));

CREATE TRIGGER trg_members_updated_at
  BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- DAY BOOK (daily ledger entries with integration to expenses)
DROP TABLE IF EXISTS day_book CASCADE;

CREATE TABLE IF NOT EXISTS day_book (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  particular      VARCHAR(500) NOT NULL,
  entry_type      VARCHAR(50) NOT NULL DEFAULT 'GENERAL'
                    CHECK (entry_type IN ('GENERAL','EXPENSE','INCOME','PAYMENT','RECEIPT','TRANSFER','ADJUSTMENT','OTHER','FARMER PAYMENT','PLOT COMMISSION','CASH FLOW','FIRM TRANSACTION','PLOT PAYMENT','IMPREST')),
  debit           NUMERIC(15,2) NOT NULL DEFAULT 0,
  credit          NUMERIC(15,2) NOT NULL DEFAULT 0,
  remarks         TEXT,
  payment_mode    VARCHAR(50),
  category        VARCHAR(100),
  from_entity     VARCHAR(255),
  to_entity       VARCHAR(255),
  account_no      VARCHAR(100),
  branch          VARCHAR(255),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  farmer_payment_id INTEGER REFERENCES farmer_payments(id) ON DELETE SET NULL,
  commission_id   INTEGER REFERENCES plot_commissions(id) ON DELETE SET NULL,
  cash_flow_entry_id INTEGER REFERENCES cash_flow_entries(id) ON DELETE SET NULL,
  firm_transaction_id INTEGER REFERENCES firm_transactions(id) ON DELETE SET NULL,
  plot_payment_id INTEGER REFERENCES plot_payments(id) ON DELETE SET NULL,
  imprest_allocation_id INTEGER REFERENCES imprest_allocations(id) ON DELETE SET NULL,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_day_book_site ON day_book(site_id);
CREATE INDEX IF NOT EXISTS idx_day_book_date ON day_book(date);
CREATE INDEX IF NOT EXISTS idx_day_book_type ON day_book(entry_type);
CREATE INDEX IF NOT EXISTS idx_day_book_site_date ON day_book(site_id, date);
CREATE INDEX IF NOT EXISTS idx_day_book_status ON day_book(status);
CREATE INDEX IF NOT EXISTS idx_day_book_cash_flow_entry_id ON day_book(cash_flow_entry_id);
CREATE INDEX IF NOT EXISTS idx_day_book_firm_transaction_id ON day_book(firm_transaction_id);
CREATE INDEX IF NOT EXISTS idx_day_book_plot_payment_id ON day_book(plot_payment_id);

CREATE TRIGGER trg_day_book_updated_at
  BEFORE UPDATE ON day_book
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- IMPREST ALLOCATIONS (admin → sub-admin petty cash)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS imprest_allocations (
  id                  SERIAL PRIMARY KEY,
  admin_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_admin_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount              NUMERIC(15,2) NOT NULL,
  remark              TEXT,
  status              VARCHAR(30) NOT NULL DEFAULT 'PENDING_RECEIPT'
                        CHECK (status IN ('PENDING_RECEIPT', 'RECEIVED', 'CANCELLED')),
  confirmation_remark TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  confirmed_at        TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ia_admin ON imprest_allocations(admin_id);
CREATE INDEX IF NOT EXISTS idx_ia_sub_admin ON imprest_allocations(sub_admin_id);
CREATE INDEX IF NOT EXISTS idx_ia_status ON imprest_allocations(status);

CREATE TRIGGER trg_imprest_allocations_updated_at
  BEFORE UPDATE ON imprest_allocations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- IMPREST LEDGER (every imprest balance movement)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS imprest_ledger (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                VARCHAR(30) NOT NULL
                        CHECK (type IN ('ALLOCATION', 'EXPENSE', 'ADJUSTMENT', 'REFUND')),
  reference_id        INTEGER,
  amount              NUMERIC(15,2) NOT NULL,
  balance_after       NUMERIC(15,2) NOT NULL DEFAULT 0,
  remarks             TEXT,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_il_user ON imprest_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_il_type ON imprest_ledger(type);
CREATE INDEX IF NOT EXISTS idx_il_created ON imprest_ledger(created_at);

-- ──────────────────────────────────────────────────────────────
-- IMPREST EXPENSE REQUESTS (overdraft approval workflow)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS imprest_expense_requests (
  id                  SERIAL PRIMARY KEY,
  sub_admin_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id             INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  amount              NUMERIC(15,2) NOT NULL,
  expense_data        JSONB NOT NULL,
  reason              TEXT,
  status              VARCHAR(30) NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reviewed_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMPTZ,
  review_remark       TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ier_sub_admin ON imprest_expense_requests(sub_admin_id);
CREATE INDEX IF NOT EXISTS idx_ier_status ON imprest_expense_requests(status);
CREATE INDEX IF NOT EXISTS idx_ier_site ON imprest_expense_requests(site_id);

CREATE TRIGGER trg_imprest_expense_requests_updated_at
  BEFORE UPDATE ON imprest_expense_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();