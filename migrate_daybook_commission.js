/**
 * Migration: Add commission_id column to day_book table
 * and update the entry_type CHECK constraint to include 'PLOT COMMISSION'
 *
 * Run: node migrate_daybook_commission.js
 */
import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

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
    await client.query('BEGIN');

    // 1. Add commission_id column (if not exists)
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'day_book' AND column_name = 'commission_id'
    `);
    if (colCheck.rows.length === 0) {
      await client.query(`
        ALTER TABLE day_book
        ADD COLUMN commission_id INTEGER REFERENCES plot_commissions(id) ON DELETE SET NULL
      `);
      console.log('✅ Added commission_id column to day_book');
    } else {
      console.log('ℹ️  commission_id column already exists');
    }

    // 2. Drop existing entry_type CHECK constraint and recreate with 'PLOT COMMISSION'
    // Find the constraint name
    const conResult = await client.query(`
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'day_book'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%entry_type%'
    `);

    if (conResult.rows.length > 0) {
      const conName = conResult.rows[0].conname;
      await client.query(`ALTER TABLE day_book DROP CONSTRAINT "${conName}"`);
      console.log(`✅ Dropped old CHECK constraint: ${conName}`);
    }

    await client.query(`
      ALTER TABLE day_book
      ADD CONSTRAINT day_book_entry_type_check
      CHECK (entry_type IN ('GENERAL','EXPENSE','INCOME','PAYMENT','RECEIPT','TRANSFER','ADJUSTMENT','OTHER','FARMER PAYMENT','PLOT COMMISSION'))
    `);
    console.log('✅ Added updated entry_type CHECK with PLOT COMMISSION');

    // 3. Add index for commission_id lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_day_book_commission_id ON day_book(commission_id)
    `);
    console.log('✅ Added index on commission_id');

    await client.query('COMMIT');
    console.log('\n🎉 Migration completed successfully!');
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
