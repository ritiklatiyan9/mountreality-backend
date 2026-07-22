import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config();

const sslOption = process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS edit_requests (
        id SERIAL PRIMARY KEY,
        
        -- Who requested and which site
        requested_by INTEGER NOT NULL REFERENCES users(id),
        site_id INTEGER REFERENCES sites(id),
        
        -- What record is being edited
        module VARCHAR(50) NOT NULL,          -- 'farmer', 'farmer_payment', 'plot', 'plot_payment', 'daybook', 'daybook_expense', 'daybook_farmer_payment', 'daybook_commission', 'daybook_cashflow', 'daybook_firm_transaction', 'daybook_plot_payment'
        record_id INTEGER NOT NULL,           -- ID of the record being edited
        
        -- The edit data (JSON of proposed changes)
        original_data JSONB NOT NULL DEFAULT '{}',
        proposed_data JSONB NOT NULL DEFAULT '{}',
        
        -- Proof photo (uploaded to cloudinary)
        proof_photo_url TEXT,
        
        -- Approval workflow
        status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending', 'approved', 'rejected'
        reviewed_by INTEGER REFERENCES users(id),
        reviewed_at TIMESTAMP,
        rejection_reason TEXT,
        
        -- Timestamps
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Indexes for fast lookups
    await client.query(`CREATE INDEX IF NOT EXISTS idx_edit_requests_status ON edit_requests(status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_edit_requests_site ON edit_requests(site_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_edit_requests_module ON edit_requests(module, record_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_edit_requests_requested_by ON edit_requests(requested_by);`);

    await client.query('COMMIT');
    console.log('✅ edit_requests table created successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
