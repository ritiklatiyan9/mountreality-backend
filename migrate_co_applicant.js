// Migration: Add Co-applicant details + Permanent address to members table.
// These columns back the co-applicant / extra fields shown on the booking form,
// so member data entered in the client form flows straight onto the printout.
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const sslOption =
  process.env.DB_SSL === 'true' ||
  (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
    ? { rejectUnauthorized: false }
    : false;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : '',
  ssl: sslOption,
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const columns = [
      // Co-applicant (joint applicant)
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS co_applicant_name VARCHAR(255)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS co_applicant_relation VARCHAR(50)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS co_applicant_dob DATE`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS co_applicant_gender VARCHAR(20)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS co_applicant_phone VARCHAR(20)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS co_applicant_email VARCHAR(255)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS co_applicant_aadhar VARCHAR(20)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS co_applicant_pan VARCHAR(20)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS co_applicant_address TEXT`,
      // Extra address
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS permanent_address TEXT`,
    ];
    for (const q of columns) await client.query(q);
    console.log('✅ Added co-applicant + permanent address columns');

    await client.query('COMMIT');
    console.log('\n🎉 Migration completed successfully!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err);
  } finally {
    client.release();
    process.exit(0);
  }
}

migrate();
