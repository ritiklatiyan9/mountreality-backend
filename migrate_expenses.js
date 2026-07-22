import 'dotenv/config';
import pool from './src/config/db.js';

const sql = `
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
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exp_site    ON expenses(site_id);
CREATE INDEX IF NOT EXISTS idx_exp_date    ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_exp_mode    ON expenses(payment_mode);
CREATE INDEX IF NOT EXISTS idx_exp_category ON expenses(category);

-- Trigger
CREATE OR REPLACE TRIGGER trg_expenses_updated_at
  BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
`;

(async () => {
  try {
    await pool.query(sql);
    console.log('✓ expenses table created');
    process.exit(0);
  } catch (err) {
    console.error('✕ migration failed:', err.message);
    process.exit(1);
  }
})();
