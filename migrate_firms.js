import 'dotenv/config';
import pool from './src/config/db.js';

const sql = `
CREATE TABLE IF NOT EXISTS firms (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  account_number  VARCHAR(50),
  bank_name       VARCHAR(255),
  ifsc_code       VARCHAR(20),
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(site_id, name)
);

CREATE INDEX IF NOT EXISTS idx_firms_site ON firms(site_id);

DROP TRIGGER IF EXISTS trg_firms_updated_at ON firms;
CREATE TRIGGER trg_firms_updated_at
  BEFORE UPDATE ON firms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS firm_transactions (
  id              SERIAL PRIMARY KEY,
  firm_id         INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  description     TEXT NOT NULL,
  debit           NUMERIC(15,2) NOT NULL DEFAULT 0,
  credit          NUMERIC(15,2) NOT NULL DEFAULT 0,
  name            VARCHAR(255),
  purpose         VARCHAR(500),
  remark          VARCHAR(100),
  cheque_no       VARCHAR(50),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ft_firm   ON firm_transactions(firm_id);
CREATE INDEX IF NOT EXISTS idx_ft_site   ON firm_transactions(site_id);
CREATE INDEX IF NOT EXISTS idx_ft_date   ON firm_transactions(date);
CREATE INDEX IF NOT EXISTS idx_ft_remark ON firm_transactions(remark);

DROP TRIGGER IF EXISTS trg_firm_transactions_updated_at ON firm_transactions;
CREATE TRIGGER trg_firm_transactions_updated_at
  BEFORE UPDATE ON firm_transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
`;

pool.query(sql)
  .then(() => { console.log('✓ firms + firm_transactions tables created'); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
