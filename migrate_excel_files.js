import 'dotenv/config';
import pool from './src/config/db.js';

async function migrateExcelFiles() {
    const client = await pool.connect();
    try {
        console.log('Starting excel_files migration...');

        await client.query(`
      CREATE TABLE IF NOT EXISTS excel_files (
        id              SERIAL PRIMARY KEY,
        name            VARCHAR(255) NOT NULL DEFAULT 'Untitled Spreadsheet',
        sheet_data      JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_excel_files_created_by ON excel_files(created_by);
      CREATE INDEX IF NOT EXISTS idx_excel_files_updated_at ON excel_files(updated_at);

      CREATE TRIGGER trg_excel_files_updated_at
        BEFORE UPDATE ON excel_files
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `);

        console.log('✅ excel_files table created successfully!');
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
    } finally {
        client.release();
        await pool.end();
    }
}

migrateExcelFiles();
