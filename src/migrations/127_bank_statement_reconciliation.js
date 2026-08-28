import pool from '../config/db.js';

const MIGRATION_KEY = '127_bank_statement_reconciliation_v1';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.app_schema_migrations (
        version VARCHAR(160) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = await client.query(
      'SELECT 1 FROM public.app_schema_migrations WHERE version=$1',
      [MIGRATION_KEY],
    );
    if (applied.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.bank_reconciliations (
        id BIGSERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL REFERENCES public.sites(id) ON DELETE RESTRICT,
        bank_account_id INTEGER NOT NULL REFERENCES public.upi_accounts(id) ON DELETE RESTRICT,
        statement_month DATE NOT NULL,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        file_name VARCHAR(255),
        opening_balance NUMERIC(16,2) NOT NULL DEFAULT 0,
        closing_balance NUMERIC(16,2),
        statement_total_debit NUMERIC(16,2) NOT NULL DEFAULT 0,
        statement_total_credit NUMERIC(16,2) NOT NULL DEFAULT 0,
        status VARCHAR(24) NOT NULL DEFAULT 'IN_PROGRESS',
        notes VARCHAR(1000),
        uploaded_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
        closed_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
        closed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT bank_reconciliation_period_chk CHECK (period_end >= period_start),
        CONSTRAINT bank_reconciliation_month_chk CHECK (statement_month = DATE_TRUNC('month', statement_month)::date),
        CONSTRAINT bank_reconciliation_status_chk CHECK (status IN ('IN_PROGRESS','READY','CLOSED')),
        CONSTRAINT bank_reconciliation_account_month_uq UNIQUE(bank_account_id, statement_month)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.bank_statement_lines (
        id BIGSERIAL PRIMARY KEY,
        reconciliation_id BIGINT NOT NULL REFERENCES public.bank_reconciliations(id) ON DELETE CASCADE,
        site_id INTEGER NOT NULL REFERENCES public.sites(id) ON DELETE RESTRICT,
        bank_account_id INTEGER NOT NULL REFERENCES public.upi_accounts(id) ON DELETE RESTRICT,
        row_number INTEGER NOT NULL,
        transaction_date DATE NOT NULL,
        value_date DATE,
        description VARCHAR(500) NOT NULL,
        reference VARCHAR(180),
        debit NUMERIC(16,2) NOT NULL DEFAULT 0,
        credit NUMERIC(16,2) NOT NULL DEFAULT 0,
        running_balance NUMERIC(16,2),
        match_status VARCHAR(24) NOT NULL DEFAULT 'UNMATCHED',
        matched_source VARCHAR(60),
        matched_source_id BIGINT,
        match_confidence INTEGER,
        match_note VARCHAR(500),
        matched_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
        matched_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT bank_statement_line_amount_chk CHECK (debit >= 0 AND credit >= 0 AND NOT (debit > 0 AND credit > 0)),
        CONSTRAINT bank_statement_line_status_chk CHECK (match_status IN ('UNMATCHED','SUGGESTED','MATCHED','IGNORED')),
        CONSTRAINT bank_statement_line_confidence_chk CHECK (match_confidence IS NULL OR match_confidence BETWEEN 0 AND 100),
        CONSTRAINT bank_statement_line_row_uq UNIQUE(reconciliation_id, row_number)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_account_month
        ON public.bank_reconciliations(bank_account_id, statement_month DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_reconciliation_status
        ON public.bank_statement_lines(reconciliation_id, match_status, transaction_date, id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_account_date
        ON public.bank_statement_lines(bank_account_id, transaction_date, debit, credit)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_statement_matched_ledger_transaction
        ON public.bank_statement_lines(bank_account_id, matched_source, matched_source_id)
        WHERE match_status='MATCHED' AND matched_source IS NOT NULL AND matched_source_id IS NOT NULL
    `);

    await client.query(
      'INSERT INTO public.app_schema_migrations(version) VALUES($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('✓ Migration applied: persistent bank statement reconciliation');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error('Migration 127_bank_statement_reconciliation failed:', error.message);
  process.exit(1);
});
