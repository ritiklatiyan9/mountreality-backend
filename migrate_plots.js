import 'dotenv/config';
import pool from './src/config/db.js';

const sql = `
CREATE TABLE IF NOT EXISTS plots (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  plot_no         VARCHAR(20) NOT NULL,
  block           VARCHAR(10),
  buyer_name      VARCHAR(255),
  plot_size       NUMERIC(10,2),
  plot_rate       NUMERIC(15,2),
  sale_price      NUMERIC(15,2) NOT NULL DEFAULT 0,
  booking_by      VARCHAR(255),
  booking_date    DATE,
  status          VARCHAR(50) DEFAULT 'BOOKED',
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(site_id, plot_no)
);

CREATE INDEX IF NOT EXISTS idx_plots_site ON plots(site_id);
CREATE INDEX IF NOT EXISTS idx_plots_status ON plots(status);
CREATE INDEX IF NOT EXISTS idx_plots_plot_no ON plots(plot_no);

CREATE TABLE IF NOT EXISTS plot_payments (
  id              SERIAL PRIMARY KEY,
  plot_id         INTEGER NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_from    VARCHAR(100),
  bank_name       VARCHAR(150),
  branch          VARCHAR(150),
  bank_details    VARCHAR(255),
  narration       TEXT,
  received_by     VARCHAR(255),
  amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pp_plot ON plot_payments(plot_id);
CREATE INDEX IF NOT EXISTS idx_pp_site ON plot_payments(site_id);
CREATE INDEX IF NOT EXISTS idx_pp_date ON plot_payments(date);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plots_updated_at') THEN
    CREATE TRIGGER trg_plots_updated_at BEFORE UPDATE ON plots FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plot_payments_updated_at') THEN
    CREATE TRIGGER trg_plot_payments_updated_at BEFORE UPDATE ON plot_payments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
`;

pool.query(sql)
  .then(() => { console.log('✓ plots + plot_payments tables created'); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
