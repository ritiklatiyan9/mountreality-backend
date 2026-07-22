/**
 * Migration: Add plot_size, plot_rate, father_name columns to plot_commissions table
 *
 * Run: node migrate_commission_fields.js
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

    // 1. Add plot_size column
    const col1 = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'plot_commissions' AND column_name = 'plot_size'
    `);
    if (col1.rows.length === 0) {
      await client.query(`ALTER TABLE plot_commissions ADD COLUMN plot_size VARCHAR(50)`);
      console.log('✅ Added plot_size column');
    } else {
      console.log('ℹ️  plot_size already exists');
    }

    // 2. Add plot_rate column
    const col2 = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'plot_commissions' AND column_name = 'plot_rate'
    `);
    if (col2.rows.length === 0) {
      await client.query(`ALTER TABLE plot_commissions ADD COLUMN plot_rate VARCHAR(50)`);
      console.log('✅ Added plot_rate column');
    } else {
      console.log('ℹ️  plot_rate already exists');
    }

    // 3. Add father_name column
    const col3 = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'plot_commissions' AND column_name = 'father_name'
    `);
    if (col3.rows.length === 0) {
      await client.query(`ALTER TABLE plot_commissions ADD COLUMN father_name VARCHAR(255)`);
      console.log('✅ Added father_name column');
    } else {
      console.log('ℹ️  father_name already exists');
    }

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
