import pool from '../config/db.js';

// Retires the deliveries / stock-IN concept for vendor inventory.
// After this migration an order is a simple "ordered amount" tracked by payments only.
//   - Drops delivery-based triggers/tables
//   - Rewrites the trigger to derive `status` from payment progress on the order value
//     (qty_ordered * rate − discount), NOT from qty_received
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`DROP TRIGGER IF EXISTS trg_sync_inv_delivery ON vendor_inventory_deliveries`);
    await client.query(`DROP TRIGGER IF EXISTS trg_sync_inv_payment ON vendor_inventory_payments`);

    await client.query(`DROP TABLE IF EXISTS vendor_inventory_deliveries CASCADE`);

    // Rewrite trigger: status = completed when fully paid, partial when any paid, open otherwise.
    await client.query(`
      CREATE OR REPLACE FUNCTION sync_vendor_inventory_order()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_order_id INTEGER;
        v_paid     NUMERIC(14,2);
        v_value    NUMERIC(14,2);
        v_status   VARCHAR(20);
      BEGIN
        v_order_id := COALESCE(NEW.order_id, OLD.order_id);

        SELECT COALESCE(SUM(amount), 0) INTO v_paid
        FROM vendor_inventory_payments WHERE order_id = v_order_id;

        SELECT ROUND(qty_ordered * rate
          - COALESCE(CASE WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
                         ELSE discount_amount END, 0), 2)
        INTO v_value
        FROM vendor_inventory_orders WHERE id = v_order_id;

        IF v_value IS NULL OR v_value <= 0 THEN
          v_status := 'open';
        ELSIF v_paid <= 0 THEN
          v_status := 'open';
        ELSIF v_paid >= v_value THEN
          v_status := 'completed';
        ELSE
          v_status := 'partial';
        END IF;

        UPDATE vendor_inventory_orders
        SET total_paid = v_paid,
            status     = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE v_status END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = v_order_id;

        RETURN NULL;
      END;
      $$
    `);

    await client.query(`
      CREATE TRIGGER trg_sync_inv_payment
      AFTER INSERT OR UPDATE OR DELETE ON vendor_inventory_payments
      FOR EACH ROW EXECUTE FUNCTION sync_vendor_inventory_order()
    `);

    // Backfill statuses on existing rows
    await client.query(`
      UPDATE vendor_inventory_orders vo
      SET status = CASE
        WHEN vo.status = 'cancelled' THEN 'cancelled'
        WHEN paid.total_paid IS NULL OR paid.total_paid <= 0 THEN 'open'
        WHEN paid.total_paid >= ROUND(vo.qty_ordered * vo.rate
               - COALESCE(CASE WHEN vo.discount_pct > 0 THEN ROUND(vo.qty_ordered * vo.rate * vo.discount_pct / 100, 2)
                              ELSE vo.discount_amount END, 0), 2) THEN 'completed'
        ELSE 'partial'
      END,
          total_paid = COALESCE(paid.total_paid, 0)
      FROM (
        SELECT order_id, SUM(amount) AS total_paid
        FROM vendor_inventory_payments
        GROUP BY order_id
      ) paid
      WHERE paid.order_id = vo.id
    `);

    await client.query('COMMIT');
    console.log('Migration 047_vendor_inventory_transactions_only complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 047_vendor_inventory_transactions_only failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
