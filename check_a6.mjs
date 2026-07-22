import 'dotenv/config';
import pg from 'pg';

const sslOption = process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
  ? { rejectUnauthorized: false }
  : false;

const pool = new pg.Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: sslOption
});

// Check existing imprest daybook entries
const r1 = await pool.query(`
  SELECT id, site_id, date, particular, entry_type, debit, credit, imprest_allocation_id
  FROM day_book
  WHERE entry_type = 'IMPREST' OR particular ILIKE '%IMPREST%'
  ORDER BY date DESC, id DESC
`);
console.log('=== IMPREST daybook entries ===');
console.table(r1.rows);

// Check imprest_ledger entries
const r2 = await pool.query(`
  SELECT il.id, il.user_id, u.name as user_name, il.type, il.amount, il.balance_after,
    il.remarks, il.site_id, il.created_at::date as date
  FROM imprest_ledger il
  JOIN users u ON il.user_id = u.id
  ORDER BY il.created_at DESC
`);
console.log('=== IMPREST LEDGER entries ===');
console.table(r2.rows);

await pool.end();
