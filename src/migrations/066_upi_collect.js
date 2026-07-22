import pool from '../config/db.js';

/**
 * Migration: UPI Collect module
 * - upi_accounts: bank accounts with their VPA (UPI ID) used to receive money
 * - payment_qrs: log of every dynamic QR generated (amount-locked UPI QR),
 *   also the data source for the outside-office QR display screen.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS upi_accounts (
        id SERIAL PRIMARY KEY,
        site_id INT NOT NULL REFERENCES sites(id),
        label VARCHAR(100) NOT NULL,
        payee_name VARCHAR(100) NOT NULL,
        vpa VARCHAR(100) NOT NULL,
        bank_name VARCHAR(100),
        account_no VARCHAR(50),
        ifsc VARCHAR(20),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_by INT REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_qrs (
        id SERIAL PRIMARY KEY,
        site_id INT NOT NULL REFERENCES sites(id),
        upi_account_id INT NOT NULL REFERENCES upi_accounts(id),
        amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        note VARCHAR(120),
        txn_ref VARCHAR(40) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        received_at TIMESTAMPTZ,
        created_by INT REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_upi_accounts_site ON upi_accounts(site_id, is_active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payment_qrs_site_status ON payment_qrs(site_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payment_qrs_created ON payment_qrs(created_at DESC)`);

    await client.query('COMMIT');
    console.log('✅ Migration 066 complete: upi_accounts + payment_qrs tables.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 066 failed (rolled back, no changes):', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
