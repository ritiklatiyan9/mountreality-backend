/**
 * Migration: Add firm_transaction_id FK to day_book table
 * + Update CHECK constraint to include 'FIRM TRANSACTION'
 *
 * Run: node migrate_daybook_firm.js
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
    await client.query('BEGIN');

    // 1. Add firm_transaction_id column (nullable FK)
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'day_book' AND column_name = 'firm_transaction_id'
    `);
    if (colCheck.rows.length === 0) {
      await client.query(`
        ALTER TABLE day_book
        ADD COLUMN firm_transaction_id INTEGER REFERENCES firm_transactions(id) ON DELETE SET NULL
      `);
      console.log('✅ Added firm_transaction_id column to day_book');
    } else {
      console.log('ℹ️  firm_transaction_id column already exists');
    }

    // 2. Create index
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_day_book_firm_transaction_id ON day_book(firm_transaction_id)
    `);
    console.log('✅ Index idx_day_book_firm_transaction_id created');

    // 3. Drop old CHECK constraint and recreate with 'FIRM TRANSACTION'
    // Find and drop existing entry_type check constraint
    const constraintRes = await client.query(`
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'day_book'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%entry_type%'
    `);

    for (const row of constraintRes.rows) {
      await client.query(`ALTER TABLE day_book DROP CONSTRAINT "${row.conname}"`);
      console.log(`✅ Dropped old CHECK constraint: ${row.conname}`);
    }

    // Add new CHECK constraint with FIRM TRANSACTION
    await client.query(`
      ALTER TABLE day_book ADD CONSTRAINT day_book_entry_type_check
      CHECK (entry_type IN (
        'GENERAL','EXPENSE','INCOME','PAYMENT','RECEIPT','TRANSFER','ADJUSTMENT','OTHER',
        'FARMER PAYMENT','PLOT COMMISSION','CASH FLOW','FIRM TRANSACTION'
      ))
    `);
    console.log('✅ Added CHECK constraint with FIRM TRANSACTION');

    await client.query('COMMIT');
    console.log('\n🎉 Migration complete!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(() => process.exit(1));
