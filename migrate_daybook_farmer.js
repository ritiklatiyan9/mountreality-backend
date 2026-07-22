import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD || ''),
  ssl: process.env.DB_HOST && process.env.DB_HOST.includes('neon') ? { rejectUnauthorized: false } : false,
});

async function run() {
  // 1. Add farmer_payment_id column if not exists
  await pool.query(
    `ALTER TABLE day_book ADD COLUMN IF NOT EXISTS farmer_payment_id INTEGER REFERENCES farmer_payments(id) ON DELETE SET NULL`
  );
  console.log('✓ Added farmer_payment_id column');

  // 2. Drop old CHECK constraint and add new one with FARMER PAYMENT
  try {
    await pool.query(`ALTER TABLE day_book DROP CONSTRAINT IF EXISTS day_book_entry_type_check`);
    console.log('✓ Dropped old check constraint');
  } catch (e) {
    console.log('  No old check constraint to drop:', e.message);
  }

  await pool.query(
    `ALTER TABLE day_book ADD CONSTRAINT day_book_entry_type_check CHECK (entry_type IN ('GENERAL','EXPENSE','INCOME','PAYMENT','RECEIPT','TRANSFER','ADJUSTMENT','OTHER','FARMER PAYMENT'))`
  );
  console.log('✓ Added new check constraint with FARMER PAYMENT');

  // 3. Add index on farmer_payment_id
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_day_book_farmer_payment ON day_book(farmer_payment_id)`
  );
  console.log('✓ Added farmer_payment_id index');

  // 4. Add index on farmer_payments for site-date lookups (via farmers join)
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_farmer_payments_date ON farmer_payments(date)`
  );
  console.log('✓ Added farmer_payments date index');

  await pool.end();
  console.log('\nDone! Day Book ↔ Farmer Payments integration migration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
