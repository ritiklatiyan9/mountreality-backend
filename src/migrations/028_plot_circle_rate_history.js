import 'dotenv/config';
import pool from '../config/db.js';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS plot_circle_rate_history (
        id SERIAL PRIMARY KEY,
        plot_id INTEGER NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
        previous_circle_rate NUMERIC(15,2) NOT NULL DEFAULT 0,
        new_circle_rate NUMERIC(15,2) NOT NULL DEFAULT 0,
        changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_pcrh_plot_id ON plot_circle_rate_history(plot_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pcrh_changed_at ON plot_circle_rate_history(changed_at DESC)`);

    await client.query('COMMIT');
    console.log('Migration 028 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 028 failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
