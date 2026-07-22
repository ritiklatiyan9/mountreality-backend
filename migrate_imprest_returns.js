/**
 * Migration: Add imprest_returns table for sub-admin → admin money return workflow
 *
 * Flow:
 *   1. Sub-admin initiates a return (PENDING)
 *   2. Admin reviews and accepts (ACCEPTED → ledger REFUND deduction + day_book entry)
 *      or rejects (REJECTED → no balance change)
 */
import pool from './src/config/db.js';

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create imprest_returns table
    await client.query(`
      CREATE TABLE IF NOT EXISTS imprest_returns (
        id                SERIAL PRIMARY KEY,
        sub_admin_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount            NUMERIC(15,2) NOT NULL,
        reason            TEXT,
        payment_mode      VARCHAR(30) DEFAULT 'CASH',
        status            VARCHAR(30) NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
        reviewed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at       TIMESTAMPTZ,
        review_remark     TEXT,
        site_id           INTEGER REFERENCES sites(id) ON DELETE SET NULL,
        assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ir_sub_admin ON imprest_returns(sub_admin_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ir_status ON imprest_returns(status);`);

    // Auto-update trigger
    await client.query(`
      CREATE TRIGGER trg_imprest_returns_updated_at
        BEFORE UPDATE ON imprest_returns
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `).catch(() => { /* trigger may already exist */ });

    await client.query('COMMIT');
    console.log('✅ imprest_returns table created successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
};

migrate();
