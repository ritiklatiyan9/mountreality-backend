import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;
const SCHEMA_READY = Symbol('public-schema-ready');

class PublicSchemaPool extends Pool {
  connect(callback) {
    if (typeof callback === 'function') {
      return super.connect((error, client, release) => {
        if (error) return callback(error);
        if (client[SCHEMA_READY]) return callback(null, client, release);
        return client.query('SET search_path TO public')
          .then(() => {
            client[SCHEMA_READY] = true;
            return callback(null, client, release);
          })
          .catch((schemaError) => {
            release(schemaError);
            return callback(schemaError);
          });
      });
    }
    return super.connect().then(async (client) => {
      if (client[SCHEMA_READY]) return client;
      try {
        await client.query('SET search_path TO public');
        client[SCHEMA_READY] = true;
        return client;
      } catch (error) {
        client.release(error);
        throw error;
      }
    });
  }
}

const sslOption = process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
  ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
  : false;

const dbHost = process.env.DB_HOST;
const dbPort = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined;
const dbName = process.env.DB_NAME;
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : '';
const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const pool = new PublicSchemaPool({
  host: dbHost,
  port: dbPort,
  database: dbName,
  user: dbUser,
  password: dbPassword,
  ssl: sslOption,
  max: positiveInteger(process.env.DB_POOL_MAX, 20),
  min: Math.min(positiveInteger(process.env.DB_POOL_MIN, 2), positiveInteger(process.env.DB_POOL_MAX, 20)),
  idleTimeoutMillis: positiveInteger(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30000),
  connectionTimeoutMillis: positiveInteger(process.env.DB_CONNECT_TIMEOUT_MS, 10000),
  maxUses: positiveInteger(process.env.DB_POOL_MAX_USES, 7500),
  application_name: process.env.DB_APPLICATION_NAME || 'accounts-api',
});

// PublicSchemaPool completes the SET before a newly-created client is handed
// to pool.query()/pool.connect(). This avoids racing the first application
// query on that socket while retaining compatibility with Neon poolers, which
// reject search_path as a startup parameter.

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
