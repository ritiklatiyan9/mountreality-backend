import pool from '../config/db.js';

/**
 * Migration: Add cash_type column to cash_flow_entries table
 * This runs automatically on server startup
 */
export const migrateAddCashType = async () => {
  try {
    const query = `
      ALTER TABLE cash_flow_entries
      ADD COLUMN IF NOT EXISTS cash_type VARCHAR(20) NOT NULL DEFAULT 'bank' CHECK (cash_type IN ('cash', 'bank'));
    `;
    
    const result = await pool.query(query);
    console.log('✓ Migration applied: Added cash_type column to cash_flow_entries');
    return true;
  } catch (error) {
    // Check if error is about column already existing (which is fine)
    if (error.message.includes('already exists')) {
      console.log('✓ Migration skipped: cash_type column already exists');
      return true;
    }
    console.error('✗ Migration failed:', error.message);
    return false;
  }
};

export default migrateAddCashType;
