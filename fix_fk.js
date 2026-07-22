import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import pool from './src/config/db.js';

async function run() {
  try {
    // Drop existing data to avoid FK conflicts because old data was using users(id)
    await pool.query(`TRUNCATE TABLE plot_commission_payments CASCADE`);
    await pool.query(`TRUNCATE TABLE plot_commissions_v2 CASCADE`);

    await pool.query(`ALTER TABLE plot_commissions_v2 DROP CONSTRAINT IF EXISTS plot_commissions_v2_agent_id_fkey`);
    await pool.query(`ALTER TABLE plot_commissions_v2 ADD CONSTRAINT plot_commissions_v2_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES members(id)`);
    console.log('Successfully updated foreign key to members(id)');
  } catch (err) {
    console.error('Error updating foreign key:', err);
  } finally {
    process.exit(0);
  }
}

run();
