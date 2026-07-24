import pool from '../config/db.js';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // land_size_unit: which unit land_size_bigha's raw number is measured in
    // ('BIGHA' | 'YARD' | 'SQMT'). Existing rows default to BIGHA, matching
    // the column's original (unit-less) meaning.
    // commission_paid_to_broker: manually-entered amount actually disbursed
    // to the broker — independent of the auto-calculated commission_amount.
    await client.query(`
      ALTER TABLE farmers
        ADD COLUMN IF NOT EXISTS land_size_unit VARCHAR(10) NOT NULL DEFAULT 'BIGHA',
        ADD COLUMN IF NOT EXISTS commission_paid_to_broker NUMERIC(15,2) DEFAULT NULL;
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 085: Added land_size_unit, commission_paid_to_broker to farmers');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 085 failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
