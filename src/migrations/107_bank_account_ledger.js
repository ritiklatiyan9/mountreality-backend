import pool from '../config/db.js';

const MIGRATION_KEY = '107_bank_account_ledger_v2';

const TRANSACTION_TABLES = [
  'day_book',
  'expenses',
  'farmer_payments',
  'cash_flow_entries',
  'firm_transactions',
  'plot_payments',
  'plot_installment_payments',
  'vendor_payments',
  'vendor_inventory_payments',
  'plot_commission_payments',
  'plot_commissions',
  'plot_registry_payments',
  'booking_refunds',
  'imprest_returns',
];

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_schema_migrations (
        version VARCHAR(160) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = await client.query(
      'SELECT 1 FROM app_schema_migrations WHERE version=$1',
      [MIGRATION_KEY],
    );
    if (applied.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    // The original table powered UPI QR collection. It is now the canonical
    // Site bank-account register as well, so VPA/payee data is optional for
    // accounts used only for NEFT/RTGS/cheque bookkeeping.
    await client.query('ALTER TABLE upi_accounts ALTER COLUMN payee_name DROP NOT NULL');
    await client.query('ALTER TABLE upi_accounts ALTER COLUMN vpa DROP NOT NULL');
    await client.query(`
      ALTER TABLE upi_accounts
        ADD COLUMN IF NOT EXISTS account_type VARCHAR(30),
        ADD COLUMN IF NOT EXISTS notes VARCHAR(500)
    `);

    for (const table of TRANSACTION_TABLES) {
      const exists = await client.query('SELECT to_regclass($1) AS relation', [`public.${table}`]);
      if (!exists.rows[0]?.relation) continue;
      await client.query(`
        ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS bank_account_id INTEGER
          REFERENCES upi_accounts(id) ON DELETE RESTRICT
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_${table}_bank_account_date
          ON ${table}(bank_account_id)
          WHERE bank_account_id IS NOT NULL
      `);
      const siteColumn = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name=$1 AND column_name='site_id'
         ) AS exists_col`,
        [table],
      );
      if (siteColumn.rows[0]?.exists_col) {
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_${table}_site_bank_account
            ON ${table}(site_id,bank_account_id)
            WHERE bank_account_id IS NOT NULL
        `);
      }
    }

    // New refunds post directly into Day Book for both cash and bank modes.
    // This avoids treating a reconciliation firm as the user's bank-account
    // register while retaining old firm_transaction_id links for history.
    if ((await client.query("SELECT to_regclass('public.booking_refunds') AS relation")).rows[0]?.relation) {
      await client.query('ALTER TABLE booking_refunds DROP CONSTRAINT IF EXISTS booking_refund_posting_chk');
      await client.query(`
        ALTER TABLE booking_refunds ADD CONSTRAINT booking_refund_posting_chk CHECK (
          status <> 'POSTED' OR (
            posted_at IS NOT NULL AND approved_by IS NOT NULL
            AND approved_at IS NOT NULL AND day_book_id IS NOT NULL
          )
        )
      `);
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_upi_accounts_site_active_name
        ON upi_accounts(site_id, is_active DESC, bank_name, label, id)
    `);
    await client.query(
      'INSERT INTO app_schema_migrations(version) VALUES($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: site bank accounts and transaction ledger mapping');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error('Migration 107_bank_account_ledger failed:', error.message);
  process.exit(1);
});
