import pool from '../config/db.js';

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // === vendor_inventory_orders ===
    // One order = one purchase order from a vendor (e.g. 10,000 bricks ordered from Sharma Bricks)
    const { rows: orderRows } = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'vendor_inventory_orders'
      ) AS exists
    `);

    if (!orderRows[0].exists) {
      await client.query(`
        CREATE TABLE vendor_inventory_orders (
          id                  SERIAL PRIMARY KEY,
          site_id             INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          vendor_member_id    INTEGER REFERENCES members(id) ON DELETE SET NULL,
          vendor_name         VARCHAR(200) NOT NULL,
          item_name           VARCHAR(200) NOT NULL,
          item_category       VARCHAR(120),
          unit                VARCHAR(40)  NOT NULL DEFAULT 'pcs',
          qty_ordered         NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_ordered >= 0),
          qty_received        NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
          rate                NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (rate >= 0),
          discount_pct        NUMERIC(6,3)  NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
          discount_amount     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
          gross_amount        NUMERIC(14,2) GENERATED ALWAYS AS (ROUND(qty_received * rate, 2)) STORED,
          net_amount          NUMERIC(14,2) GENERATED ALWAYS AS (
                                ROUND(qty_received * rate
                                  - COALESCE(CASE
                                    WHEN discount_pct > 0 THEN ROUND(qty_received * rate * discount_pct / 100, 2)
                                    ELSE discount_amount
                                  END, 0), 2)
                              ) STORED,
          total_paid          NUMERIC(14,2) NOT NULL DEFAULT 0,
          order_date          DATE NOT NULL,
          expected_date       DATE,
          note                TEXT,
          status              VARCHAR(20) NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open', 'partial', 'completed', 'cancelled')),
          created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('Created vendor_inventory_orders');
    } else {
      console.log('vendor_inventory_orders already exists');
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vio_site_id ON vendor_inventory_orders(site_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vio_vendor_member_id ON vendor_inventory_orders(vendor_member_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vio_order_date ON vendor_inventory_orders(order_date DESC)
    `);

    // === vendor_inventory_deliveries ===
    // Each partial / full delivery against an order
    const { rows: delRows } = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'vendor_inventory_deliveries'
      ) AS exists
    `);

    if (!delRows[0].exists) {
      await client.query(`
        CREATE TABLE vendor_inventory_deliveries (
          id          SERIAL PRIMARY KEY,
          order_id    INTEGER NOT NULL REFERENCES vendor_inventory_orders(id) ON DELETE CASCADE,
          site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          delivery_date DATE NOT NULL,
          qty         NUMERIC(14,3) NOT NULL CHECK (qty > 0),
          note        TEXT,
          created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('Created vendor_inventory_deliveries');
    } else {
      console.log('vendor_inventory_deliveries already exists');
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vid_order_id ON vendor_inventory_deliveries(order_id)
    `);

    // === vendor_inventory_payments ===
    // Each payment made to vendor for this order
    const { rows: payRows } = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'vendor_inventory_payments'
      ) AS exists
    `);

    if (!payRows[0].exists) {
      await client.query(`
        CREATE TABLE vendor_inventory_payments (
          id            SERIAL PRIMARY KEY,
          order_id      INTEGER NOT NULL REFERENCES vendor_inventory_orders(id) ON DELETE CASCADE,
          site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          payment_date  DATE NOT NULL,
          amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
          payment_mode  VARCHAR(20) NOT NULL DEFAULT 'cash'
                          CHECK (payment_mode IN ('cash','bank','upi','cheque','neft','rtgs','imps','other')),
          reference_no  VARCHAR(120),
          cheque_no     VARCHAR(50),
          note          TEXT,
          voucher_url   TEXT,
          created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('Created vendor_inventory_payments');
    } else {
      console.log('vendor_inventory_payments already exists');
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vipay_order_id ON vendor_inventory_payments(order_id)
    `);

    // === Trigger to keep total_paid, qty_received and status in sync ===
    await client.query(`
      CREATE OR REPLACE FUNCTION sync_vendor_inventory_order()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE
        v_order_id INTEGER;
        v_paid     NUMERIC(14,2);
        v_rcvd     NUMERIC(14,3);
        v_ordered  NUMERIC(14,3);
        v_net      NUMERIC(14,2);
        v_status   VARCHAR(20);
      BEGIN
        -- determine order_id from whichever table fired
        IF TG_TABLE_NAME = 'vendor_inventory_payments' THEN
          v_order_id := COALESCE(NEW.order_id, OLD.order_id);
        ELSE
          v_order_id := COALESCE(NEW.order_id, OLD.order_id);
        END IF;

        SELECT COALESCE(SUM(amount), 0) INTO v_paid
        FROM vendor_inventory_payments WHERE order_id = v_order_id;

        SELECT COALESCE(SUM(qty), 0) INTO v_rcvd
        FROM vendor_inventory_deliveries WHERE order_id = v_order_id;

        SELECT qty_ordered INTO v_ordered
        FROM vendor_inventory_orders WHERE id = v_order_id;

        -- derive net_amount inline (mirrors generated column logic)
        SELECT ROUND(v_rcvd * rate
          - COALESCE(CASE WHEN discount_pct > 0 THEN ROUND(v_rcvd * rate * discount_pct / 100, 2)
                         ELSE discount_amount END, 0), 2)
        INTO v_net
        FROM vendor_inventory_orders WHERE id = v_order_id;

        -- status logic
        IF v_rcvd = 0 THEN
          v_status := 'open';
        ELSIF v_rcvd >= v_ordered THEN
          v_status := 'completed';
        ELSE
          v_status := 'partial';
        END IF;

        UPDATE vendor_inventory_orders
        SET total_paid   = v_paid,
            qty_received = v_rcvd,
            status       = v_status,
            updated_at   = CURRENT_TIMESTAMP
        WHERE id = v_order_id;

        RETURN NULL;
      END;
      $$
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_sync_inv_payment ON vendor_inventory_payments
    `);
    await client.query(`
      CREATE TRIGGER trg_sync_inv_payment
      AFTER INSERT OR UPDATE OR DELETE ON vendor_inventory_payments
      FOR EACH ROW EXECUTE FUNCTION sync_vendor_inventory_order()
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_sync_inv_delivery ON vendor_inventory_deliveries
    `);
    await client.query(`
      CREATE TRIGGER trg_sync_inv_delivery
      AFTER INSERT OR UPDATE OR DELETE ON vendor_inventory_deliveries
      FOR EACH ROW EXECUTE FUNCTION sync_vendor_inventory_order()
    `);

    console.log('Triggers for sync_vendor_inventory_order created/replaced');

    await client.query('COMMIT');
    console.log('Migration 043_vendor_inventory complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 043_vendor_inventory failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
