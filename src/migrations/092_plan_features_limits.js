import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Adds owner-editable feature lists and user limits to plans, and an
 * is_active flag so the owner can retire a plan without deleting it (its id
 * is FK-referenced by subscriptions.plan_id). Backfills the 3 existing plans
 * with the feature list that used to be hardcoded in PlanCards.jsx so the
 * public pricing page doesn't regress.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      ALTER TABLE plans
        ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '[]',
        ADD COLUMN IF NOT EXISTS max_users INTEGER,
        ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true
    `);
    // Backfill any plan still on the just-added default (empty features) — not just the
    // 3 codes migration 087 expected. Some deployments still carry a stray extra plan
    // row (e.g. a leftover 'growth' code from before 087 renamed it), and those need the
    // same baseline feature list so the pricing page doesn't show an empty card for them.
    await client.query(`
      UPDATE plans SET
        features = '["Dashboard & reports","Plot management","Farmer payments","Registry management","Expense management","Inventory & construction","Unlimited storage"]'::jsonb,
        max_users = CASE code WHEN 'starter' THEN 500 ELSE max_users END
      WHERE features = '[]'::jsonb
    `);
    await client.query('COMMIT');
    console.log('✅ Migration 092: plans.features / plans.max_users / plans.is_active added and backfilled');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 092 failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
