import pool from '../config/db.js';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add land and commission fields to farmers table
    await client.query(`
      ALTER TABLE farmers
        ADD COLUMN IF NOT EXISTS land_size_bigha   NUMERIC(10,2) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS land_rate         NUMERIC(15,2) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS commission_percentage NUMERIC(5,2) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS commission_amount NUMERIC(15,2) DEFAULT NULL;
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 046: Added land_size_bigha, land_rate, commission_percentage, commission_amount to farmers');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 046 failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
