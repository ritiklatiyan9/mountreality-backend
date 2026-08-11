import 'dotenv/config';
import pool from '../config/db.js';
import { hashPassword } from '../config/jwt.js';

/**
 * SaaS multi-tenancy:
 *  - organizations (tenants), plans, subscriptions (Razorpay one-order-per-month)
 *  - organization_id on users + sites (every other table is already site-scoped)
 *  - backfills all pre-SaaS rows into a "Default Organization" with a long-lived
 *    subscription so the existing deployment keeps working untouched
 *  - optionally bootstraps a platform owner from explicit deployment secrets
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        price_inr INTEGER NOT NULL,
        site_limit INTEGER NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      INSERT INTO plans (code, name, price_inr, site_limit) VALUES
        ('starter',    'Starter',    5999,  1),
        ('growth',     'Growth',     9994,  10),
        ('enterprise', 'Enterprise', 18499, 100)
      ON CONFLICT (code) DO UPDATE
        SET name = EXCLUDED.name, price_inr = EXCLUDED.price_inr, site_limit = EXCLUDED.site_limit
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        plan_id INTEGER NOT NULL REFERENCES plans(id),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        razorpay_order_id VARCHAR(100),
        razorpay_payment_id VARCHAR(100),
        amount_inr INTEGER,
        billing_cycle VARCHAR(10) NOT NULL DEFAULT 'monthly',
        current_period_start TIMESTAMP,
        current_period_end TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    // This migration runs at startup as well, so keep existing deployments in
    // sync without requiring a one-off billing migration.
    await client.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(10) NOT NULL DEFAULT 'monthly'`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_org_active
        ON subscriptions (organization_id, status, current_period_end)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_order
        ON subscriptions (razorpay_order_id) WHERE razorpay_order_id IS NOT NULL
    `);

    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id)`);
    await client.query(`ALTER TABLE sites ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_org ON users (organization_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sites_org ON sites (organization_id)`);

    // Site codes were globally unique — different companies must be able to reuse a code.
    await client.query(`ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_code_key`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_org_code
        ON sites (organization_id, code) WHERE code IS NOT NULL
    `);

    // latest_db.sql constrains users.role to super_admin/admin/sub_admin/agent — add 'owner'.
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    await client.query(`
      ALTER TABLE users ADD CONSTRAINT users_role_check
        CHECK (role IN ('owner', 'super_admin', 'admin', 'sub_admin', 'agent'))
    `);

    // ── Backfill: adopt all pre-SaaS users + sites into a default organization ──
    const { rows: orphanUsers } = await client.query(
      `SELECT 1 FROM users WHERE organization_id IS NULL AND role <> 'owner' LIMIT 1`
    );
    const { rows: orphanSites } = await client.query(`SELECT 1 FROM sites WHERE organization_id IS NULL LIMIT 1`);
    if (orphanUsers.length || orphanSites.length) {
      const { rows: existingOrg } = await client.query(
        `SELECT id FROM organizations WHERE name = 'Default Organization' LIMIT 1`
      );
      const orgId = existingOrg[0]?.id
        ?? (await client.query(`INSERT INTO organizations (name) VALUES ('Default Organization') RETURNING id`)).rows[0].id;

      await client.query(`UPDATE users SET organization_id = $1 WHERE organization_id IS NULL AND role <> 'owner'`, [orgId]);
      await client.query(`UPDATE sites SET organization_id = $1 WHERE organization_id IS NULL`, [orgId]);

      // Grandfathered: 10-year enterprise subscription so the existing company is never locked out.
      const { rows: activeSub } = await client.query(
        `SELECT 1 FROM subscriptions WHERE organization_id = $1 AND status = 'active' LIMIT 1`, [orgId]
      );
      if (!activeSub.length) {
        await client.query(
          `INSERT INTO subscriptions (organization_id, plan_id, status, current_period_start, current_period_end)
           SELECT $1, id, 'active', NOW(), NOW() + INTERVAL '10 years' FROM plans WHERE code = 'enterprise'`,
          [orgId]
        );
      }
    }

    // ── Secure platform-owner bootstrap ──
    // Never create or promote an account from source-controlled credentials.
    // The legacy public account is disabled even if this migration ran before;
    // its sessions are revoked through token_version as part of the same write.
    await client.query(
      `UPDATE users
          SET is_active = false,
              token_version = COALESCE(token_version, 0) + 1,
              refresh_token = NULL
        WHERE lower(email) = 'owner@gmail.com' AND role = 'owner' AND is_active = true`,
    );

    const ownerEmail = String(process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
    const ownerPassword = String(process.env.PLATFORM_OWNER_PASSWORD || '');
    if ((ownerEmail && !ownerPassword) || (!ownerEmail && ownerPassword)) {
      throw new Error('PLATFORM_OWNER_EMAIL and PLATFORM_OWNER_PASSWORD must be configured together');
    }
    if (ownerEmail) {
      if (ownerEmail === 'owner@gmail.com') {
        throw new Error('PLATFORM_OWNER_EMAIL must not use the revoked legacy owner address');
      }
      if (ownerPassword.length < 16 || !/[a-z]/.test(ownerPassword) || !/[A-Z]/.test(ownerPassword)
        || !/\d/.test(ownerPassword) || !/[^A-Za-z0-9]/.test(ownerPassword)) {
        throw new Error('PLATFORM_OWNER_PASSWORD must be 16+ characters with upper, lower, number and symbol');
      }

      const { rows: existing } = await client.query(
        'SELECT id, role FROM users WHERE lower(email) = $1 LIMIT 1',
        [ownerEmail],
      );
      if (existing[0] && existing[0].role !== 'owner') {
        throw new Error('Refusing to promote an existing tenant user to platform owner');
      }
      if (!existing[0]) {
        const hashed = await hashPassword(ownerPassword);
        await client.query(
          `INSERT INTO users (name, email, password, role, organization_id, is_active, token_version)
           VALUES ('Platform Owner', $1, $2, 'owner', NULL, true, 1)`,
          [ownerEmail, hashed],
        );
      }
    }

    const { rows: activeOwners } = await client.query(
      `SELECT 1 FROM users WHERE role = 'owner' AND is_active = true LIMIT 1`,
    );
    if (!activeOwners.length && process.env.NODE_ENV === 'production') {
      throw new Error('No active platform owner. Configure a unique PLATFORM_OWNER_EMAIL and strong PLATFORM_OWNER_PASSWORD once');
    }

    await client.query('COMMIT');
    console.log('Migration 079_saas_multitenancy complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 079_saas_multitenancy failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
