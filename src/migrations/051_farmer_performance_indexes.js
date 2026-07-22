import pool from '../config/db.js';

// Adds composite + filtered indexes that speed up the Farmer Payment module:
//   - (site_id, status), (site_id, created_at DESC) accelerate the list page.
//   - (farmer_id, cheque_status) — partial index over only "active" payments
//     covers the SUM aggregations that filter out BOUNCED/RETURNED cheques.
//   - (farmer_id, date) covers the payment-detail listing ordered by date.
//   - day_book(farmer_payment_id) covers the cascade-delete in deletePayment.
//
// All indexes use IF NOT EXISTS so the migration is idempotent.
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── farmers ───────────────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_farmers_site_status
        ON farmers(site_id, status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_farmers_site_created_at
        ON farmers(site_id, created_at DESC)
    `);

    // ── farmer_payments ───────────────────────────────────────
    // Partial index limited to "active" payments — used by every aggregation
    // that filters out BOUNCED/RETURNED cheques.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_farmer_payments_active
        ON farmer_payments(farmer_id)
        WHERE cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_farmer_payments_farmer_date
        ON farmer_payments(farmer_id, date)
    `);

    // ── day_book ──────────────────────────────────────────────
    // Speeds up the cascade-delete in deletePayment.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_day_book_farmer_payment_id
        ON day_book(farmer_payment_id)
        WHERE farmer_payment_id IS NOT NULL
    `);

    await client.query('COMMIT');
    console.log('Migration 051_farmer_performance_indexes complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 051_farmer_performance_indexes failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
