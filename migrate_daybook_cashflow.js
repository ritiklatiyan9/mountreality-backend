/**
 * Migration: Add cash_flow_entry_id to day_book table
 * and update the entry_type CHECK constraint to include 'CASH FLOW'.
 */
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const sslOption = process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
  ? { rejectUnauthorized: false }
  : false;

const pool = new pg.Pool({
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
    console.log('Starting migration: day_book ← cash_flow_entry_id ...');

    // 1. Add cash_flow_entry_id column
    await client.query(`
      ALTER TABLE day_book
      ADD COLUMN IF NOT EXISTS cash_flow_entry_id INTEGER REFERENCES cash_flow_entries(id) ON DELETE SET NULL
    `);
    console.log('  ✓ Added cash_flow_entry_id column');

    // 2. Drop old CHECK constraint and add new one with CASH FLOW
    await client.query(`ALTER TABLE day_book DROP CONSTRAINT IF EXISTS day_book_entry_type_check`);
    await client.query(`
      ALTER TABLE day_book ADD CONSTRAINT day_book_entry_type_check
        CHECK (entry_type IN (
          'GENERAL','EXPENSE','INCOME','PAYMENT','RECEIPT','TRANSFER',
          'ADJUSTMENT','OTHER','FARMER PAYMENT','PLOT COMMISSION','CASH FLOW'
        ))
    `);
    console.log('  ✓ Updated entry_type CHECK constraint (added CASH FLOW)');

    // 3. Index for FK lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_day_book_cash_flow_entry_id
      ON day_book(cash_flow_entry_id)
    `);
    console.log('  ✓ Created index on cash_flow_entry_id');

    console.log('Migration complete!');
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
