import pool from '../config/db.js';

// Safety-only migration for the existing vendor/inventory model. It does not
// create a second ledger or change legacy records; it adds the indexes and
// write-time constraints needed by the existing append-only workflow.
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_inventory_movements_order_receipt
        ON inventory_movements(ref_type, ref_id, movement_type)
        WHERE ref_type = 'VENDOR_ORDER'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_inventory_movements_site_material_created
        ON inventory_movements(site_id, material_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_inventory_orders_site_status_expected
        ON vendor_inventory_orders(site_id, status, expected_date)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_inventory_payments_site_order
        ON vendor_inventory_payments(site_id, order_id, payment_date DESC)
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'inventory_movements_qty_nonzero'
        ) THEN
          ALTER TABLE inventory_movements
            ADD CONSTRAINT inventory_movements_qty_nonzero CHECK (qty <> 0) NOT VALID;
        END IF;
      END $$
    `);
    await client.query('COMMIT');
    console.log('Migration 093_vendor_inventory_robustness complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 093_vendor_inventory_robustness failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
