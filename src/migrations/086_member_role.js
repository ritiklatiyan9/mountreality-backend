import pool from '../config/db.js';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // role: a member's position/role (Owner, Manager, Staff, etc.) — shown
    // for every member type, independent of the Employee-only 'designation'.
    await client.query(`
      ALTER TABLE members
        ADD COLUMN IF NOT EXISTS role VARCHAR(30);
    `);

    await client.query('COMMIT');
    console.log('✅ Migration 086: Added role to members');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 086 failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
