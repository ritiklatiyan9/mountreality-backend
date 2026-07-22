import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Preserve the semantic slot of a KYC upload (for example Aadhaar front versus
 * Aadhaar back). Existing document rows remain unchanged and are still resolved
 * by upload order as a backwards-compatible fallback.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      ALTER TABLE documents
        ADD COLUMN IF NOT EXISTS member_document_field VARCHAR(40)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_case_member_field
        ON documents (kyc_case_id, member_document_field, id DESC)
        WHERE member_document_field IS NOT NULL
    `);
    await client.query('COMMIT');
    console.log('Migration 072_member_kyc_document_field complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 072_member_kyc_document_field failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
