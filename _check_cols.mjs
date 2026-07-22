import pool from './src/config/db.js';
const r = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'farmers' AND column_name IN ('land_size_bigha','land_rate','commission_percentage','commission_amount') ORDER BY column_name`);
console.log(r.rows);
process.exit(0);
