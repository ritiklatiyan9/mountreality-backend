// Migration: Add comprehensive member fields + EMPLOYEE type + KYC document URLs
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

    // 1. Update member_type CHECK to include EMPLOYEE
    await client.query(`
      ALTER TABLE members DROP CONSTRAINT IF EXISTS members_member_type_check;
      ALTER TABLE members ADD CONSTRAINT members_member_type_check
        CHECK (member_type IN ('CLIENT','FARMER','MEMBER','BROKER','PARTNER','VENDOR','EMPLOYEE','OTHER'));
    `);
    console.log('✅ Updated member_type CHECK to include EMPLOYEE');

    // 2. Additional Personal Fields
    const personalFields = [
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS mother_name VARCHAR(255)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS spouse_name VARCHAR(255)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS nationality VARCHAR(50) DEFAULT 'INDIAN'`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS religion VARCHAR(50)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS caste VARCHAR(100)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS marital_status VARCHAR(20)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS anniversary_date DATE`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS qualification VARCHAR(100)`,
    ];
    for (const q of personalFields) await client.query(q);
    console.log('✅ Added personal fields');

    // 3. Additional Identity / Government IDs
    const idFields = [
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS passport_no VARCHAR(20)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS driving_license_no VARCHAR(30)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS gst_no VARCHAR(20)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS tin_no VARCHAR(20)`,
    ];
    for (const q of idFields) await client.query(q);
    console.log('✅ Added additional identity fields');

    // 4. Emergency Contact
    const emergencyFields = [
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS emergency_contact_name VARCHAR(255)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS emergency_contact_phone VARCHAR(20)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS emergency_contact_relation VARCHAR(50)`,
    ];
    for (const q of emergencyFields) await client.query(q);
    console.log('✅ Added emergency contact fields');

    // 5. Nominee
    const nomineeFields = [
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS nominee_name VARCHAR(255)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS nominee_relation VARCHAR(50)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS nominee_phone VARCHAR(20)`,
    ];
    for (const q of nomineeFields) await client.query(q);
    console.log('✅ Added nominee fields');

    // 6. Employee-specific fields
    const employeeFields = [
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS designation VARCHAR(100)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS department VARCHAR(100)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS date_of_joining DATE`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS salary NUMERIC(15,2)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS employment_type VARCHAR(30)`,
    ];
    for (const q of employeeFields) await client.query(q);
    console.log('✅ Added employee-specific fields');

    // 7. Employee Document URLs (Cloudinary)
    const empDocFields = [
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS resume_url VARCHAR(500)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS marksheet_10th_url VARCHAR(500)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS marksheet_12th_url VARCHAR(500)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS degree_certificate_url VARCHAR(500)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS experience_certificate_url VARCHAR(500)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS offer_letter_url VARCHAR(500)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS other_certificate_url VARCHAR(500)`,
    ];
    for (const q of empDocFields) await client.query(q);
    console.log('✅ Added employee document URL fields');

    // 8. KYC Document Photo URLs (Cloudinary)
    const kycFields = [
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS aadhar_front_url VARCHAR(500)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS aadhar_back_url VARCHAR(500)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS pan_card_url VARCHAR(500)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS voter_id_url VARCHAR(500)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS passport_url VARCHAR(500)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS driving_license_url VARCHAR(500)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS cheque_url VARCHAR(500)`,
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS other_kyc_url VARCHAR(500)`,
    ];
    for (const q of kycFields) await client.query(q);
    console.log('✅ Added KYC document URL fields');

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
