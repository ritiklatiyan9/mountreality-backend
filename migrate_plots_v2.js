/**
 * Migration: Add new fields to plots and plot_payments tables
 * 
 * plots table:
 *   - registry_area   (NUMERIC 10,2): Circle/registry area
 *   - circle_rate     (NUMERIC 15,2): Government circle rate
 *   - to_receive_bank (NUMERIC 15,2): Amount to be received in bank
 *   - first_installment (NUMERIC 15,2): Expected first installment
 *
 * plot_payments table:
 *   - payment_type    (VARCHAR 20): 'BANK' or 'CASH' (default CASH)
 */

import 'dotenv/config';
import pool from './src/config/db.js';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Adding new columns to plots table...');

    // Add registry_area column
    await client.query(`
      ALTER TABLE plots 
      ADD COLUMN IF NOT EXISTS registry_area NUMERIC(10,2) DEFAULT 0
    `);
    console.log('  ✓ registry_area');

    // Add circle_rate column
    await client.query(`
      ALTER TABLE plots 
      ADD COLUMN IF NOT EXISTS circle_rate NUMERIC(15,2) DEFAULT 0
    `);
    console.log('  ✓ circle_rate');

    // Add to_receive_bank column
    await client.query(`
      ALTER TABLE plots 
      ADD COLUMN IF NOT EXISTS to_receive_bank NUMERIC(15,2) DEFAULT 0
    `);
    console.log('  ✓ to_receive_bank');

    // Add first_installment column
    await client.query(`
      ALTER TABLE plots 
      ADD COLUMN IF NOT EXISTS first_installment NUMERIC(15,2) DEFAULT 0
    `);
    console.log('  ✓ first_installment');

    console.log('\nAdding payment_type column to plot_payments table...');

    // Add payment_type column with default CASH
    await client.query(`
      ALTER TABLE plot_payments 
      ADD COLUMN IF NOT EXISTS payment_type VARCHAR(20) DEFAULT 'CASH'
    `);
    console.log('  ✓ payment_type (default: CASH)');

    // Add check constraint for payment_type
    // First check if constraint exists
    const constraintCheck = await client.query(`
      SELECT 1 FROM information_schema.check_constraints 
      WHERE constraint_name = 'plot_payments_payment_type_check'
    `);
    if (constraintCheck.rows.length === 0) {
      await client.query(`
        ALTER TABLE plot_payments 
        ADD CONSTRAINT plot_payments_payment_type_check 
        CHECK (payment_type IN ('BANK', 'CASH'))
      `);
      console.log('  ✓ payment_type CHECK constraint added');
    } else {
      console.log('  ✓ payment_type CHECK constraint already exists');
    }

    await client.query('COMMIT');
    console.log('\n✅ Migration completed successfully!');
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
