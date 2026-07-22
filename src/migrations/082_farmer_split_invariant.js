import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 082 — make farmer SPLIT payments an exact Cash/Bank partition.
 *
 * `amount` remains the authoritative financial value. Existing malformed split
 * rows keep their intended cash/bank ratio where possible, but are scaled so
 * the two legs add up exactly to amount. A blank split falls back to Bank,
 * matching ledger_bucket(). Negative legacy reversals are preserved as Bank
 * rows because a negative split cannot have non-negative component legs.
 */

const MIGRATION_KEY = '082_farmer_split_invariant_v1';

const migrate = async () => {
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

    const marker = await client.query(
      'SELECT 1 FROM public.app_schema_migrations WHERE version = $1',
      [MIGRATION_KEY]
    );
    if (marker.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    await client.query(`
      WITH parts AS (
        SELECT
          id,
          COALESCE(amount, 0)::numeric AS total,
          GREATEST(COALESCE(cash_amount, 0), 0)::numeric AS cash_part,
          GREATEST(COALESCE(bank_amount, 0), 0)::numeric AS bank_part
        FROM farmer_payments
        WHERE UPPER(TRIM(COALESCE(payment_mode, ''))) = 'SPLIT'
      ), repaired AS (
        SELECT
          id,
          total,
          CASE
            WHEN total < 0 THEN 0::numeric
            WHEN cash_part + bank_part > 0
              THEN ROUND(total * cash_part / (cash_part + bank_part), 2)
            ELSE 0::numeric
          END AS fixed_cash
        FROM parts
      )
      UPDATE farmer_payments fp
      SET
        payment_mode = CASE WHEN r.total < 0 THEN 'BANK' ELSE 'SPLIT' END,
        cash_amount = r.fixed_cash,
        bank_amount = r.total - r.fixed_cash,
        updated_at = NOW()
      FROM repaired r
      WHERE fp.id = r.id
        AND (
          r.total < 0
          OR COALESCE(fp.cash_amount, 0) < 0
          OR COALESCE(fp.bank_amount, 0) < 0
          OR COALESCE(fp.cash_amount, 0) + COALESCE(fp.bank_amount, 0) <> r.total
        )
    `);

    await client.query(`
      ALTER TABLE farmer_payments
      DROP CONSTRAINT IF EXISTS farmer_payments_split_partition_check
    `);
    await client.query(`
      ALTER TABLE farmer_payments
      ADD CONSTRAINT farmer_payments_split_partition_check
      CHECK (
        UPPER(TRIM(COALESCE(payment_mode, ''))) <> 'SPLIT'
        OR (
          COALESCE(amount, 0) >= 0
          AND COALESCE(cash_amount, 0) >= 0
          AND COALESCE(bank_amount, 0) >= 0
          AND COALESCE(cash_amount, 0) + COALESCE(bank_amount, 0) = COALESCE(amount, 0)
        )
      )
    `);

    await client.query(
      `INSERT INTO public.app_schema_migrations (version)
       VALUES ($1)
       ON CONFLICT (version) DO NOTHING`,
      [MIGRATION_KEY]
    );
    await client.query('COMMIT');
    console.log('Migration 082_farmer_split_invariant complete');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .catch((error) => {
    console.error('Migration 082_farmer_split_invariant failed:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

