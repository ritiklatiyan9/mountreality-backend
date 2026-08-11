import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Phase 4 portal collaboration lifecycle.
 * Attachments reference an audience-approved document grant; files and
 * internal document rows are never copied into the comment store.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('101_phase4_portal_collaboration'))`);
    await client.query(`
      ALTER TABLE portal_comments
        ADD COLUMN IF NOT EXISTS attachment_document_grant_id BIGINT REFERENCES portal_document_grants(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS resolution_notes TEXT
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='portal_comments_resolution_state_chk') THEN
          ALTER TABLE portal_comments ADD CONSTRAINT portal_comments_resolution_state_chk CHECK (
            (resolved_at IS NULL AND resolved_by IS NULL AND resolution_notes IS NULL)
            OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
          );
        END IF;
      END $$
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_portal_comments_unresolved
      ON portal_comments(organization_id,target_type,target_id,created_at)
      WHERE deleted_at IS NULL AND resolved_at IS NULL
    `);
    await client.query('COMMIT');
    console.log('Migration 101_phase4_portal_collaboration complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 101_phase4_portal_collaboration failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
