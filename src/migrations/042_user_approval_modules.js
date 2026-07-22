import pool from '../config/db.js';

/**
 * Migration 042: Create user_approval_modules table
 * Stores which approval modules each sub-admin can access.
 */
export const up = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_approval_modules (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        module VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, module)
      );
    `);
    console.log('✓ Migration 042: user_approval_modules table created');
  } catch (err) {
    console.error('✗ Migration 042 failed:', err.message);
  }
};

export const down = async () => {
  await pool.query('DROP TABLE IF EXISTS user_approval_modules');
  console.log('Migration 042 rolled back');
};
