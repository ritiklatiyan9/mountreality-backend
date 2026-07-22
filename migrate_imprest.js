/**
 * Migration: Create Imprest Management tables
 * Run: node migrate_imprest.js
 */
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config();

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

    // ── 1. IMPREST ALLOCATIONS ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS imprest_allocations (
        id                  SERIAL PRIMARY KEY,
        admin_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sub_admin_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount              NUMERIC(15,2) NOT NULL,
        remark              TEXT,
        status              VARCHAR(30) NOT NULL DEFAULT 'PENDING_RECEIPT'
                              CHECK (status IN ('PENDING_RECEIPT', 'RECEIVED', 'CANCELLED')),
        confirmation_remark TEXT,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        confirmed_at        TIMESTAMPTZ,
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_ia_admin ON imprest_allocations(admin_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ia_sub_admin ON imprest_allocations(sub_admin_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ia_status ON imprest_allocations(status);`);

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_imprest_allocations_updated_at') THEN
          CREATE TRIGGER trg_imprest_allocations_updated_at
            BEFORE UPDATE ON imprest_allocations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END $$;
    `);

    // ── 2. IMPREST LEDGER ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS imprest_ledger (
        id                  SERIAL PRIMARY KEY,
        user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type                VARCHAR(30) NOT NULL
                              CHECK (type IN ('ALLOCATION', 'EXPENSE', 'ADJUSTMENT', 'REFUND')),
        reference_id        INTEGER,
        amount              NUMERIC(15,2) NOT NULL,
        balance_after       NUMERIC(15,2) NOT NULL DEFAULT 0,
        remarks             TEXT,
        created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at          TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_il_user ON imprest_ledger(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_il_type ON imprest_ledger(type);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_il_created ON imprest_ledger(created_at);`);

    // ── 3. Add imprest_allocation_id to day_book for linking ──
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'day_book' AND column_name = 'imprest_allocation_id'
    `);
    if (colCheck.rows.length === 0) {
      await client.query(`
        ALTER TABLE day_book ADD COLUMN imprest_allocation_id INTEGER REFERENCES imprest_allocations(id) ON DELETE SET NULL;
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_day_book_imprest_alloc ON day_book(imprest_allocation_id);`);
    }

    // ── 4. Add 'IMPREST' to day_book entry_type CHECK constraint ──
    // We need to drop & re-add the CHECK since PG doesn't support ALTER CHECK
    await client.query(`ALTER TABLE day_book DROP CONSTRAINT IF EXISTS day_book_entry_type_check;`);
    await client.query(`
      ALTER TABLE day_book ADD CONSTRAINT day_book_entry_type_check
      CHECK (entry_type IN (
        'GENERAL','EXPENSE','INCOME','PAYMENT','RECEIPT','TRANSFER','ADJUSTMENT','OTHER',
        'FARMER PAYMENT','PLOT COMMISSION','CASH FLOW','FIRM TRANSACTION','PLOT PAYMENT',
        'IMPREST'
      ));
    `);

    // ── 5. Add imprest_expense_request table for overdraft requests ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS imprest_expense_requests (
        id                  SERIAL PRIMARY KEY,
        sub_admin_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        site_id             INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        amount              NUMERIC(15,2) NOT NULL,
        expense_data        JSONB NOT NULL,
        reason              TEXT,
        status              VARCHAR(30) NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
        reviewed_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at         TIMESTAMPTZ,
        review_remark       TEXT,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_ier_sub_admin ON imprest_expense_requests(sub_admin_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ier_status ON imprest_expense_requests(status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ier_site ON imprest_expense_requests(site_id);`);

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_imprest_expense_requests_updated_at') THEN
          CREATE TRIGGER trg_imprest_expense_requests_updated_at
            BEFORE UPDATE ON imprest_expense_requests
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END $$;
    `);

    await client.query('COMMIT');
    console.log('✅ Imprest migration completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(() => process.exit(1));
