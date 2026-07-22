import pool from '../config/db.js';

// Creates day_book_daily_balance — per-site per-date opening & closing balance snapshot.
//   opening_balance: locked once set (start-of-day position)
//   closing_balance: continuously updated as entries for that day change
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS day_book_daily_balance (
        id SERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
        closing_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(site_id, date)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dbdb_site_date
      ON day_book_daily_balance(site_id, date DESC)
    `);

    await client.query('COMMIT');
    console.log('Migration 048_daybook_daily_balance complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 048_daybook_daily_balance failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
