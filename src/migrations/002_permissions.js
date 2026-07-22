import pool from '../config/db.js';

/**
 * Migration: Create user_permissions table
 * This runs automatically on server startup
 */
export const migratePermissions = async () => {
  try {
    const query = `
      CREATE TABLE IF NOT EXISTS user_permissions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        module VARCHAR(50) NOT NULL,
        can_read BOOLEAN DEFAULT true,
        can_write BOOLEAN DEFAULT true,
        can_update BOOLEAN DEFAULT true,
        can_delete BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, module)
      );
    `;
    await pool.query(query);
    console.log('✓ Migration applied: user_permissions table created');
    return true;
  } catch (error) {
    if (error.message.includes('already exists')) {
      console.log('✓ Migration skipped: user_permissions table already exists');
      return true;
    }
    console.error('✗ Migration failed:', error.message);
    return false;
  }
};

export default migratePermissions;
