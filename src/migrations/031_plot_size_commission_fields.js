import pool from '../config/db.js';

const up = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add plot_size_mtr (size in square meters, auto-converted from Gaz/Sq Yards)
    const hasSizeMtr = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'plots' AND column_name = 'plot_size_mtr'`
    );
    if (hasSizeMtr.rows.length === 0) {
      await client.query(`ALTER TABLE plots ADD COLUMN plot_size_mtr NUMERIC(10,2)`);
      console.log('  ✔ Added plot_size_mtr column');
    }

    // Add commission_rate (rate per Gaz for commission calculation)
    const hasCommRate = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'plots' AND column_name = 'commission_rate'`
    );
    if (hasCommRate.rows.length === 0) {
      await client.query(`ALTER TABLE plots ADD COLUMN commission_rate NUMERIC(15,2) DEFAULT 0`);
      console.log('  ✔ Added commission_rate column');
    }

    // Add plot_commission (auto-calculated: plot_size * commission_rate)
    const hasPlotComm = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'plots' AND column_name = 'plot_commission'`
    );
    if (hasPlotComm.rows.length === 0) {
      await client.query(`ALTER TABLE plots ADD COLUMN plot_commission NUMERIC(15,2) DEFAULT 0`);
      console.log('  ✔ Added plot_commission column');
    }

    await client.query('COMMIT');
    console.log('Migration 031_plot_size_commission_fields completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export default up;
