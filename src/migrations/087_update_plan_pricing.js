import pool from '../config/db.js';

/**
 * Updates the seeded plan pricing/names to the real published rates.
 * 'growth' is renamed to 'professional' (display name "Professional") —
 * the only two other references to the old code are the ON CONFLICT seed
 * in migration 079 (harmless once renamed) and PlanCards.jsx's highlight
 * check (updated alongside this migration).
 * Enterprise's site_limit uses a very large sentinel to mean "Unlimited"
 * (the plans table has no separate unlimited flag) — PlanCards.jsx renders
 * that sentinel as "Unlimited" instead of the raw number.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`UPDATE plans SET price_inr = 4999 WHERE code = 'starter'`);
    await client.query(`
      UPDATE plans
         SET code = 'professional', name = 'Professional', price_inr = 9499, site_limit = 10
       WHERE code = 'growth'
    `);
    await client.query(`UPDATE plans SET price_inr = 14999, site_limit = 999999 WHERE code = 'enterprise'`);

    await client.query('COMMIT');
    console.log('✅ Migration 087: Updated plan pricing (Starter ₹4,999 / Professional ₹9,499 / Enterprise ₹14,999)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 087 failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
