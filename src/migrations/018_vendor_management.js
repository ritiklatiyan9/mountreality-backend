import pool from '../config/db.js';

export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS vendor_heads (
        id SERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        name VARCHAR(120) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_heads_site_name
      ON vendor_heads(site_id, name)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vendor_commitments (
        id SERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        vendor_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
        vendor_name VARCHAR(200) NOT NULL,
        head_id INTEGER REFERENCES vendor_heads(id) ON DELETE SET NULL,
        head_name VARCHAR(120),
        work_title VARCHAR(220) NOT NULL,
        contract_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (contract_amount >= 0),
        start_date DATE,
        due_date DATE,
        note TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_commitments_site_id
      ON vendor_commitments(site_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_commitments_vendor_member_id
      ON vendor_commitments(vendor_member_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vendor_payments (
        id SERIAL PRIMARY KEY,
        commitment_id INTEGER NOT NULL REFERENCES vendor_commitments(id) ON DELETE CASCADE,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        payment_date DATE NOT NULL,
        amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
        payment_mode VARCHAR(20) NOT NULL DEFAULT 'cash' CHECK (payment_mode IN ('cash', 'bank', 'upi', 'cheque', 'neft', 'rtgs', 'imps', 'other')),
        reference_no VARCHAR(120),
        note TEXT,
        voucher_url TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_commitment_id
      ON vendor_payments(commitment_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_site_id
      ON vendor_payments(site_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_payments_date
      ON vendor_payments(payment_date)
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 018 complete: vendor management tables created.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 018 failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

export const down = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DROP TABLE IF EXISTS vendor_payments');
    await client.query('DROP TABLE IF EXISTS vendor_commitments');
    await client.query('DROP TABLE IF EXISTS vendor_heads');

    await client.query('COMMIT');
    console.log('✅ Migration 018 rollback complete.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 018 rollback failed:', error);
    throw error;
  } finally {
    client.release();
  }
};
