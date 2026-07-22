import 'dotenv/config';
import pool from '../config/db.js';

async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Add assigned_admin_id to vendor_commitments
    await client.query(`
      ALTER TABLE vendor_commitments 
      ADD COLUMN IF NOT EXISTS assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_commitments_assigned_admin_id ON vendor_commitments(assigned_admin_id)
    `);

    // 2. Add assigned_admin_id to imprest_expense_requests
    await client.query(`
      ALTER TABLE imprest_expense_requests 
      ADD COLUMN IF NOT EXISTS assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_imprest_expense_requests_assigned_admin_id ON imprest_expense_requests(assigned_admin_id)
    `);

    // 3. Add assigned_admin_id to imprest_allocations
    await client.query(`
      ALTER TABLE imprest_allocations 
      ADD COLUMN IF NOT EXISTS assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_imprest_allocations_assigned_admin_id ON imprest_allocations(assigned_admin_id)
    `);

    await client.query('COMMIT');
    console.log('Migration 023 (Vendors & Imprest Assigned Admin) completed successfully.');
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Error during migration 023:', err);
    throw err;
  } finally {
    if (client) client.release();
  }
}

async function down() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DROP INDEX IF EXISTS idx_vendor_commitments_assigned_admin_id');
    await client.query('ALTER TABLE vendor_commitments DROP COLUMN IF EXISTS assigned_admin_id');

    await client.query('DROP INDEX IF EXISTS idx_imprest_expense_requests_assigned_admin_id');
    await client.query('ALTER TABLE imprest_expense_requests DROP COLUMN IF EXISTS assigned_admin_id');

    await client.query('DROP INDEX IF EXISTS idx_imprest_allocations_assigned_admin_id');
    await client.query('ALTER TABLE imprest_allocations DROP COLUMN IF EXISTS assigned_admin_id');

    await client.query('COMMIT');
    console.log('Migration 023 (Vendors & Imprest Assigned Admin) rolled back successfully.');
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Error during rollback of migration 023:', err);
    throw err;
  } finally {
    if (client) client.release();
  }
}

// Run directly
up().then(() => {
  console.log('Migration up finished');
  process.exit(0);
}).catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
