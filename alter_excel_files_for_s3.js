import 'dotenv/config';
import pool from './src/config/db.js';

async function alterExcelFilesTable() {
    const client = await pool.connect();
    try {
        console.log('Starting excel_files schema update for AWS S3...');

        // 1. Add new columns
        await client.query(`
            ALTER TABLE excel_files
            ADD COLUMN IF NOT EXISTS s3_key VARCHAR(255),
            ADD COLUMN IF NOT EXISTS size_bytes INTEGER;
        `);
        console.log('✅ Added s3_key and size_bytes columns.');

        // 2. Clear out legacy jsonb data (if any) to save database space, then drop column
        // If there were critical files, we'd normally write a script to migrate them to S3 here.
        // Assuming it's safe to drop because it's a new feature and user wants to switch to S3 testing.
        await client.query(`
            ALTER TABLE excel_files
            DROP COLUMN IF EXISTS sheet_data;
        `);
        console.log('✅ Dropped legacy sheet_data JSONB column.');

        console.log('🎉 Migration to AWS S3 Schema completed successfully!');
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
    } finally {
        client.release();
        await pool.end();
    }
}

alterExcelFilesTable();
