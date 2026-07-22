import pool from './src/config/db.js';

// Delete broken TOKEN entries (₹0 with no data) from registry 3
const del = await pool.query(
  "DELETE FROM plot_registry_payments WHERE registry_id = 3 AND amount = 0 RETURNING id"
);
console.log('Deleted broken entries:', del.rows.map(r => r.id));

process.exit(0);
