import pool from '../config/db.js';

export default async function migrateExpenseEnhancements() {
    try {
        // Add columns to expenses table
        await pool.query(`
            ALTER TABLE expenses 
            ADD COLUMN IF NOT EXISTS assigned_user_id INT REFERENCES members(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS voucher_url VARCHAR(1000)
        `);
        console.log('✓ expenses table updated with assigned_user_id and voucher_url');

        // Add columns to day_book table
        await pool.query(`
            ALTER TABLE day_book 
            ADD COLUMN IF NOT EXISTS assigned_user_id INT REFERENCES members(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS voucher_url VARCHAR(1000)
        `);
        console.log('✓ day_book table updated with assigned_user_id and voucher_url');

    } catch (err) {
        console.error('✗ expense enhancements migration failed:', err.message);
    }
}
