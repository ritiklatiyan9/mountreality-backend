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
  console.log('── Farmer Payment Cash/Bank Split Migration ──');

  // 1. Add payment_mode column (CASH, BANK, SPLIT)
  await pool.query(`
    ALTER TABLE farmer_payments
    ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20) DEFAULT 'CASH'
  `);
  console.log('✓ Added payment_mode column');

  // 2. Add cash_amount and bank_amount columns
  await pool.query(`
    ALTER TABLE farmer_payments
    ADD COLUMN IF NOT EXISTS cash_amount NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS bank_amount NUMERIC(15,2) DEFAULT 0
  `);
  console.log('✓ Added cash_amount and bank_amount columns');

  // 3. Add bank detail columns
  await pool.query(`
    ALTER TABLE farmer_payments
    ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS bank_account_no VARCHAR(100),
    ADD COLUMN IF NOT EXISTS bank_reference VARCHAR(255),
    ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(20)
  `);
  console.log('✓ Added bank detail columns');

  // 4. Add member_id column to farmers table (link to members)
  await pool.query(`
    ALTER TABLE farmers
    ADD COLUMN IF NOT EXISTS member_id INTEGER REFERENCES members(id) ON DELETE SET NULL
  `);
  console.log('✓ Added member_id column to farmers table');

  // 5. Backfill existing farmer_payments: set payment_mode based on particular, cash_amount = amount
  await pool.query(`
    UPDATE farmer_payments
    SET payment_mode = CASE
      WHEN particular IN ('RTGS', 'NEFT', 'UPI', 'BANK TRANSFER', 'CHEQUE') THEN 'BANK'
      ELSE 'CASH'
    END,
    cash_amount = CASE
      WHEN particular IN ('RTGS', 'NEFT', 'UPI', 'BANK TRANSFER', 'CHEQUE') THEN 0
      ELSE amount
    END,
    bank_amount = CASE
      WHEN particular IN ('RTGS', 'NEFT', 'UPI', 'BANK TRANSFER', 'CHEQUE') THEN amount
      ELSE 0
    END
    WHERE payment_mode IS NULL OR payment_mode = 'CASH'
  `);
  console.log('✓ Backfilled existing payments with payment_mode and amounts');

  console.log('\n✅ Migration complete!');
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  pool.end();
  process.exit(1);
});
