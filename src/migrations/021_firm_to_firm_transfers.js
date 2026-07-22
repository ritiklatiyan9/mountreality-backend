import pool from '../config/db.js';
import path from 'path';
import { pathToFileURL } from 'url';

/**
 * Migration 021: Add explicit firm-to-firm transfer metadata columns.
 */

export async function up() {
  try {
    await pool.query(`
      ALTER TABLE firm_transactions
      ADD COLUMN IF NOT EXISTS is_firm_to_firm_transfer BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS transfer_to_site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS transfer_to_firm_id INTEGER REFERENCES firms(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS transfer_group_id VARCHAR(80),
      ADD COLUMN IF NOT EXISTS transfer_direction VARCHAR(10)
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'firm_transactions_transfer_direction_check'
            AND conrelid = 'firm_transactions'::regclass
        ) THEN
          ALTER TABLE firm_transactions
          ADD CONSTRAINT firm_transactions_transfer_direction_check
          CHECK (
            transfer_direction IS NULL OR transfer_direction IN ('OUT', 'IN')
          );
        END IF;
      END $$;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ft_transfer_group_id
      ON firm_transactions(transfer_group_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ft_transfer_to_firm_id
      ON firm_transactions(transfer_to_firm_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ft_is_firm_to_firm_transfer
      ON firm_transactions(is_firm_to_firm_transfer)
    `);

    console.log('Migration 021 complete: firm-to-firm transfer columns added.');
  } catch (error) {
    console.error('Migration 021 failed:', error.message);
    throw error;
  }
}

export async function down() {
  try {
    await pool.query(`DROP INDEX IF EXISTS idx_ft_is_firm_to_firm_transfer`);
    await pool.query(`DROP INDEX IF EXISTS idx_ft_transfer_to_firm_id`);
    await pool.query(`DROP INDEX IF EXISTS idx_ft_transfer_group_id`);

    await pool.query(`
      ALTER TABLE firm_transactions
      DROP CONSTRAINT IF EXISTS firm_transactions_transfer_direction_check
    `);

    await pool.query(`
      ALTER TABLE firm_transactions
      DROP COLUMN IF EXISTS transfer_direction,
      DROP COLUMN IF EXISTS transfer_group_id,
      DROP COLUMN IF EXISTS transfer_to_firm_id,
      DROP COLUMN IF EXISTS transfer_to_site_id,
      DROP COLUMN IF EXISTS is_firm_to_firm_transfer
    `);

    console.log('Migration 021 rollback complete.');
  } catch (error) {
    console.error('Migration 021 rollback failed:', error.message);
    throw error;
  }
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  up()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
