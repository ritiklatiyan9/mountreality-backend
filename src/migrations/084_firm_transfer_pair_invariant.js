import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 084 — make firm-to-firm transfers one synchronized pair.
 *
 * One OUT row belongs to the source site and one IN row belongs to the target
 * site. Both are legitimate site movements, but duplicate sides or stale mode /
 * cheque metadata make Cash, Bank and Main disagree. This migration repairs
 * existing pairs, backfills a missing approved IN side, and prevents a race
 * from creating a second row for the same side.
 */

const MIGRATION_KEY = '084_firm_transfer_pair_invariant_v1';

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

    // Keep the oldest audit row for each side. Source-linked canonical ledger
    // rows are removed by the migration-081 DELETE trigger with the duplicate.
    await client.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY transfer_group_id, transfer_direction
                 ORDER BY id
               ) AS position
          FROM firm_transactions
         WHERE is_firm_to_firm_transfer = TRUE
           AND transfer_group_id IS NOT NULL
           AND transfer_direction IN ('OUT', 'IN')
      )
      DELETE FROM firm_transactions ft
       USING ranked r
       WHERE ft.id = r.id AND r.position > 1
    `);

    // Existing inbound rows inherit the authoritative settlement and approval
    // lifecycle from their outbound side. The two rows retain opposite money
    // directions because they belong to different sites.
    await client.query(`
      UPDATE firm_transactions inbound
         SET firm_id = outbound.transfer_to_firm_id,
             site_id = outbound.transfer_to_site_id,
             date = outbound.date,
             description = CONCAT(
               'TRANSFER FROM ', source_firm.name,
               CASE WHEN NULLIF(TRIM(outbound.description), '') IS NOT NULL
                    THEN ' - ' || outbound.description ELSE '' END
             ),
             payment_mode = ledger_bucket(outbound.payment_mode),
             debit = 0,
             credit = GREATEST(ABS(COALESCE(outbound.debit, 0)), ABS(COALESCE(outbound.credit, 0))),
             name = source_firm.name,
             purpose = COALESCE(outbound.purpose, 'FIRM TO FIRM TRANSFER'),
             remark = COALESCE(outbound.remark, 'FIRM TO FIRM TRANSFER'),
             remark2 = outbound.remark2,
             cheque_no = CASE WHEN ledger_bucket(outbound.payment_mode) = 'cheque'
                              THEN outbound.cheque_no ELSE NULL END,
             cheque_status = CASE WHEN ledger_bucket(outbound.payment_mode) = 'cheque'
                                  THEN COALESCE(outbound.cheque_status, 'PENDING') ELSE NULL END,
             transaction_no = outbound.transaction_no,
             voucher_url = outbound.voucher_url,
             assigned_admin_id = outbound.assigned_admin_id,
             status = outbound.status,
             approved_by = outbound.approved_by,
             approved_at = outbound.approved_at,
             is_firm_to_firm_transfer = TRUE,
             transfer_to_site_id = outbound.site_id,
             transfer_to_firm_id = outbound.firm_id,
             updated_at = NOW()
        FROM firm_transactions outbound
        JOIN firms source_firm ON source_firm.id = outbound.firm_id
        JOIN firms target_firm
          ON target_firm.id = outbound.transfer_to_firm_id
         AND target_firm.site_id = outbound.transfer_to_site_id
       WHERE outbound.is_firm_to_firm_transfer = TRUE
         AND outbound.transfer_direction = 'OUT'
         AND inbound.is_firm_to_firm_transfer = TRUE
         AND inbound.transfer_direction = 'IN'
         AND inbound.transfer_group_id = outbound.transfer_group_id
    `);

    // Older approved OUT rows can predate automatic pair creation. Backfill
    // only a valid positive transfer whose target firm still belongs to the
    // recorded target site.
    const inserted = await client.query(`
      INSERT INTO firm_transactions (
        firm_id, site_id, date, description, payment_mode, debit, credit,
        name, purpose, remark, remark2, cheque_no, cheque_status,
        created_by, transaction_no, voucher_url, assigned_admin_id,
        status, approved_by, approved_at, is_firm_to_firm_transfer,
        transfer_to_site_id, transfer_to_firm_id, transfer_group_id,
        transfer_direction
      )
      SELECT
        target_firm.id,
        target_firm.site_id,
        outbound.date,
        CONCAT(
          'TRANSFER FROM ', source_firm.name,
          CASE WHEN NULLIF(TRIM(outbound.description), '') IS NOT NULL
               THEN ' - ' || outbound.description ELSE '' END
        ),
        ledger_bucket(outbound.payment_mode),
        0,
        GREATEST(ABS(COALESCE(outbound.debit, 0)), ABS(COALESCE(outbound.credit, 0))),
        source_firm.name,
        COALESCE(outbound.purpose, 'FIRM TO FIRM TRANSFER'),
        COALESCE(outbound.remark, 'FIRM TO FIRM TRANSFER'),
        outbound.remark2,
        CASE WHEN ledger_bucket(outbound.payment_mode) = 'cheque' THEN outbound.cheque_no ELSE NULL END,
        CASE WHEN ledger_bucket(outbound.payment_mode) = 'cheque'
             THEN COALESCE(outbound.cheque_status, 'PENDING') ELSE NULL END,
        outbound.created_by,
        outbound.transaction_no,
        outbound.voucher_url,
        outbound.assigned_admin_id,
        'approved',
        outbound.approved_by,
        outbound.approved_at,
        TRUE,
        outbound.site_id,
        outbound.firm_id,
        outbound.transfer_group_id,
        'IN'
      FROM firm_transactions outbound
      JOIN firms source_firm ON source_firm.id = outbound.firm_id
      JOIN firms target_firm
        ON target_firm.id = outbound.transfer_to_firm_id
       AND target_firm.site_id = outbound.transfer_to_site_id
      WHERE outbound.is_firm_to_firm_transfer = TRUE
        AND outbound.transfer_direction = 'OUT'
        AND outbound.transfer_group_id IS NOT NULL
        AND LOWER(COALESCE(outbound.status, 'approved')) = 'approved'
        AND GREATEST(ABS(COALESCE(outbound.debit, 0)), ABS(COALESCE(outbound.credit, 0))) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM firm_transactions inbound
          WHERE inbound.transfer_group_id = outbound.transfer_group_id
            AND inbound.transfer_direction = 'IN'
        )
      RETURNING id
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_transfer_group_direction
      ON firm_transactions (transfer_group_id, transfer_direction)
      WHERE transfer_group_id IS NOT NULL
        AND transfer_direction IN ('OUT', 'IN')
    `);

    await client.query(
      `INSERT INTO public.app_schema_migrations (version)
       VALUES ($1)
       ON CONFLICT (version) DO NOTHING`,
      [MIGRATION_KEY]
    );
    await client.query('COMMIT');
    console.log(`Migration ${MIGRATION_KEY} complete — backfilled ${inserted.rowCount} inbound transfer row(s)`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .catch((error) => {
    console.error(`Migration ${MIGRATION_KEY} failed:`, error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
