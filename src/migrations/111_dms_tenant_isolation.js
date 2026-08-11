import 'dotenv/config';
import pool from '../config/db.js';

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE RESTRICT`);
    await client.query(`
      UPDATE documents d
         SET organization_id = COALESCE(
           (SELECT s.organization_id FROM sites s WHERE s.id = d.site_id),
           u.organization_id
         )
        FROM users u
       WHERE d.uploaded_source = 'DMS' AND d.organization_id IS NULL AND u.id = d.uploaded_by
    `);
    await client.query(`
      UPDATE documents d
         SET organization_id = s.organization_id
        FROM sites s
       WHERE d.uploaded_source = 'DMS' AND d.organization_id IS NULL AND s.id = d.site_id
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_dms_org_unassigned
        ON documents (organization_id, created_at, id)
        WHERE uploaded_source = 'DMS' AND site_id IS NULL
    `);
    await client.query('COMMIT');
    console.log('Migration 111_dms_tenant_isolation complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 111_dms_tenant_isolation failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
