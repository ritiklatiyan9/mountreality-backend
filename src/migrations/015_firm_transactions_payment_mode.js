import pool from '../config/db.js';

export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE firm_transactions
      ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20) NOT NULL DEFAULT 'cash'
    `);

    await client.query(`
      ALTER TABLE firm_transactions
      DROP CONSTRAINT IF EXISTS firm_transactions_payment_mode_check
    `);

    await client.query(`
      ALTER TABLE firm_transactions
      ADD CONSTRAINT firm_transactions_payment_mode_check
      CHECK (payment_mode IN ('cash', 'bank'))
    `);

    // Sensible backfill for existing data.
    await client.query(`
      UPDATE firm_transactions
      SET payment_mode = CASE
        WHEN cheque_no IS NOT NULL AND TRIM(cheque_no) <> '' THEN 'bank'
        ELSE 'cash'
      END
      WHERE payment_mode IS NULL OR payment_mode NOT IN ('cash', 'bank')
    `);

    // If linked with cashflow, align with cashflow cash_type where available.
    await client.query(`
      UPDATE firm_transactions ft
      SET payment_mode = cfe.cash_type
      FROM cash_flow_entries cfe
      WHERE ft.cash_flow_entry_id = cfe.id
        AND cfe.cash_type IN ('cash', 'bank')
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ft_payment_mode ON firm_transactions(payment_mode)
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 015 complete: payment_mode added to firm_transactions.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 015 failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

export const down = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DROP INDEX IF EXISTS idx_ft_payment_mode');

    await client.query(`
      ALTER TABLE firm_transactions
      DROP CONSTRAINT IF EXISTS firm_transactions_payment_mode_check
    `);

    await client.query(`
      ALTER TABLE firm_transactions
      DROP COLUMN IF EXISTS payment_mode
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 015 rollback complete.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 015 rollback failed:', error);
    throw error;
  } finally {
    client.release();
  }
};
