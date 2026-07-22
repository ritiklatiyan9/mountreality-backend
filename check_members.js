import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const p = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD || ''),
  ssl: { rejectUnauthorized: false },
});

const r = await p.query(`SELECT column_name FROM information_schema.columns WHERE table_name='members' ORDER BY ordinal_position`);
console.log('Columns:', r.rows.map(x => x.column_name).join(', '));

const r2 = await p.query(`SELECT * FROM members LIMIT 5`);
console.log('Sample members:', JSON.stringify(r2.rows, null, 2));

await p.end();
