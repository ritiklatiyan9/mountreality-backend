/**
 * Migration: Create plot_registries and plot_registry_payments tables
 * Run: node migrate_registry.js
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

    // ── plot_registries ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS plot_registries (
        id SERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        plot_no VARCHAR(50) NOT NULL,
        customer_name VARCHAR(255),
        size_meter NUMERIC(10,2),
        size_sqyard NUMERIC(10,2),
        registry_date DATE,
        farmer_name VARCHAR(255),
        registry_payment NUMERIC(15,2) DEFAULT 0,
        notes TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(site_id, plot_no)
      );
    `);
    console.log('✅ plot_registries table created');

    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_registries_site ON plot_registries(site_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_registries_plot ON plot_registries(site_id, plot_no);`);
    console.log('✅ plot_registries indexes created');

    // ── plot_registry_payments ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS plot_registry_payments (
        id SERIAL PRIMARY KEY,
        registry_id INTEGER NOT NULL REFERENCES plot_registries(id) ON DELETE CASCADE,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        payment_date DATE,
        amount NUMERIC(15,2) DEFAULT 0,
        payment_mode VARCHAR(50),
        tally_date DATE,
        tally_amount NUMERIC(15,2),
        notes TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ plot_registry_payments table created');

    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_registry_payments_registry ON plot_registry_payments(registry_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plot_registry_payments_site ON plot_registry_payments(site_id);`);
    console.log('✅ plot_registry_payments indexes created');

    // ── updated_at trigger ──
    await client.query(`
      CREATE OR REPLACE FUNCTION update_modified_column()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;
    `);

    // Drop existing triggers first to avoid errors
    await client.query(`DROP TRIGGER IF EXISTS update_plot_registries_modtime ON plot_registries;`);
    await client.query(`
      CREATE TRIGGER update_plot_registries_modtime
      BEFORE UPDATE ON plot_registries
      FOR EACH ROW EXECUTE FUNCTION update_modified_column();
    `);

    await client.query(`DROP TRIGGER IF EXISTS update_plot_registry_payments_modtime ON plot_registry_payments;`);
    await client.query(`
      CREATE TRIGGER update_plot_registry_payments_modtime
      BEFORE UPDATE ON plot_registry_payments
      FOR EACH ROW EXECUTE FUNCTION update_modified_column();
    `);
    console.log('✅ Triggers created');

    await client.query('COMMIT');
    console.log('\n🎉 Migration complete — plot_registries + plot_registry_payments ready!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
};

migrate();
