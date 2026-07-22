/**
 * Migration: Add plot_payment_id FK to day_book table
 * + Update CHECK constraint to include 'PLOT PAYMENT'
 *
 * Run: node migrate_daybook_plot_payment.js
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

    // 1. Add plot_payment_id column (nullable FK)
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'day_book' AND column_name = 'plot_payment_id'
    `);
    if (colCheck.rows.length === 0) {
      await client.query(`
        ALTER TABLE day_book
        ADD COLUMN plot_payment_id INTEGER REFERENCES plot_payments(id) ON DELETE SET NULL
      `);
      console.log('Added plot_payment_id column to day_book');
    } else {
      console.log('plot_payment_id column already exists');
    }

    // 2. Create index
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_day_book_plot_payment_id ON day_book(plot_payment_id)
    `);
    console.log('Created index idx_day_book_plot_payment_id');

    // 3. Drop old CHECK constraint and add new one with 'PLOT PAYMENT'
    // Find and drop existing check constraint on entry_type
    const constraintQuery = await client.query(`
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_attribute att ON att.attnum = ANY(con.conkey) AND att.attrelid = con.conrelid
      WHERE con.conrelid = 'day_book'::regclass
        AND con.contype = 'c'
        AND att.attname = 'entry_type'
    `);

    for (const row of constraintQuery.rows) {
      await client.query(`ALTER TABLE day_book DROP CONSTRAINT "${row.conname}"`);
      console.log(`Dropped constraint: ${row.conname}`);
    }

    // Add updated CHECK constraint including 'PLOT PAYMENT'
    await client.query(`
      ALTER TABLE day_book
      ADD CONSTRAINT day_book_entry_type_check
      CHECK (entry_type IN ('GENERAL','EXPENSE','INCOME','PAYMENT','RECEIPT','TRANSFER','ADJUSTMENT','OTHER','FARMER PAYMENT','PLOT COMMISSION','CASH FLOW','FIRM TRANSACTION','PLOT PAYMENT'))
    `);
    console.log('Added updated CHECK constraint with PLOT PAYMENT');

    await client.query('COMMIT');
    console.log('Migration completed successfully!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(() => process.exit(1));
