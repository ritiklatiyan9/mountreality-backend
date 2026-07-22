/**
 * Self-check for the vendor-order → inventory-ledger receive path.
 * Runs the controller against the real DB inside a transaction that is always
 * rolled back:  node test_receive_vendor_order.mjs
 */
import assert from 'node:assert';
import 'dotenv/config';
import pool from './src/config/db.js';
import { receiveVendorOrder } from './src/controllers/inventory.controller.js';
import { inventoryModel } from './src/models/Inventory.model.js';

// Fake req/res so the controller can be called directly.
const call = (orderId, body, userId) => new Promise((resolve) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(payload) { resolve({ status: this.statusCode, body: payload }); },
  };
  receiveVendorOrder({ params: { orderId: String(orderId) }, query: {}, body, user: { id: userId } }, res, (e) => { throw e; });
});

const run = async () => {
  const { rows: [site] } = await pool.query('SELECT id FROM sites ORDER BY id LIMIT 1');
  const { rows: [user] } = await pool.query('SELECT id FROM users ORDER BY id LIMIT 1');
  assert(site && user, 'need at least one site and one user in the DB');

  const itemName = `ZZ TEST MATERIAL ${Date.now()}`;
  const { rows: [order] } = await pool.query(
    `INSERT INTO vendor_inventory_orders
       (site_id, vendor_name, item_name, item_category, unit, qty_ordered, rate, order_date, created_by)
     VALUES ($1,'ZZ TEST VENDOR',$2,'TEST','BAG',100,50,CURRENT_DATE,$3) RETURNING id`,
    [site.id, itemName, user.id]
  );

  try {
    // 1. Partial receive creates the material and the RECEIPT movement.
    const first = await call(order.id, { site_id: site.id, qty: 60 }, user.id);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const materialId = first.body.material_id;
    assert.equal(Number(first.body.pending_qty), 40);
    assert.equal((await inventoryModel.stockFor(materialId)).on_hand, 60);

    // 2. Over-receiving the remainder is rejected.
    const over = await call(order.id, { site_id: site.id, qty: 41 }, user.id);
    assert.equal(over.status, 400, 'over-receive must be rejected');
    assert.equal((await inventoryModel.stockFor(materialId)).on_hand, 60, 'rejected receive must not touch stock');

    // 3. Second material lookup reuses the same material, order closes out.
    const second = await call(order.id, { site_id: site.id, qty: 40 }, user.id);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.material_id, materialId, 'must reuse the matched material');
    assert.equal(Number(second.body.pending_qty), 0);
    assert.equal((await inventoryModel.stockFor(materialId)).on_hand, 100);

    // 4. Wrong site is a 404.
    const wrongSite = await call(order.id, { site_id: site.id + 999999, qty: 1 }, user.id);
    assert.equal(wrongSite.status, 404);

    console.log('✓ receive-vendor-order checks passed');
  } finally {
    await pool.query(`DELETE FROM inventory_movements WHERE ref_type = 'VENDOR_ORDER' AND ref_id = $1`, [order.id]);
    await pool.query('DELETE FROM inventory_materials WHERE site_id = $1 AND name = $2', [site.id, itemName.toUpperCase()]);
    await pool.query('DELETE FROM vendor_inventory_orders WHERE id = $1', [order.id]);
    await pool.end();
  }
};

run().catch((e) => { console.error(e); process.exit(1); });
