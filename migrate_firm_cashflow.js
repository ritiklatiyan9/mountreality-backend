/**
 * Migration: Integrate firm_transactions ↔ cash_flow_entries
 * Adds cash_flow_entry_id FK to firm_transactions
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

    // 1. Add cash_flow_entry_id column to firm_transactions
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'firm_transactions' AND column_name = 'cash_flow_entry_id'
    `);
    if (colCheck.rows.length === 0) {
      console.log('Adding cash_flow_entry_id column to firm_transactions...');
      await client.query(`
        ALTER TABLE firm_transactions
        ADD COLUMN cash_flow_entry_id INTEGER REFERENCES cash_flow_entries(id) ON DELETE SET NULL
      `);
      console.log('✅ Column added');
    } else {
      console.log('⏩ cash_flow_entry_id column already exists');
    }

    // 2. Add index for the FK
    const idxCheck = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'firm_transactions' AND indexname = 'idx_ft_cash_flow_entry_id'
    `);
    if (idxCheck.rows.length === 0) {
      console.log('Creating index idx_ft_cash_flow_entry_id...');
      await client.query(`
        CREATE INDEX idx_ft_cash_flow_entry_id ON firm_transactions(cash_flow_entry_id)
      `);
      console.log('✅ Index created');
    } else {
      console.log('⏩ Index already exists');
    }

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
