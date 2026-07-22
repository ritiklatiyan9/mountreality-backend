/**
 * Migration: Add status columns to day_book table
 * 
 * Run with: node migrate_daybook_status.js
 */

import 'dotenv/config';
import pool from './src/config/db.js';

async function migrate() {
  try {
    console.log('Starting day_book status migration...\n');

    // Check if columns already exist
    const checkQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'day_book' AND column_name IN ('status', 'approved_by', 'approved_at')
    `;
    const existing = await pool.query(checkQuery);
    const existingCols = existing.rows.map(r => r.column_name);

    // Add status column if not exists
    if (!existingCols.includes('status')) {
      console.log('Adding status column...');
      await pool.query(`
        ALTER TABLE day_book 
        ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending' 
        CHECK (status IN ('pending', 'approved', 'rejected'))
      `);
      console.log('✓ status column added');
    } else {
      console.log('⊘ status column already exists');
    }

    // Add approved_by column if not exists
    if (!existingCols.includes('approved_by')) {
      console.log('Adding approved_by column...');
      await pool.query(`
        ALTER TABLE day_book 
        ADD COLUMN approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      `);
      console.log('✓ approved_by column added');
    } else {
      console.log('⊘ approved_by column already exists');
    }

    // Add approved_at column if not exists
    if (!existingCols.includes('approved_at')) {
      console.log('Adding approved_at column...');
      await pool.query(`
        ALTER TABLE day_book 
        ADD COLUMN approved_at TIMESTAMPTZ
      `);
      console.log('✓ approved_at column added');
    } else {
      console.log('⊘ approved_at column already exists');
    }

    // Create index on status if not exists
    console.log('Creating index on status...');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_day_book_status ON day_book(status)
    `);
    console.log('✓ Index created (or already exists)');

    // Update existing EXPENSE entries that are old to 'approved' status
    console.log('\nUpdating existing day_book EXPENSE entries to approved status...');
    const updateResult = await pool.query(`
      UPDATE day_book 
      SET status = 'approved', approved_at = NOW() 
      WHERE status = 'pending' 
        AND entry_type = 'EXPENSE'
        AND created_at < NOW() - INTERVAL '1 day'
    `);
    console.log(`✓ Updated ${updateResult.rowCount} existing day_book EXPENSE entries to approved`);

    // Auto-approve non-EXPENSE entries (they don't need approval workflow)
    console.log('Auto-approving non-EXPENSE day_book entries...');
    const autoApproveResult = await pool.query(`
      UPDATE day_book 
      SET status = 'approved', approved_at = NOW() 
      WHERE status = 'pending' 
        AND entry_type != 'EXPENSE'
    `);
    console.log(`✓ Auto-approved ${autoApproveResult.rowCount} non-EXPENSE entries`);

    console.log('\n✅ Migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

migrate();
