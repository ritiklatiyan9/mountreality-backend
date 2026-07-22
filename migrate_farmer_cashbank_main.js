import pg from 'pg';
const { Pool } = pg;
import 'dotenv/config';

const sslOption = process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : '',
  ssl: sslOption,
});

async function migrate() {
  const client = await pool.connect();
  try {
    // Add payment_mode, cash_amount, bank_amount, bank details to farmers table
    await client.query(`
      ALTER TABLE farmers
        ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(10) DEFAULT 'CASH',
        ADD COLUMN IF NOT EXISTS cash_amount NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS bank_amount NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS bank_account_no VARCHAR(50),
        ADD COLUMN IF NOT EXISTS bank_reference VARCHAR(100),
        ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(20)
    `);
    console.log('✓ Added payment_mode, cash/bank amount and bank detail columns to farmers table');

    // Backfill: set cash_amount = total_amount for existing farmers
    await client.query(`
      UPDATE farmers SET payment_mode = 'CASH', cash_amount = total_amount WHERE payment_mode IS NULL OR cash_amount = 0
    `);
    console.log('✓ Backfilled existing farmers with CASH mode');

    console.log('\n✅ Migration complete!');
  } catch (err) {
    console.error('Migration failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
