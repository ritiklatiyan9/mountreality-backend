import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Access paths for the source-traceable enterprise portfolio rollup.
 * Additive and safe to re-run; no operational or accounting data is changed.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('102_phase4_enterprise_rollup_performance'))`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_enterprise_project_rollup
      ON bookings(organization_id,site_id,rera_project_id,lifecycle_status)
      INCLUDE (id,final_consideration)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_certifications_enterprise_latest
      ON construction_certifications(construction_project_id,status,certification_period_end DESC,id DESC)
      INCLUDE (certified_progress_pct)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_registries_enterprise_project_rollup
      ON plot_registries(site_id,rera_project_id,lifecycle_status)
      INCLUDE (id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_licences_enterprise_expiry
      ON compliance_licences(organization_id,site_id,rera_project_id,expiry_date)
      WHERE deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_filings_enterprise_project_rollup
      ON rera_filing_periods(organization_id,site_id,rera_project_id,status,id)
    `);
    await client.query('COMMIT');
    for (const table of ['bookings', 'construction_certifications', 'plot_registries', 'compliance_licences', 'rera_filing_periods']) {
      await client.query(`ANALYZE ${table}`);
    }
    console.log('Migration 102_phase4_enterprise_rollup_performance complete');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration 102_phase4_enterprise_rollup_performance failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
