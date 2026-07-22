import pool from '../config/db.js';

// Adds the composite + filtered indexes that speed up the Vendor module:
//   - (site_id, status), (site_id, head_id) and (site_id, created_at DESC)
//     accelerate the filtered + paginated commitment list.
//   - (commitment_id, cheque_status) covers the paid-amount aggregation
//     that filters out BOUNCED/RETURNED cheques.
//   - (site_id, status, order_date DESC) covers the inventory list filter
//     + sort, and (site_id, item_category) accelerates category filtering.
//   - (site_id, payment_date DESC) on vendor_inventory_payments covers
//     the recent-transactions panel.
//
// All indexes use IF NOT EXISTS so the migration is idempotent.
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── vendor_commitments ────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vc_site_status
        ON vendor_commitments(site_id, status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vc_site_head
        ON vendor_commitments(site_id, head_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vc_site_created_at
        ON vendor_commitments(site_id, created_at DESC)
    `);

    // ── vendor_payments ───────────────────────────────────────
    // Aggregations filter out BOUNCED/RETURNED cheques. A partial index
    // limited to "active" payments keeps the working set small.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vp_commitment_active
        ON vendor_payments(commitment_id)
        WHERE cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vp_site_date
        ON vendor_payments(site_id, payment_date DESC)
    `);

    // ── vendor_inventory_orders ───────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vio_site_status_date
        ON vendor_inventory_orders(site_id, status, order_date DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vio_site_category
        ON vendor_inventory_orders(site_id, LOWER(item_category))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vio_commitment_site
        ON vendor_inventory_orders(commitment_id, site_id)
    `);

    // ── vendor_inventory_payments ─────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vipay_site_date
        ON vendor_inventory_payments(site_id, payment_date DESC)
    `);

    await client.query('COMMIT');
    console.log('Migration 050_vendor_performance_indexes complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 050_vendor_performance_indexes failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
