import 'dotenv/config';
import pool from '../config/db.js';
import { generateUniqueSubdomain } from '../utils/subdomain.js';

/**
 * Tenant subdomains:
 *  - organizations.subdomain — the {slug}.mountreality.com label. Unique
 *    case-insensitively: hostnames are case-insensitive, so two rows that
 *    differ only in case would be the same live domain.
 *  - users.domain_intro_seen — whether the first-login "your workspace
 *    domain" modal has been dismissed. On users, not organizations,
 *    because every member of a tenant gets the intro once, not only the
 *    person who signed the company up.
 *  - backfills every existing organization so the feature is live for
 *    current tenants, not only new signups.
 *
 * Idempotent — safe under the start:with-migrations flow.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subdomain VARCHAR(63)`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_subdomain
        ON organizations (LOWER(subdomain)) WHERE subdomain IS NOT NULL
    `);

    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS domain_intro_seen BOOLEAN NOT NULL DEFAULT false`);

    // Existing users have logged in plenty of times — a "welcome" modal on
    // their next session would read as a bug, so only NEW users get it.
    // Existing tenants still get their subdomain via the backfill below;
    // they discover it in Settings rather than by interruption.
    await client.query(`UPDATE users SET domain_intro_seen = true WHERE created_at < NOW()`);

    const { rows: unassigned } = await client.query(
      `SELECT id, name FROM organizations WHERE subdomain IS NULL ORDER BY id`
    );
    for (const org of unassigned) {
      const subdomain = await generateUniqueSubdomain(client, org.name);
      await client.query(
        `UPDATE organizations SET subdomain = $1, updated_at = NOW() WHERE id = $2`,
        [subdomain, org.id]
      );
      console.log(`  org ${org.id} "${org.name}" → ${subdomain}`);
    }

    await client.query('COMMIT');
    console.log(`090_org_subdomain: done (${unassigned.length} backfilled)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('090_org_subdomain failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
};

migrate();
