import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';

// Vendor inventory module — transactions-only (no deliveries / stock-in/out).
// An "order" is: item + qty_ordered * rate - discount = net value.
// Against that net value, each payment is a transaction that reduces outstanding.

const asInt = (v) => parseInt(v, 10);

const getSiteId = (req) => {
  const siteId = asInt(req.query.site_id || req.body.site_id);
  return Number.isInteger(siteId) && siteId > 0 ? siteId : null;
};

// Reusable SQL fragment computing order_value (net) and outstanding
const ORDER_VALUE_SQL = `ROUND(o.qty_ordered * o.rate
  - COALESCE(CASE
      WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2)
      ELSE o.discount_amount
    END, 0), 2)`;

// Payment state must always be derived from the monetary position. The stored
// status is retained for cancellation/audit purposes, but older deployments
// may still contain the former delivery-based state.
const ORDER_PAYMENT_STATUS_SQL = `CASE
  WHEN LOWER(COALESCE(o.status, '')) = 'cancelled' THEN 'cancelled'
  WHEN ${ORDER_VALUE_SQL} <= 0 OR COALESCE(o.total_paid, 0) <= 0 THEN 'open'
  WHEN COALESCE(o.total_paid, 0) >= ${ORDER_VALUE_SQL} THEN 'completed'
  ELSE 'partial'
END`;

// Qty already pulled into the inventory ledger against this order (the
// procurement → stock link). Receipts are tagged ref_type = 'VENDOR_ORDER'.
const RECEIVED_QTY_SQL = `COALESCE((
  SELECT SUM(mv.qty) FROM inventory_movements mv
   WHERE mv.ref_type = 'VENDOR_ORDER' AND mv.ref_id = o.id AND mv.movement_type = 'RECEIPT'
), 0)`;

export const listInventoryOrders = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim();
  const status = (req.query.status || '').trim();
  const vendorId = parseInt(req.query.vendor_id) || null;
  const category = (req.query.category || '').trim();

  const conditions = ['o.site_id = $1'];
  const values = [siteId];
  let idx = 2;

  if (search) {
    conditions.push(
      `(LOWER(o.item_name) LIKE $${idx} OR LOWER(o.vendor_name) LIKE $${idx} OR LOWER(o.item_category) LIKE $${idx})`
    );
    values.push(`%${search.toLowerCase()}%`);
    idx++;
  }
  if (status && status !== 'all') {
    conditions.push(`${ORDER_PAYMENT_STATUS_SQL} = $${idx}`);
    values.push(status);
    idx++;
  }
  if (vendorId) {
    conditions.push(`o.vendor_member_id = $${idx}`);
    values.push(vendorId);
    idx++;
  }
  if (category) {
    conditions.push(`LOWER(o.item_category) = $${idx}`);
    values.push(category.toLowerCase());
    idx++;
  }

  const where = conditions.join(' AND ');

  // Run count + paged list + global summary IN PARALLEL (was 3 serial round-trips).
  const countPromise = pool.query(
    `SELECT COUNT(*)::int AS total FROM vendor_inventory_orders o WHERE ${where}`,
    values
  );
  const ordersPromise = pool.query(
    `SELECT
       o.id, o.site_id, o.vendor_member_id, o.vendor_name,
       o.item_name, o.item_category, o.unit,
       o.qty_ordered, o.rate, o.discount_pct, o.discount_amount,
       o.total_paid, o.commitment_id,
       ${ORDER_VALUE_SQL} AS order_value,
       (${ORDER_VALUE_SQL} - o.total_paid) AS outstanding,
       ${RECEIVED_QTY_SQL} AS received_qty,
       (o.qty_ordered - ${RECEIVED_QTY_SQL}) AS pending_qty,
       o.order_date, o.expected_date, o.note,
       ${ORDER_PAYMENT_STATUS_SQL} AS payment_status,
       o.status AS stored_status, o.created_at,
       m.full_name AS vendor_member_name,
       m.photo AS vendor_member_photo,
       vc.head_name, vc.work_title
     FROM vendor_inventory_orders o
     LEFT JOIN members m ON m.id = o.vendor_member_id
     LEFT JOIN vendor_commitments vc ON vc.id = o.commitment_id
     WHERE ${where}
     ORDER BY o.order_date DESC, o.id DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset]
  );
  const sumPromise = pool.query(
    `SELECT
       COUNT(*)::int AS total_orders,
       COALESCE(SUM(ROUND(qty_ordered * rate
         - COALESCE(CASE
           WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
           ELSE discount_amount
         END, 0), 2)), 0)::numeric(14,2) AS total_value,
       COALESCE(SUM(total_paid), 0)::numeric(14,2) AS total_paid,
       COALESCE(SUM(ROUND(qty_ordered * rate
         - COALESCE(CASE
           WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
           ELSE discount_amount
         END, 0), 2) - total_paid), 0)::numeric(14,2) AS total_outstanding,
       COALESCE(SUM(CASE WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2) ELSE discount_amount END), 0)::numeric(14,2) AS total_discount
     FROM vendor_inventory_orders
     WHERE site_id = $1`,
    [siteId]
  );

  const [countRes, ordersRes, sumRes] = await Promise.all([countPromise, ordersPromise, sumPromise]);
  const total = countRes.rows[0]?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  res.json({
    orders: ordersRes.rows,
    pagination: { page, limit, total, totalPages },
    summary: sumRes.rows[0],
  });
});

export const getInventoryOrderDetail = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const orderId = asInt(req.params.id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(orderId)) return res.status(400).json({ message: 'Invalid order id' });

  const orderRes = await pool.query(
    `SELECT o.*,
       ${ORDER_VALUE_SQL} AS order_value,
       (${ORDER_VALUE_SQL} - o.total_paid) AS outstanding,
       ${ORDER_PAYMENT_STATUS_SQL} AS payment_status,
       ${RECEIVED_QTY_SQL} AS received_qty,
       (o.qty_ordered - ${RECEIVED_QTY_SQL}) AS pending_qty,
       m.full_name AS vendor_member_name,
       m.photo AS vendor_member_photo,
       vc.head_name, vc.work_title
     FROM vendor_inventory_orders o
     LEFT JOIN members m ON m.id = o.vendor_member_id
     LEFT JOIN vendor_commitments vc ON vc.id = o.commitment_id
     WHERE o.id = $1 AND o.site_id = $2`,
    [orderId, siteId]
  );
  const order = orderRes.rows[0];
  if (!order) return res.status(404).json({ message: 'Order not found' });

  const paymentsRes = await pool.query(
    `SELECT p.*, u.name AS created_by_name
     FROM vendor_inventory_payments p
     LEFT JOIN users u ON u.id = p.created_by
     WHERE p.order_id = $1
     ORDER BY p.payment_date DESC, p.id DESC`,
    [orderId]
  );

  res.json({ order, payments: paymentsRes.rows });
});

export const createInventoryOrder = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const {
    vendor_member_id,
    vendor_name,
    item_name,
    item_category,
    unit,
    qty_ordered,
    rate,
    discount_pct,
    discount_amount,
    order_date,
    expected_date,
    note,
    commitment_id,
  } = req.body;

  if (!(item_name || '').trim()) return res.status(400).json({ message: 'item_name is required' });
  if (!(unit || '').trim())      return res.status(400).json({ message: 'unit is required' });

  const qtyOrdered     = parseFloat(qty_ordered) || 0;
  const rateVal        = parseFloat(rate) || 0;
  const discountPct    = Math.min(100, Math.max(0, parseFloat(discount_pct) || 0));
  const discountAmount = Math.max(0, parseFloat(discount_amount) || 0);

  if (qtyOrdered <= 0) return res.status(400).json({ message: 'qty_ordered must be greater than 0' });
  if (rateVal < 0)     return res.status(400).json({ message: 'rate cannot be negative' });

  let vendorMemberId = vendor_member_id ? asInt(vendor_member_id) : null;
  let resolvedVendorName = (vendor_name || '').trim().toUpperCase();

  if (vendorMemberId) {
    const vRes = await pool.query(
      `SELECT full_name FROM members WHERE id = $1 AND site_id = $2 AND member_type = 'VENDOR'`,
      [vendorMemberId, siteId]
    );
    if (!vRes.rows[0]) return res.status(400).json({ message: 'Vendor not found for this site' });
    resolvedVendorName = vRes.rows[0].full_name;
  }
  if (!resolvedVendorName) return res.status(400).json({ message: 'vendor_name is required' });

  const commitmentIdVal = commitment_id ? asInt(commitment_id) : null;
  if (commitmentIdVal) {
    const commitment = await pool.query(
      'SELECT id FROM vendor_commitments WHERE id = $1 AND site_id = $2',
      [commitmentIdVal, siteId]
    );
    if (!commitment.rows[0]) return res.status(400).json({ message: 'Commitment not found for this site' });
  }

  const result = await pool.query(
    `INSERT INTO vendor_inventory_orders
       (site_id, vendor_member_id, vendor_name, item_name, item_category, unit,
        qty_ordered, rate, discount_pct, discount_amount, order_date, expected_date, note, created_by, commitment_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      siteId,
      vendorMemberId,
      resolvedVendorName,
      item_name.trim(),
      (item_category || '').trim().toUpperCase() || null,
      (unit || '').trim(),
      qtyOrdered,
      rateVal,
      discountPct,
      discountAmount,
      order_date || new Date().toISOString().slice(0, 10),
      expected_date || null,
      (note || '').trim() || null,
      req.user.id,
      commitmentIdVal,
    ]
  );

  res.status(201).json({ order: result.rows[0] });
});

export const updateInventoryOrder = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const orderId = asInt(req.params.id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(orderId)) return res.status(400).json({ message: 'Invalid order id' });

  const existing = await pool.query(
    `SELECT o.id,
            COALESCE((SELECT SUM(mv.qty) FROM inventory_movements mv
              WHERE mv.ref_type = 'VENDOR_ORDER' AND mv.ref_id = o.id AND mv.movement_type = 'RECEIPT'), 0) AS received_qty,
            COALESCE((SELECT SUM(p.amount) FROM vendor_inventory_payments p WHERE p.order_id = o.id), 0) AS paid_amount,
            o.status
       FROM vendor_inventory_orders o
      WHERE o.id = $1 AND o.site_id = $2`,
    [orderId, siteId]
  );
  if (!existing.rows[0]) return res.status(404).json({ message: 'Order not found' });

  const {
    item_name, item_category, unit,
    qty_ordered, rate, discount_pct, discount_amount,
    order_date, expected_date, note, status,
    vendor_name, vendor_member_id,
  } = req.body;

  const fields = [];
  const vals   = [];
  let p = 1;

  const setField = (col, val) => { fields.push(`${col} = $${p++}`); vals.push(val); };

  if (item_name !== undefined) {
    const nextName = String(item_name || '').trim();
    if (!nextName) return res.status(400).json({ message: 'item_name cannot be empty' });
    setField('item_name', nextName);
  }
  if (item_category !== undefined) setField('item_category', (item_category || '').trim().toUpperCase() || null);
  if (unit !== undefined) {
    const nextUnit = String(unit || '').trim();
    if (!nextUnit) return res.status(400).json({ message: 'unit cannot be empty' });
    setField('unit', nextUnit);
  }
  const lockedByTransactions = Number(existing.rows[0].received_qty) > 0 || Number(existing.rows[0].paid_amount) > 0;
  if (qty_ordered !== undefined) {
    const nextQty = parseFloat(qty_ordered);
    if (!Number.isFinite(nextQty) || nextQty <= 0) return res.status(400).json({ message: 'qty_ordered must be greater than 0' });
    if (nextQty < Number(existing.rows[0].received_qty)) return res.status(409).json({ message: 'Ordered quantity cannot be below the quantity already received' });
    if (lockedByTransactions) return res.status(409).json({ message: 'Quantity cannot be edited after receipt or payment has been recorded' });
    setField('qty_ordered', nextQty);
  }
  if (rate !== undefined) {
    const nextRate = parseFloat(rate);
    if (!Number.isFinite(nextRate) || nextRate < 0) return res.status(400).json({ message: 'rate cannot be negative' });
    if (lockedByTransactions) return res.status(409).json({ message: 'Rate cannot be edited after receipt or payment has been recorded' });
    setField('rate', nextRate);
  }
  if (discount_pct !== undefined) {
    if (lockedByTransactions) return res.status(409).json({ message: 'Discount cannot be edited after receipt or payment has been recorded' });
    setField('discount_pct', Math.min(100, Math.max(0, parseFloat(discount_pct) || 0)));
  }
  if (discount_amount !== undefined) {
    if (lockedByTransactions) return res.status(409).json({ message: 'Discount cannot be edited after receipt or payment has been recorded' });
    setField('discount_amount', Math.max(0, parseFloat(discount_amount) || 0));
  }
  if (order_date    !== undefined) setField('order_date',    order_date);
  if (expected_date !== undefined) setField('expected_date', expected_date || null);
  if (note          !== undefined) setField('note',          (note || '').trim() || null);
  if (status !== undefined) {
    const nextStatus = String(status).toLowerCase();
    if (nextStatus !== 'cancelled') return res.status(400).json({ message: 'Order status is derived from payments; only cancellation is user-controlled' });
    if (lockedByTransactions) return res.status(409).json({ message: 'An order with receipts or payments cannot be cancelled' });
    setField('status', nextStatus);
  }
  if (vendor_name !== undefined) {
    if (lockedByTransactions) return res.status(409).json({ message: 'Vendor cannot be changed after receipt or payment has been recorded' });
    setField('vendor_name', (vendor_name || '').trim().toUpperCase());
  }
  if (vendor_member_id !== undefined) {
    if (lockedByTransactions) return res.status(409).json({ message: 'Vendor cannot be changed after receipt or payment has been recorded' });
    const nextVendorId = vendor_member_id ? asInt(vendor_member_id) : null;
    if (nextVendorId) {
      const vendor = await pool.query('SELECT id FROM members WHERE id = $1 AND site_id = $2 AND member_type = \'VENDOR\'', [nextVendorId, siteId]);
      if (!vendor.rows[0]) return res.status(400).json({ message: 'Vendor not found for this site' });
    }
    setField('vendor_member_id', nextVendorId);
  }

  if (fields.length === 0) return res.status(400).json({ message: 'Nothing to update' });

  fields.push(`updated_at = CURRENT_TIMESTAMP`);
  vals.push(orderId, siteId);

  const result = await pool.query(
    `UPDATE vendor_inventory_orders SET ${fields.join(', ')}
     WHERE id = $${p} AND site_id = $${p + 1}
     RETURNING *`,
    vals
  );

  res.json({ order: result.rows[0] });
});

export const deleteInventoryOrder = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const orderId = asInt(req.params.id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(orderId)) return res.status(400).json({ message: 'Invalid order id' });

  const linked = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM inventory_movements WHERE ref_type = 'VENDOR_ORDER' AND ref_id = $1) AS has_receipts,
       EXISTS (SELECT 1 FROM vendor_inventory_payments WHERE order_id = $1) AS has_payments`,
    [orderId]
  );
  if (!linked.rows[0]) return res.status(404).json({ message: 'Order not found' });
  if (linked.rows[0].has_receipts || linked.rows[0].has_payments) {
    return res.status(409).json({ message: 'This order has receipts or payments and cannot be deleted. Cancel it or keep the audit trail.' });
  }
  const result = await pool.query(
    `DELETE FROM vendor_inventory_orders WHERE id = $1 AND site_id = $2 RETURNING id`,
    [orderId, siteId]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Order not found' });

  res.json({ message: 'Order deleted' });
});

export const addInventoryPayment = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const orderId = asInt(req.params.id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(orderId)) return res.status(400).json({ message: 'Invalid order id' });

  const amount = parseFloat(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'amount must be > 0' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderCheck = await client.query(
    `SELECT id, status,
            ROUND(qty_ordered * rate - COALESCE(CASE WHEN discount_pct > 0
              THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
              ELSE discount_amount END, 0), 2) AS order_value,
            COALESCE((SELECT SUM(amount) FROM vendor_inventory_payments WHERE order_id = $1), 0) AS paid_amount
       FROM vendor_inventory_orders WHERE id = $1 AND site_id = $2 FOR UPDATE`,
    [orderId, siteId]
    );
    const order = orderCheck.rows[0];
    if (!order) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Order not found' }); }
    if (order.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(409).json({ message: 'Cancelled orders cannot receive payments' }); }
    const outstanding = Number(order.order_value) - Number(order.paid_amount);
    if (amount > outstanding + 0.005) { await client.query('ROLLBACK'); return res.status(409).json({ message: `Payment exceeds the outstanding amount by ${Math.max(0, amount - outstanding).toFixed(2)}` }); }

    const { payment_date, payment_mode, reference_no, note, voucher_url } = req.body;
    const allowedModes = new Set(['cash', 'bank', 'upi', 'cheque', 'neft', 'rtgs', 'imps', 'other']);
    const mode = String(payment_mode || 'cash').toLowerCase();
    if (!allowedModes.has(mode)) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'Invalid payment mode' }); }

    const result = await client.query(
    `INSERT INTO vendor_inventory_payments
       (order_id, site_id, payment_date, amount, payment_mode, reference_no, cheque_no, note, voucher_url, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      orderId,
      siteId,
      payment_date || new Date().toISOString().slice(0, 10),
      amount,
      mode,
      (reference_no || '').trim() || null,
      mode === 'cheque' ? ((reference_no || '').trim() || null) : null,
      (note || '').trim() || null,
      (voucher_url || '').trim() || null,
      req.user.id,
    ]
    );
    await client.query('COMMIT');
    res.status(201).json({ payment: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export const deleteInventoryPayment = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const paymentId = asInt(req.params.paymentId);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(paymentId)) return res.status(400).json({ message: 'Invalid payment id' });

  const result = await pool.query(
    `DELETE FROM vendor_inventory_payments p
     USING vendor_inventory_orders o
     WHERE p.id = $1 AND p.order_id = o.id AND o.site_id = $2
     RETURNING p.id`,
    [paymentId, siteId]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Payment not found' });

  res.json({ message: 'Payment deleted' });
});

export const listInventoryCategories = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const result = await pool.query(
    `SELECT DISTINCT item_category
     FROM vendor_inventory_orders
     WHERE site_id = $1 AND item_category IS NOT NULL AND item_category <> ''
     ORDER BY item_category ASC`,
    [siteId]
  );

  res.json({ categories: result.rows.map((r) => r.item_category) });
});

// Per-category aggregated summary (no in/out — just item count, value, paid, outstanding)
export const getInventoryStockSummary = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  // 3 independent reads in parallel — was 3 serial round-trips.
  const catPromise = pool.query(
    `SELECT
       COALESCE(NULLIF(o.item_category, ''), 'UNCATEGORIZED') AS category,
       COUNT(*)::int AS item_count,
       COALESCE(SUM(ROUND(o.qty_ordered * o.rate
         - COALESCE(CASE
           WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2)
           ELSE o.discount_amount
         END, 0), 2)), 0)::numeric(14,2) AS total_value,
       COALESCE(SUM(o.total_paid), 0)::numeric(14,2) AS total_paid,
       COALESCE(SUM(ROUND(o.qty_ordered * o.rate
         - COALESCE(CASE
           WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2)
           ELSE o.discount_amount
         END, 0), 2) - o.total_paid), 0)::numeric(14,2) AS outstanding,
       COUNT(*) FILTER (WHERE ${ORDER_PAYMENT_STATUS_SQL} = 'open')::int AS open_count,
       COUNT(*) FILTER (WHERE ${ORDER_PAYMENT_STATUS_SQL} = 'partial')::int AS partial_count,
       COUNT(*) FILTER (WHERE ${ORDER_PAYMENT_STATUS_SQL} = 'completed')::int AS completed_count
     FROM vendor_inventory_orders o
     WHERE o.site_id = $1 AND ${ORDER_PAYMENT_STATUS_SQL} != 'cancelled'
     GROUP BY COALESCE(NULLIF(o.item_category, ''), 'UNCATEGORIZED')
     ORDER BY total_value DESC`,
    [siteId]
  );

  const recentTxPromise = pool.query(
    `SELECT p.id, p.payment_date AS date, p.amount, p.payment_mode,
            o.item_name, o.item_category, o.unit
     FROM vendor_inventory_payments p
     INNER JOIN vendor_inventory_orders o ON o.id = p.order_id
     WHERE p.site_id = $1
     ORDER BY p.payment_date DESC, p.id DESC
     LIMIT 10`,
    [siteId]
  );

  const totalPromise = pool.query(
    `SELECT
       COUNT(*)::int AS total_items,
       COALESCE(SUM(ROUND(qty_ordered * rate
         - COALESCE(CASE
           WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
           ELSE discount_amount
         END, 0), 2)), 0)::numeric(14,2) AS total_value,
       COALESCE(SUM(total_paid), 0)::numeric(14,2) AS total_paid,
       COALESCE(SUM(ROUND(qty_ordered * rate
         - COALESCE(CASE
           WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
           ELSE discount_amount
         END, 0), 2) - total_paid), 0)::numeric(14,2) AS total_outstanding
     FROM vendor_inventory_orders
     WHERE site_id = $1 AND status != 'cancelled'`,
    [siteId]
  );

  const [catRes, recentTxRes, totalRes] = await Promise.all([
    catPromise, recentTxPromise, totalPromise,
  ]);

  res.json({
    categories: catRes.rows,
    recentTransactions: recentTxRes.rows,
    totals: totalRes.rows[0],
  });
});
