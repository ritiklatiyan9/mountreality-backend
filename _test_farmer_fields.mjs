import pool from './src/config/db.js';

// Test: update farmer 16 with land/commission fields directly
const r = await pool.query(
  `UPDATE farmers SET land_size_bigha = 5.5, land_rate = 50000, commission_percentage = 2.5, commission_amount = 6875 WHERE id = 16 RETURNING id, name, land_size_bigha, land_rate, commission_percentage, commission_amount`
);
console.log('Updated farmer:', r.rows[0]);

// Also verify we can read them back
const r2 = await pool.query(`SELECT id, name, land_size_bigha, land_rate, commission_percentage, commission_amount FROM farmers WHERE id = 16`);
console.log('Read back:', r2.rows[0]);

process.exit(0);
