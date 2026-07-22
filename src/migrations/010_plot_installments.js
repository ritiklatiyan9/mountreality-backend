/**
 * Migration 010: Plot Installment System
 *
 * Creates tables for:
 *  - plot_installment_settings  (per-plot interest config & installment toggle)
 *  - plot_installments          (individual installment records)
 *  - plot_installment_payments  (payments applied to installments)
 */

import 'dotenv/config';
import pool from '../config/db.js';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Add installment-related columns to plots table ──
    console.log('Adding installment columns to plots...');
    await client.query(`
      ALTER TABLE plots
        ADD COLUMN IF NOT EXISTS installments_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS interest_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS interest_rate        NUMERIC(8,4) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS interest_type        VARCHAR(20) DEFAULT 'per_month'
          CHECK (interest_type IN ('per_day', 'per_month', 'per_quarter', 'per_year'))
    `);

    // ── 2. Create plot_installments table ──
    console.log('Creating plot_installments table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS plot_installments (
        id                SERIAL PRIMARY KEY,
        plot_id           INTEGER NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
        installment_name  VARCHAR(255),
        amount            NUMERIC(15,2) NOT NULL DEFAULT 0,
        due_date          DATE NOT NULL,
        status            VARCHAR(20) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'partially_paid', 'paid', 'overdue')),
        paid_amount       NUMERIC(15,2) NOT NULL DEFAULT 0,
        interest_amount   NUMERIC(15,2) NOT NULL DEFAULT 0,
        sort_order        INTEGER NOT NULL DEFAULT 0,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_pi_plot ON plot_installments(plot_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pi_status ON plot_installments(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pi_due_date ON plot_installments(due_date)`);

    // ── 3. Create plot_installment_payments table ──
    console.log('Creating plot_installment_payments table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS plot_installment_payments (
        id                SERIAL PRIMARY KEY,
        installment_id    INTEGER NOT NULL REFERENCES plot_installments(id) ON DELETE CASCADE,
        plot_id           INTEGER NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
        amount            NUMERIC(15,2) NOT NULL DEFAULT 0,
        payment_date      DATE NOT NULL DEFAULT CURRENT_DATE,
        payment_mode      VARCHAR(50),
        reference         VARCHAR(255),
        notes             TEXT,
        created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_pip_installment ON plot_installment_payments(installment_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pip_plot ON plot_installment_payments(plot_id)`);

    // ── 4. Trigger for updated_at on plot_installments ──
    await client.query(`
      CREATE OR REPLACE TRIGGER trg_plot_installments_updated_at
        BEFORE UPDATE ON plot_installments
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `);

    await client.query('COMMIT');
    console.log('Migration 010 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 010 failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
