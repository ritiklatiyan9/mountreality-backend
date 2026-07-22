import pool from '../config/db.js';

// Firm Transactions performance indexes:
//   - Partial index over only "active" firm_transactions (cheque not in
//     BOUNCED/RETURNED). Used by EVERY aggregation in the firm summary,
//     remark/name breakdowns, and dashboard analytics.
//   - (firm_id, date) composite covers the per-firm date-ordered listing.
//   - Partial index on cash_flow_entries that are firm-linked + active —
//     used by the firm summary's CF-side aggregation.
//   - (site_id, date) composite for the history/analytics page.
//
// All indexes use IF NOT EXISTS so the migration is idempotent.
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── firm_transactions ──
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ft_active_firm
        ON firm_transactions(firm_id)
        WHERE cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ft_firm_date
        ON firm_transactions(firm_id, date, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ft_site_date
        ON firm_transactions(site_id, date DESC, created_at DESC)
    `);
    // Autocomplete DISTINCT scans benefit from these covering indexes.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ft_site_name
        ON firm_transactions(site_id, name)
        WHERE name IS NOT NULL AND name != ''
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ft_site_purpose
        ON firm_transactions(site_id, purpose)
        WHERE purpose IS NOT NULL AND purpose != ''
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ft_site_remark
        ON firm_transactions(site_id, remark)
        WHERE remark IS NOT NULL AND remark != ''
    `);

    // ── cash_flow_entries — firm-linked active partial index ──
    // Used by listTransactions's cf-firm enrichment query and
    // findBySiteId's CF-side aggregation.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cfe_firm_active
        ON cash_flow_entries(from_firm_id, to_firm_id)
        WHERE is_firm_transaction = TRUE
          AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
          AND (status IS NULL OR status != 'rejected')
    `);

    // (site_id, name UPPER) for the duplicate firm-name lookup.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_firms_site_name_upper
        ON firms(site_id, UPPER(name))
    `);

    await client.query('COMMIT');
    console.log('Migration 054_firm_performance_indexes complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 054_firm_performance_indexes failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
