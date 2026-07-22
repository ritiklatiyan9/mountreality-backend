import pool from '../config/db.js';

export const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Table 1: plot_commissions_v2 (Master records) ──
    const createMasterQuery = `
      CREATE TABLE IF NOT EXISTS plot_commissions_v2 (
        id SERIAL PRIMARY KEY,
        site_id INT REFERENCES sites(id) ON DELETE CASCADE,
        plot_id INT REFERENCES plots(id) ON DELETE RESTRICT,
        agent_id INT REFERENCES users(id) ON DELETE RESTRICT,
        total_commission DECIMAL(12, 2) NOT NULL DEFAULT 0,
        remarks TEXT,
        status VARCHAR(20) DEFAULT 'Pending', -- Pending, Partial, Completed
        created_by INT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await client.query(createMasterQuery);
    console.log('✅ Table "plot_commissions_v2" created successfully.');

    // ── Table 2: plot_commission_payments (Installment records) ──
    const createPaymentsQuery = `
      CREATE TABLE IF NOT EXISTS plot_commission_payments (
        id SERIAL PRIMARY KEY,
        site_id INT REFERENCES sites(id) ON DELETE CASCADE,
        plot_commission_id INT REFERENCES plot_commissions_v2(id) ON DELETE CASCADE,
        date DATE NOT NULL DEFAULT CURRENT_DATE,
        amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
        balance_after_payment DECIMAL(12, 2) NOT NULL DEFAULT 0,
        payment_mode VARCHAR(20) DEFAULT 'CASH', -- CASH or BANK
        bank_name VARCHAR(100),
        transaction_id VARCHAR(100),
        remarks TEXT,
        status VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected
        voucher_number VARCHAR(50) UNIQUE,
        voucher_url TEXT,
        created_by INT REFERENCES users(id) ON DELETE SET NULL,
        approved_by INT REFERENCES users(id) ON DELETE SET NULL,
        approved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await client.query(createPaymentsQuery);
    console.log('✅ Table "plot_commission_payments" created successfully.');

    // Add indexes for optimization
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pcv2_site_id ON plot_commissions_v2(site_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pcv2_plot_id ON plot_commissions_v2(plot_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pcv2_agent_id ON plot_commissions_v2(agent_id);`);
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pcp_site_id ON plot_commission_payments(site_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pcp_master_id ON plot_commission_payments(plot_commission_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pcp_status ON plot_commission_payments(status);`);
    console.log('✅ Indexes for plot_commissions_v2 and plot_commission_payments created.');

    await client.query('COMMIT');
    console.log('\nMigration 013 (Plot Commissions Module) completed.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

export const down = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DROP TABLE IF EXISTS plot_commission_payments CASCADE;');
    await client.query('DROP TABLE IF EXISTS plot_commissions_v2 CASCADE;');
    
    await client.query('COMMIT');
    console.log('✅ Dropped Plot Commissions module tables.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Down migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
};
