import 'dotenv/config';
import pool from '../config/db.js';

// Repairs the legacy delivery-based procurement status trigger and reconciles
// payment allocations with the approved vendor-payment ledger. Inventory
// allocations are not a second cash outflow; the linked vendor payment remains
// the sole dashboard/cash-flow source.
const MIGRATION_KEY = '097_procurement_payment_integrity_v1';

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.app_schema_migrations (
        version VARCHAR(160) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = await client.query(
      'SELECT 1 FROM public.app_schema_migrations WHERE version = $1',
      [MIGRATION_KEY],
    );
    if (applied.rowCount > 0) {
      await client.query('COMMIT');
      console.log(`Migration ${MIGRATION_KEY} already applied — skipping`);
      return;
    }

    await client.query(`
      CREATE OR REPLACE FUNCTION public.sync_vendor_inventory_order()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_order_id INTEGER;
        v_paid NUMERIC(14,2);
        v_value NUMERIC(14,2);
        v_status VARCHAR(20);
      BEGIN
        v_order_id := COALESCE(NEW.order_id, OLD.order_id);

        SELECT COALESCE(SUM(amount), 0) INTO v_paid
        FROM vendor_inventory_payments
        WHERE order_id = v_order_id;

        SELECT ROUND(qty_ordered * rate - COALESCE(CASE
          WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
          ELSE discount_amount
        END, 0), 2)
        INTO v_value
        FROM vendor_inventory_orders
        WHERE id = v_order_id;

        IF v_value IS NULL OR v_value <= 0 OR v_paid <= 0 THEN
          v_status := 'open';
        ELSIF v_paid >= v_value THEN
          v_status := 'completed';
        ELSE
          v_status := 'partial';
        END IF;

        UPDATE vendor_inventory_orders
           SET total_paid = v_paid,
               status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE v_status END,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = v_order_id;

        RETURN NULL;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_sync_inv_payment ON vendor_inventory_payments');
    await client.query(`
      CREATE TRIGGER trg_sync_inv_payment
      AFTER INSERT OR UPDATE OR DELETE ON vendor_inventory_payments
      FOR EACH ROW EXECUTE FUNCTION public.sync_vendor_inventory_order()
    `);

    // Recalculate every persisted order once so the register is correct as
    // soon as the migration completes, including old fully-paid rows.
    await client.query(`
      UPDATE vendor_inventory_orders o
         SET total_paid = paid.total_paid,
             status = CASE
               WHEN o.status = 'cancelled' THEN 'cancelled'
               WHEN paid.total_paid <= 0 THEN 'open'
               WHEN paid.total_paid >= ROUND(o.qty_ordered * o.rate - COALESCE(CASE
                 WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2)
                 ELSE o.discount_amount
               END, 0), 2) THEN 'completed'
               ELSE 'partial'
             END,
             updated_at = CURRENT_TIMESTAMP
        FROM LATERAL (
          SELECT COALESCE(SUM(p.amount), 0)::numeric(14,2) AS total_paid
            FROM vendor_inventory_payments p
           WHERE p.order_id = o.id
        ) paid
    `);

    // A recorded non-cheque vendor payment that was allocated to its linked
    // procurement lines is a settled payment, not an approval request. Promote
    // only this unambiguous historical shape; unrelated legacy pending rows are
    // intentionally left for the existing approval workflow.
    await client.query(`
      WITH allocated AS (
        SELECT o.commitment_id,
               p.site_id,
               p.payment_date,
               LOWER(COALESCE(p.payment_mode, 'cash')) AS payment_mode,
               COALESCE(SUM(p.amount), 0)::numeric(14,2) AS allocated_amount
          FROM vendor_inventory_payments p
          JOIN vendor_inventory_orders o ON o.id = p.order_id
         WHERE o.commitment_id IS NOT NULL
         GROUP BY o.commitment_id, p.site_id, p.payment_date, LOWER(COALESCE(p.payment_mode, 'cash'))
      )
      UPDATE vendor_payments vp
         SET status = 'approved',
             approved_by = COALESCE(vp.approved_by, vp.created_by),
             approved_at = COALESCE(vp.approved_at, NOW())
        FROM allocated a
       WHERE vp.commitment_id = a.commitment_id
         AND vp.site_id = a.site_id
         AND vp.payment_date = a.payment_date
         AND LOWER(COALESCE(vp.payment_mode, 'cash')) = a.payment_mode
         AND LOWER(COALESCE(vp.payment_mode, 'cash')) <> 'cheque'
         AND LOWER(COALESCE(vp.status, 'pending')) = 'pending'
         AND ABS(COALESCE(vp.amount, 0) - a.allocated_amount) <= 0.01
    `);

    // Existing vendor-payment cash-flow triggers upsert the canonical ledger
    // row when touched. Replaying approved records includes newly reconciled
    // payments without creating a duplicate procurement allocation entry.
    await client.query(`
      UPDATE vendor_payments
         SET status = status
       WHERE LOWER(COALESCE(status, '')) = 'approved'
    `);

    await client.query(
      'INSERT INTO public.app_schema_migrations (version) VALUES ($1)',
      [MIGRATION_KEY],
    );
    await client.query('COMMIT');
    console.log('Migration 097_procurement_payment_integrity complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 097_procurement_payment_integrity failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
