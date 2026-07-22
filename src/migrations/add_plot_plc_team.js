import 'dotenv/config';
import pool from '../config/db.js';

const migrate = async () => {
  try {
    console.log('Adding plc_charges and team columns to plots table...');

    await pool.query(`
      ALTER TABLE plots
        ADD COLUMN IF NOT EXISTS plc_charges NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS team VARCHAR(10);
    `);

    console.log('Migration complete: plc_charges and team columns added to plots.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
};

migrate();
