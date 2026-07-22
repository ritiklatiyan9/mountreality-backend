import pool from '../config/db.js';

export default async function migrateExpenseCategories() {
    try {
        await pool.query(`
      CREATE TABLE IF NOT EXISTS expense_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        icon VARCHAR(50) DEFAULT 'Tag',
        color VARCHAR(30) DEFAULT 'slate',
        grp VARCHAR(80) DEFAULT 'Custom',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
        console.log('✓ expense_categories table ready');
    } catch (err) {
        if (err.code === '42P07') return; // already exists
        console.error('✗ expense_categories migration failed:', err.message);
    }
}
