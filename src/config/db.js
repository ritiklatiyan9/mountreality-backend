import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const sslOption = process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
  ? { rejectUnauthorized: false }
  : false;

const dbHost = process.env.DB_HOST;
const dbPort = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined;
const dbName = process.env.DB_NAME;
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : '';

const pool = new Pool({
  host: dbHost,
  port: dbPort,
  database: dbName,
  user: dbUser,
  password: dbPassword,
  ssl: sslOption,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Pin the schema per connection — pooled Neon backends can carry a stale
// search_path (e.g. after restoring a pg_dump that blanks it), and Neon's
// pooler rejects search_path as a startup parameter.
pool.on('connect', (client) => {
  client.query('SET search_path TO public').catch(() => {});
});

export const connectDB = async () => {
  try {
    const client = await pool.connect();
    console.log('Connected to PostgreSQL');
    client.release();
  } catch (err) {
    console.error('Database connection error', err);
    throw err;
  }
};

export default pool;