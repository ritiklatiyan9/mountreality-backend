import 'dotenv/config';
import pool from './src/config/db.js';

try {
  // Create day_book table with INTEGER FKs to match sites.id and users.id
  await pool.query(`
    CREATE TABLE IF NOT EXISTS day_book (
      id              SERIAL PRIMARY KEY,
      site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      date            DATE NOT NULL DEFAULT CURRENT_DATE,
      particular      VARCHAR(500) NOT NULL,
      entry_type      VARCHAR(50) NOT NULL DEFAULT 'GENERAL'
                        CHECK (entry_type IN ('GENERAL','EXPENSE','INCOME','PAYMENT','RECEIPT','TRANSFER','ADJUSTMENT','OTHER')),
      debit           NUMERIC(15,2) NOT NULL DEFAULT 0,
      credit          NUMERIC(15,2) NOT NULL DEFAULT 0,
      remarks         TEXT,
      payment_mode    VARCHAR(50),
      category        VARCHAR(100),
      from_entity     VARCHAR(255),
      to_entity       VARCHAR(255),
      account_no      VARCHAR(100),
      branch          VARCHAR(255),
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_day_book_site ON day_book(site_id);
    CREATE INDEX IF NOT EXISTS idx_day_book_date ON day_book(date);
    CREATE INDEX IF NOT EXISTS idx_day_book_type ON day_book(entry_type);
    CREATE INDEX IF NOT EXISTS idx_day_book_site_date ON day_book(site_id, date);
  `);
  console.log('day_book table CREATED successfully!');

  // Add trigger if possible
  try {
    await pool.query(`
      CREATE TRIGGER trg_day_book_updated_at
        BEFORE UPDATE ON day_book
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `);
    console.log('\nTrigger added!');
  } catch (te) {
    console.log('\nTrigger note:', te.message);
  }
} catch (e) {
  console.log('ERROR:', e.message);
}
process.exit();
