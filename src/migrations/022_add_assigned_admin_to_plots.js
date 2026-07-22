import 'dotenv/config';
import pool from '../config/db.js';
import path from 'path';
import { pathToFileURL } from 'url';

/**
 * Migration 022: Add assigned_admin_id to Plots.
 */

const TABLES = [
  'plots',
];

export async function up() {
  try {
    for (const table of TABLES) {
      await pool.query(`
        ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_${table}_assigned_admin_id
        ON ${table}(assigned_admin_id)
      `);

      console.log(`\u2713 ${table} assigned_admin_id added`);
    }

    console.log('Migration 022 completed');
  } catch (error) {
    console.error('Migration 022 failed:', error.message);
    throw error;
  }
}

export async function down() {
  try {
    for (const table of TABLES) {
      await pool.query(`DROP INDEX IF EXISTS idx_${table}_assigned_admin_id`);
      await pool.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS assigned_admin_id`);
      console.log(`\u2713 ${table} assigned_admin_id removed`);
    }

    console.log('Migration 022 rollback completed');
  } catch (error) {
    console.error('Migration 022 rollback failed:', error.message);
    throw error;
  }
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  up()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
