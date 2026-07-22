/**
 * Migration: Create members table
 * Run: node migrate_members.js
 */
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

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS members (
        id              SERIAL PRIMARY KEY,
        site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        member_type     VARCHAR(30) NOT NULL DEFAULT 'CLIENT'
                          CHECK (member_type IN ('CLIENT','FARMER','MEMBER','BROKER','PARTNER','VENDOR','OTHER')),
        full_name       VARCHAR(255) NOT NULL,
        father_name     VARCHAR(255),
        photo           VARCHAR(500),
        gender          VARCHAR(10) CHECK (gender IN ('MALE','FEMALE','OTHER')),
        date_of_birth   DATE,
        blood_group     VARCHAR(5),
        phone           VARCHAR(20),
        alt_phone       VARCHAR(20),
        email           VARCHAR(255),
        whatsapp        VARCHAR(20),
        address         TEXT,
        city            VARCHAR(100),
        state           VARCHAR(100),
        pincode         VARCHAR(10),
        aadhar_no       VARCHAR(20),
        pan_no          VARCHAR(15),
        voter_id        VARCHAR(30),
        bank_name       VARCHAR(100),
        account_no      VARCHAR(30),
        ifsc_code       VARCHAR(15),
        branch          VARCHAR(100),
        occupation      VARCHAR(100),
        company_name    VARCHAR(255),
        reference       VARCHAR(255),
        notes           TEXT,
        status          VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED')),
        created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ members table created');

    await client.query(`CREATE INDEX IF NOT EXISTS idx_members_site ON members(site_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_members_type ON members(member_type);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_members_name ON members(site_id, full_name);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);`);
    console.log('✅ indexes created');

    await client.query(`
      CREATE OR REPLACE FUNCTION update_modified_column()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;
    `);
    await client.query(`DROP TRIGGER IF EXISTS update_members_modtime ON members;`);
    await client.query(`
      CREATE TRIGGER update_members_modtime
      BEFORE UPDATE ON members
      FOR EACH ROW EXECUTE FUNCTION update_modified_column();
    `);
    console.log('✅ trigger created');

    await client.query('COMMIT');
    console.log('\n🎉 Migration complete — members table ready!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
};

migrate();
