import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pool from '../config/db.js';

/**
 * Bootstrap the current software's schema from latest_db.sql (schema-only pg_dump).
 * Safe to re-run: skips entirely if the users table already exists.
 * `npm run db:setup` follows this bootstrap with the accounting and SaaS
 * migrations, so a fresh database never starts with the legacy registry
 * cash-flow trigger from the schema dump.
 */
const setup = async () => {
  const { rows } = await pool.query(`SELECT to_regclass('public.users') AS t`);
  if (rows[0].t) {
    console.log('Schema already present (users table exists) — skipping latest_db.sql');
    return;
  }

  const sqlPath = path.join(process.cwd(), 'latest_db.sql');
  const raw = fs.readFileSync(sqlPath, 'utf8');
  // Strip psql meta-commands (\restrict, ...) node-pg can't run, and the dump's
  // search_path reset — it leaks through Neon's connection pooler and breaks
  // later unqualified queries. The dump fully qualifies everything anyway.
  const sql = raw
    .split('\n')
    .filter((line) => !line.startsWith('\\') && !line.includes("set_config('search_path'"))
    .join('\n');

  console.log('Creating schema from latest_db.sql ...');
  await pool.query(sql);
  console.log('Schema created.');
};

setup()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('DB setup failed:', err.message);
    process.exit(1);
  });
