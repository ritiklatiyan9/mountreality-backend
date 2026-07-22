import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD),
  ssl: { rejectUnauthorized: false },
});

export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add plot_tag column
    await client.query(`
      ALTER TABLE plots ADD COLUMN IF NOT EXISTS plot_tag VARCHAR(20)
    `);

    // Drop the unique constraint on (site_id, plot_no) to allow RESALE duplicates
    // The constraint name may vary, so we find and drop it dynamically
    const constraintRes = await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'plots'::regclass
        AND contype = 'u'
        AND array_length(conkey, 1) = 2
    `);
    for (const row of constraintRes.rows) {
      await client.query(`ALTER TABLE plots DROP CONSTRAINT IF EXISTS "${row.conname}"`);
    }

    await client.query('COMMIT');
    console.log('Migration 035: Added plot_tag column, removed unique(site_id, plot_no) constraint');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

up();
