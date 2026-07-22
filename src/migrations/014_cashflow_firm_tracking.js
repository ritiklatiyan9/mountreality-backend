import pool from '../config/db.js';

export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE cash_flow_entries
        ADD COLUMN IF NOT EXISTS is_firm_transaction BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS from_firm_id INTEGER REFERENCES firms(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS to_firm_id INTEGER REFERENCES firms(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS to_name VARCHAR(255)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfe_from_firm_id ON cash_flow_entries(from_firm_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfe_to_firm_id ON cash_flow_entries(to_firm_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfe_is_firm_transaction ON cash_flow_entries(is_firm_transaction)
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 014 complete: cashflow firm tracking columns added.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 014 failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

export const down = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DROP INDEX IF EXISTS idx_cfe_is_firm_transaction');
    await client.query('DROP INDEX IF EXISTS idx_cfe_to_firm_id');
    await client.query('DROP INDEX IF EXISTS idx_cfe_from_firm_id');

    await client.query(`
      ALTER TABLE cash_flow_entries
        DROP COLUMN IF EXISTS to_name,
        DROP COLUMN IF EXISTS to_firm_id,
        DROP COLUMN IF EXISTS from_firm_id,
        DROP COLUMN IF EXISTS is_firm_transaction
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 014 rollback complete.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 014 rollback failed:', error);
    throw error;
  } finally {
    client.release();
  }
};
