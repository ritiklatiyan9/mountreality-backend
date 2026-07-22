import 'dotenv/config';
import pool from './src/config/db.js';

// Test what the frontend "Overall" date actually sends
const d = new Date(1, 0, 1);
d.setFullYear(1);
const startDate = d.toISOString().slice(0, 10);
console.log('Frontend "Overall" start date:', startDate);

try {
  // Test if PostgreSQL accepts this date
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM plot_payments WHERE site_id = $1 AND date >= $2 AND date < $3`,
    [5, startDate, '2026-12-31']
  );
  console.log('PostgreSQL result with date', startDate, ':', rows[0]);
} catch (err) {
  console.error('PostgreSQL ERROR with date', startDate, ':', err.message);
}

try {
  // Test with a normal date for comparison
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM plot_payments WHERE site_id = $1 AND date >= $2 AND date < $3`,
    [5, '2000-01-01', '2026-12-31']
  );
  console.log('PostgreSQL result with date 2000-01-01:', rows[0]);
} catch (err) {
  console.error('PostgreSQL ERROR with 2000-01-01:', err.message);
}

pool.end();
