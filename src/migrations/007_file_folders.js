import pool from '../config/db.js';

const migrateFileFolders = async () => {
    try {
        // Create file_folders table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS file_folders (
                id              SERIAL PRIMARY KEY,
                name            VARCHAR(255) NOT NULL,
                parent_id       INTEGER REFERENCES file_folders(id) ON DELETE CASCADE,
                created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                updated_at      TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        await pool.query(`CREATE INDEX IF NOT EXISTS idx_file_folders_parent ON file_folders(parent_id);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_file_folders_created_by ON file_folders(created_by);`);

        // Add site_id to file_folders (handles case where table was created without it)
        await pool.query(`
            ALTER TABLE file_folders
            ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE;
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_file_folders_site ON file_folders(site_id);`);

        // Add folder_id column to excel_files
        await pool.query(`
            ALTER TABLE excel_files
            ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES file_folders(id) ON DELETE SET NULL;
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_excel_files_folder ON excel_files(folder_id);`);

        // Add file_type column to excel_files for doc/pdf support
        await pool.query(`
            ALTER TABLE excel_files
            ADD COLUMN IF NOT EXISTS file_type VARCHAR(20) DEFAULT 'excel';
        `);

        // Add site_id column to excel_files
        await pool.query(`
            ALTER TABLE excel_files
            ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE;
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_excel_files_site ON excel_files(site_id);`);

        console.log('✅ Migration 007_file_folders completed');
    } catch (err) {
        console.error('❌ Migration 007_file_folders failed:', err.message);
    }
};

export default migrateFileFolders;
